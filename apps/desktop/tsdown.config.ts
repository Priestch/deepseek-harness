import { defineConfig } from 'tsdown'

/**
 * The desktop shell compiles to a single CommonJS bundle for the Electron main
 * process. CJS sidesteps Electron's ESM-main format uncertainty; `electron` is
 * resolved by the Electron runtime, so it stays external. The host runs as a
 * separate child process, so no host code is imported here. The package omits
 * `"type": "module"`, so the emitted `dist/main.js` is CommonJS.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'es2024',
  external: ['electron'],
  dts: false,
  clean: true,
})
