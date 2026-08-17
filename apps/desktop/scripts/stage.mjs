#!/usr/bin/env node
/**
 * Stage a self-contained production copy for electron-builder, then SMOKE-TEST
 * that the staged host actually boots. Producing a distributable installer needs
 * a complete, symlink-free runtime closure; this script makes that completeness
 * a checked fact, not an assumption.
 *
 * Why a manifest, not `pnpm deploy` of the desktop package alone: the project's
 * packages declare their dependencies as peerDependencies (the plugin/composition
 * model), so a pruned deploy of the desktop package drops the whole plugin graph
 * — even core packages (dsh-llm, dsh-session, dsh-agent) are peers, not owned
 * transitively. The desktop package's `dependencies` therefore list the FULL
 * web-host closure (union of the sdk-runtime agent spine, the web-app bundle, and
 * the base bundle) so the deploy root OWNS every plugin. `--prod` then keeps the
 * graph (they are real deps) while pruning the dev toolchain (electron, tsdown,
 * vitest, …), and `--node-linker=hoisted` yields a flat, symlink-free node_modules
 * that survives asar.
 *
 * Run after the host and SPA are built:
 *   pnpm run build && pnpm run build:web
 * then:
 *   pnpm --filter @deepseek-ai/dsh-desktop run stage
 */
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

const root = resolve(new URL('../../..', import.meta.url).pathname)
const stage = resolve(root, 'apps/desktop/release/stage')

const mustExist = [
  ['desktop main bundle', 'apps/desktop/dist/main.js'],
  ['host bin', 'apps/cli/lib/bin.js'],
  ['SPA dist', 'apps/web/dist/index.html'],
]
for (const [label, rel] of mustExist) {
  if (!existsSync(resolve(root, rel))) {
    console.error(`stage: missing ${label} at ${rel} — run \`pnpm run build && pnpm run build:web\` first.`)
    process.exit(1)
  }
}

rmSync(stage, { recursive: true, force: true })
console.log('stage: pnpm deploy --node-linker=hoisted (manifest-owned, flat closure)…')
execFileSync(
  process.env.PNPM_PATH ?? 'pnpm',
  // --node-linker=hoisted: flat node_modules (no .pnpm symlinks) so asar packaging works.
  ['--filter', '@deepseek-ai/dsh-desktop', 'deploy', '--legacy', '--node-linker=hoisted', stage],
  // node-pty builds here via node-gyp; pass through proxy/headers env from the caller.
  // On Windows `pnpm` is pnpm.cmd, so spawn through a shell there.
  { cwd: root, stdio: 'inherit', env: { ...process.env }, shell: process.platform === 'win32' },
)

const hostBin = resolve(stage, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
if (!existsSync(hostBin)) {
  console.error('stage: deploy did not produce the host bin — see output above.')
  process.exit(1)
}

// electron-builder reads this package.json for app metadata. The scoped workspace
// name (@deepseek-ai/dsh-desktop) is illegal in deb filenames/install paths, so
// publish the staged app under a clean unscoped name (the workspace name is unused
// in the packaged app — the Electron main loads via `main`, the host via node_modules).
const stagePkgPath = resolve(stage, 'package.json')
const stagePkg = JSON.parse(readFileSync(stagePkgPath, 'utf8'))
stagePkg.name = 'dsh-desktop'
writeFileSync(stagePkgPath, JSON.stringify(stagePkg, null, 2) + '\n')

// `link:` overrides (cosmokit, schemastery) survive deploy as symlinks pointing
// back at the repo's vendor/ — outside the stage, so absent on a user's machine.
// Materialize any symlink that escapes the stage so the closure is self-contained.
materializeOutsideSymlinks(resolve(stage, 'node_modules'))

// asar cannot follow symlinks: verify the staged node_modules is flat. The
// `.bin` shims (always symlinks, never on the module-resolution path) are fine.
// `electron/dist` contains the Electron binary bundle; on macOS the .app
// framework directories contain structural symlinks that are not module-resolution
// symlinks and must be preserved intact by electron-builder.
const symlinks = findSymlinks(resolve(stage, 'node_modules')).filter((p) => {
  const parts = p.split('/')
  return !parts.includes('.bin') && !(parts[0] === 'electron' && parts[1] === 'dist')
})
if (symlinks.length) {
  console.error(
    `stage: staged node_modules contains ${symlinks.length} symlink(s) (e.g. ${symlinks.slice(0, 3).join(', ')}).\n` +
    '      asar packaging requires a flat layout; --node-linker=hoisted should have prevented this.',
  )
  process.exit(1)
}

// Smoke-test: the staged host must boot and print its loopback URL. This catches
// an incomplete closure (ERR_MODULE_NOT_FOUND) before electron-builder runs.
console.log('stage: smoke-testing staged host boot…')
const ok = await bootSmoke(hostBin)
if (!ok) {
  console.error(
    'stage: staged host failed to boot — the closure is incomplete.\n' +
    '      The desktop package dependencies must own every plugin the web profile mounts\n' +
    '      (union of sdk-runtime + web-app + base bundles). Do NOT run electron-builder.',
  )
  process.exit(1)
}
console.log('stage: staged host boots and serves — ready at apps/desktop/release/stage')

/** Replace any symlink whose target lies outside the stage with a real copy. */
function materializeOutsideSymlinks(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (name === '.bin') continue
    const p = resolve(dir, name)
    let st
    try { st = lstatSync(p) } catch { continue }
    if (st.isSymbolicLink()) {
      let target
      try { target = realpathSync(p) } catch { continue }
      if (!target.startsWith(stage + sep)) {
        rmSync(p, { force: true })
        // Exclude node_modules: the vendored package's own node_modules is workspace
        // cruft (its deps are hoisted to the stage top level), and copying it would
        // drag in escaped symlinks.
        cpSync(target, p, {
          recursive: true,
          filter: (src) => !src.split(sep).includes('node_modules'),
        })
      }
    } else if (st.isDirectory()) {
      materializeOutsideSymlinks(p)
    }
  }
}

/** Recursively collect symlink paths under a directory (none expected under hoisted). */
function findSymlinks(dir, acc = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return acc }
  for (const name of entries) {
    const p = resolve(dir, name)
    let st
    try { st = lstatSync(p) } catch { continue }
    if (st.isSymbolicLink()) acc.push(relative(stage, p))
    else if (st.isDirectory()) findSymlinks(p, acc)
  }
  return acc
}

/** Boot the staged host, return true iff it prints its loopback URL within 45s. */
function bootSmoke(bin) {
  return new Promise((resolveBoot) => {
    const child = spawn(process.execPath, [bin, 'web', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => { out += c; if (/http:\/\/127\.0\.0\.1:\d+/.test(out)) done(true) })
    const timer = setTimeout(() => done(false), 45_000)
    child.on('exit', () => done(false))
    let settled = false
    function done(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolveBoot(result)
    }
  })
}
