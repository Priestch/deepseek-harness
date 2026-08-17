/**
 * Host + Node binary resolution for the Electron main process.
 *
 * The desktop shell spawns the built `dsh web` host as a child process. The host
 * imports `node:zlib` zstd named exports, so it requires Node `^22.19 || >=24`
 * (the project engine floor, enforced at boot — older Node fails on import). The
 * launcher therefore resolves a Node binary that satisfies the floor rather than
 * assuming the user's system Node or Electron's bundled Node qualifies.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** The host engine floor: `^22.19 || >=24` (Node 23 is not covered). */
function nodeSatisfies(version: string): boolean {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major >= 24) return true
  if (major === 22 && minor >= 19) return true
  return false
}

/** Read `<node> --version` and return whether it satisfies the host engine floor. */
function probeNode(nodePath: string): boolean {
  if (!existsSync(nodePath)) return false
  try {
    const result = spawnSync(nodePath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000, // 5 second timeout
    })
    if (result.status !== 0) return false
    return nodeSatisfies(result.stdout.trim())
  } catch {
    // Spawn failed, treat as unsatisfied
    return false
  }
}

/**
 * Resolve a Node binary that satisfies the host engine floor. Resolution order:
 *   1. `DSH_DESKTOP_NODE` env (explicit override).
 *   2. A bundled Node shipped as an extraResource (`<resources>/node/<exe>`).
 *   3. Electron's own runtime via `ELECTRON_RUN_AS_NODE` (`process.execPath`).
 *   4. The system `node` on `PATH`.
 * The first candidate whose `--version` satisfies the floor wins; if none do, the
 * last candidate is returned so the host surfaces its own boot error rather than a
 * silent mismatch here.
 */
export function resolveNodeBinary(): { nodePath: string; env: Record<string, string> } {
  const extraEnv: Record<string, string> = {}
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const candidates: { nodePath: string; env?: Record<string, string> }[] = []

  if (process.env.DSH_DESKTOP_NODE !== undefined && process.env.DSH_DESKTOP_NODE !== '') {
    candidates.push({ nodePath: process.env.DSH_DESKTOP_NODE })
  }

  // Packaged extraResource Node: <resources>/node/<exe>.
  if (typeof process.resourcesPath === 'string') {
    candidates.push({ nodePath: path.join(process.resourcesPath, 'node', exe) })
  }

  // Reuse Electron's bundled Node as plain Node - PREFER THIS as it's guaranteed to be recent.
  candidates.push({ nodePath: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } })

  // System Node on PATH - LAST as it may be too old.
  candidates.push({ nodePath: exe })

  let fallback = candidates[0]
  for (const candidate of candidates) {
    if (probeNode(candidate.nodePath)) {
      return { nodePath: candidate.nodePath, env: { ...extraEnv, ...(candidate.env ?? {}) } }
    }
    fallback = candidate
  }
  // None satisfy the floor; return Electron's Node as fallback (most likely to work).
  const electronNode = candidates.find(c => c.env?.ELECTRON_RUN_AS_NODE === '1')
  if (electronNode) {
    return { nodePath: electronNode.nodePath, env: { ...extraEnv, ...(electronNode.env ?? {}) } }
  }
  // Ultimate fallback.
  return { nodePath: (fallback as { nodePath: string }).nodePath, env: { ...extraEnv, ...(fallback.env ?? {}) } }
}

/**
 * Resolve the built `dsh` host bin (`apps/cli/lib/bin.js`) through the
 * `@deepseek-ai/dsh` workspace dependency. Throws if the built bin is missing —
 * the caller must run `pnpm run build` first.
 *
 * When packaged, node_modules is in app.asar.unpacked (via asarUnpack), so
 * replace .asar paths with .asar.unpacked to get the real filesystem path.
 */
export function resolveHostBin(): string {
  const require = createRequire(import.meta.url)
  let pkgRoot = path.dirname(require.resolve('@deepseek-ai/dsh/package.json'))

  // If we're in an asar archive, node_modules is actually unpacked on disk.
  // Replace /path/to/app.asar/node_modules with /path/to/app.asar.unpacked/node_modules
  if (pkgRoot.includes('.asar')) {
    pkgRoot = pkgRoot.replace(/\.asar([/\\])/, '.asar.unpacked$1')
  }

  const binPath = path.join(pkgRoot, 'lib', 'bin.js')
  if (!existsSync(binPath)) {
    throw new Error(
      `dsh-desktop: built host bin not found at ${binPath}. Run \`pnpm run build\` from the repository root.`,
    )
  }
  return binPath
}
