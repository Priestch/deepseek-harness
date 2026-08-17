# @deepseek-ai/dsh-desktop

Electron desktop shell for DeepSeek Harness. It spawns the built `dsh web` host
on an OS-assigned loopback port and loads the SPA in a `BrowserWindow`. The web
client (React and every `dsh-client-*` package) runs **unchanged** — the shipped
HTTP + WebSocket transport is reused as-is.

## How it works

```
Electron main (dist/main.js)
  ├── resolve a Node >=22.19 binary            (main-launcher: env > bundled > ELECTRON_RUN_AS_NODE > system)
  ├── spawn <node> apps/cli/lib/bin.js web --port 0   (host child, env passthrough incl. DEEPSEEK_API_KEY)
  ├── read  http://127.0.0.1:<port>            (from the host's stdout URL line)
  └── BrowserWindow.loadURL(loopback origin)   (default secure posture, no preload)
```

Loopback (`127.0.0.1`) is the host's trusted default, so no trust or credential
configuration is needed for the carrier. The renderer loads a normal http origin
with `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`.

The host imports `node:zlib` zstd named exports at boot, so it requires Node
`^22.19 || >=24`. The launcher probes each candidate's `--version` and rejects one
that does not satisfy the floor, so the host surfaces its own boot error rather
than a silent mismatch.

## Prerequisites

- Node `^22.19 || >=24` available on `PATH` (or set `DSH_DESKTOP_NODE` to a
  qualifying binary). The Electron runtime and the system Node are both probed.
- The built host and SPA dist:
  ```sh
  pnpm run build        # builds apps/cli/lib (the host bin) and the library graph
  pnpm run build:web    # builds apps/web/dist (the SPA)
  ```
- One-time, approve Electron's postinstall (which fetches its binary) so pnpm stops
  gating scripts on it: `pnpm approve-builds` and select `electron`. The download
  honors `GLOBAL_AGENT_HTTP_PROXY` / `ELECTRON_GET_USE_PROXY` behind a proxy.

## Develop

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build   # compile dist/main.js
pnpm --filter @deepseek-ai/dsh-desktop run dev      # build + electron .
```

A real model call needs `DEEPSEEK_API_KEY` in the environment (or `.env` at the
repo root), exactly like `dsh web`. Host stderr is echoed to the terminal with a
`[dsh-host]` prefix.

## Status

- **Dev mode is verified.** `pnpm run dev` launches Electron, which spawns the
  host, reads the loopback port, and loads the SPA in a window — the full chain
  runs against the workspace install, identical to `dsh web`.
- **Distributable installers are scaffolded but blocked by a pre-existing project
  gap** (below). The `stage` script and `electron-builder.yml` are in place; the
  gap must be resolved before `dist` produces a bootable installer.

## Package

Installers are produced from a **staged** directory (`release/stage`) — a pruned,
symlink-free production copy assembled by `pnpm deploy`, because pnpm's symlinked
`node_modules` do not survive asar. `scripts/stage.mjs` deploys **and smoke-tests
that the staged host boots** before handing off to electron-builder, so an
incomplete closure fails the build loud rather than shipping a broken app.

```sh
# unpacked build first (validates resolution before installers):
pnpm --filter @deepseek-ai/dsh-desktop run dist:dir
# per-OS installers:
pnpm --filter @deepseek-ai/dsh-desktop run dist
```

`electron-builder.yml` targets: `dmg` (mac), `nsis` (win), `AppImage` + `deb`
(linux).

### Known blocker: incomplete standalone closure

The project's runtime/devDependency declarations are not standalone-packaging-
ready. Some packages import vendored packages that are declared as
**devDependencies of the importing package** (e.g. `dsh-app-boot` imports the
vendored `@deepseek-ai/cordis-plugin-group`). These resolve in the dev workspace
through pnpm's hidden hoist, but a pruned `pnpm deploy` drops transitive
devDependencies, so the staged host throws `ERR_MODULE_NOT_FOUND` at boot. The
`stage` smoke-test catches this and names the remediation. Unblock with either:

- **(A) Correct the declarations** (preferred) — in each package that
  runtime-imports a vendored package, move it from `devDependencies` to
  `dependencies`. Smallest installer; proper pruning.
- **(B) Bundle the full workspace** — copy the dev `node_modules` (with its `.pnpm`
  hidden hoist intact) and `asarUnpack` it. Larger installer; no code changes.

### Native addons

`npmRebuild: false` is set deliberately. The host runs as a **child process on a
real Node** (not Electron's ABI), so native addons must be built for that Node
during `pnpm deploy` — not rebuilt by electron-builder for Electron. The two
natives in the host closure:

- **`node-pty`** (the terminal PTY backend) — a genuine `.node` addon. It builds
  during `pnpm deploy` via node-gyp, so the build machine needs network for Node
  headers (honor `HTTPS_PROXY` if behind a proxy). If it cannot build, the terminal
  capability is unavailable but the rest of the app boots.
- **`landlock-run`** — a Linux-only **prebuilt binary** (not an addon) resolved via
  optionalDependencies; it probes `unusable` when absent, so the platform sandbox
  chain (`bwrap`/`seatbelt`/`windows-acl`) is used instead. Nothing to build.

### Bundling a known-good Node (optional)

To remove any dependence on the user's system Node, drop a Node `>=22.19` binary
for the target platform at `resources/node/<exe>` in the staged app (or set the
`DSH_DESKTOP_NODE_BIN` env var to a source path before `dist`). The launcher
prefers that bundled Node over `ELECTRON_RUN_AS_NODE` and the system `node`.

## Files

| Path | Role |
|---|---|
| `src/main.ts` | Electron main: spawn host, read port, create window, lifecycle |
| `src/main-launcher.ts` | Resolve a floor-satisfying Node binary and the built host bin |
| `electron-builder.yml` | Packaging config over the staged app root |
| `scripts/stage.mjs` | `pnpm deploy` into `release/stage` + artifact checks |
