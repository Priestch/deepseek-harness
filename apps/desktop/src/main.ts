/**
 * Electron main process for the DeepSeek Harness desktop client.
 *
 * Strategy: spawn the built `dsh web --port 0` host as a child process on a
 * loopback (127.0.0.1) port, read the port from the host's stdout URL line, and
 * load `http://127.0.0.1:<port>` in a BrowserWindow. The shipped HTTP + WebSocket
 * transport is reused unchanged; React and every client package are untouched.
 *
 * Loopback is the host's trusted default, so no trust or credential config is
 * needed for the carrier. The renderer loads a normal http origin with default
 * security (no nodeIntegration, no preload) — it is the web app itself.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolveHostBin, resolveNodeBinary } from './main-launcher'
import { app, BrowserWindow, Menu } from 'electron'

/** Regex extracting the loopback URL the host prints: `dsh web: http://127.0.0.1:<port>`. */
const URL_LINE = /http:\/\/127\.0\.0\.1:(\d+)/
/** Fail loud if the host has not printed its URL within this many milliseconds. */
const BOOT_TIMEOUT_MS = 30_000

let host: ChildProcess | undefined
let mainWindow: BrowserWindow | undefined

/** Create a logger that writes to a tmp file and console. */
function createLogger(logFile: string) {
  return (msg: string) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('fs').appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`)
    } catch (_fsErr) { /* log-write failures are intentionally discarded to keep the logger non-throwing */ }
    console.log(msg)
  }
}

/** Boot the host child and resolve to its loopback origin, or reject on timeout/error. */
function bootHost(): Promise<string> {
  const logFile = `/tmp/dsh-desktop-${Date.now()}.log`
  const log = createLogger(logFile)

  log('[boot] bootHost called')

  let binPath: string
  let nodePath: string
  let env: Record<string, string>

  try {
    log('[boot] calling resolveHostBin()')
    binPath = resolveHostBin()
    log(`[boot] binPath=${binPath}`)
  } catch (error) {
    log(`[boot] resolveHostBin failed: ${(error as Error).message}`)
    return Promise.reject(error)
  }

  try {
    log('[boot] calling resolveNodeBinary()')
    const result = resolveNodeBinary()
    nodePath = result.nodePath
    env = result.env
    log(`[boot] nodePath=${nodePath}`)
    log(`[boot] env=${JSON.stringify(env)}`)
  } catch (error) {
    log(`[boot] resolveNodeBinary failed: ${(error as Error).message}`)
    return Promise.reject(error)
  }

  log('[boot] about to spawn')
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [binPath, 'web', '--port', '0'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    host = child
    log(`[boot] spawned host pid=${child.pid}`)

    let stdout = ''
    const timer = setTimeout(() => {
      log(`[boot] timeout: stdout=${stdout.trim()}`)
      reject(new Error(`dsh-desktop: host did not print its URL within ${BOOT_TIMEOUT_MS}ms (stdout so far: ${stdout.trim()})`))
    }, BOOT_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      log(`[stdout] ${chunk}`)
      const match = URL_LINE.exec(stdout)
      if (match !== null) {
        clearTimeout(timer)
        log(`[boot] matched URL: http://127.0.0.1:${match[1]}`)
        resolve(`http://127.0.0.1:${match[1]}`)
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      log(`[stderr] ${chunk.trimEnd()}`)
      console.error(`[dsh-host] ${chunk.trimEnd()}`)
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      log(`[error] ${error.message}`)
      reject(new Error(`dsh-desktop: failed to spawn host: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      log(`[exit] code=${code} signal=${signal}`)
      if (mainWindow === undefined) {
        // Exited before the window opened — surface a real boot error.
        clearTimeout(timer)
        reject(new Error(`dsh-desktop: host exited before serving (code=${code} signal=${signal})`))
      }
    })
  })
}

function createWindow(origin: string): void {
  // Hide the default menu bar (File, Edit, View, etc.)
  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    title: 'DeepSeek Harness',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      // Default secure posture: the renderer is the unmodified web app.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  void mainWindow.loadURL(origin)

  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
}

/** Terminate the host child: SIGTERM first, escalate to SIGKILL if it lingers. */
function stopHost(): void {
  if (host === undefined || host.exitCode !== null) return
  const child = host
  child.kill('SIGTERM')
  const force = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, 4_000)
  child.once('exit', () => clearTimeout(force))
}

async function main(): Promise<void> {
  const logFile = `/tmp/dsh-desktop-${Date.now()}.log`
  const log = createLogger(logFile)
  log('[main] starting')

  // Single instance: a second launch focuses the existing window.
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    log('[main] second instance, quitting')
    app.quit()
    return
  }
  app.on('second-instance', () => {
    log('[main] second-instance event')
    if (mainWindow !== undefined) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  log('[main] waiting for app.whenReady()')
  await app.whenReady()
  log('[main] app ready, booting host')

  let origin: string
  try {
    origin = await bootHost()
    log(`[main] bootHost succeeded: ${origin}`)
  } catch (error) {
    log(`[main] bootHost failed: ${(error as Error).message}`)
    console.error((error as Error).message)
    app.quit()
    return
  }
  log('[main] creating window')
  createWindow(origin)

  app.on('activate', () => {
    if (mainWindow === undefined) createWindow(origin)
  })
}

// Quit when all windows are closed; stop the host child on the way out.
app.on('window-all-closed', () => {
  stopHost()
  app.quit()
})
app.on('before-quit', stopHost)

void main()
