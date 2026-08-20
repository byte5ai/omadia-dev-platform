import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The Dev Platform operator SPA (epic #470 P2, contract C8).
 *
 * Three settings here are contract, not preference. Changing any of them
 * produces a bundle that installs and then misbehaves in a way no test in
 * this package would notice, so each one is spelled out.
 *
 * ## 1. `base: './'` — because the mount path is not known at build time
 *
 * Core serves the bundle at `/p/<pluginId>/ui/`, and `<pluginId>` comes from
 * the installed manifest, not from this build. An absolute `base` would bake
 * one plugin id into the asset URLs. Relative URLs resolve against the
 * document, and the host page loads it as `/p/<id>/ui/index.html?...`, so
 * `./assets/app-<hash>.js` lands on `/p/<id>/ui/assets/app-<hash>.js`.
 *
 * The trailing-`index.html` in that URL is load-bearing: core also answers
 * `/p/<id>/ui` (no slash) with the same document, and relative assets fetched
 * from THAT URL would resolve one level too high. `PluginUiFrame` points at
 * `index.html` explicitly, which is why this works.
 *
 * ## 2. `cssCodeSplit: false` plus zero CSS imports — because `.css` cannot ship
 *
 * `.css` is absent from the plugin-ZIP extension allowlist and from the
 * static-serving Content-Type table, deliberately and permanently: that
 * absence is what makes the Tailwind vocabulary enforceable. A bundle that
 * emitted a stylesheet would be rejected at ingest (`zip.forbidden_extension`)
 * — the good failure — or, worse, ship with a `<link>` core answers with a
 * 404. So this package imports no CSS at all and `scripts/check-no-css.mjs`
 * (run from the test suite) asserts the output directory is CSS-free.
 *
 * `cssCodeSplit: false` is belt to that braces: with it off, any CSS that did
 * sneak in via a dependency lands in one predictable file the assertion sees,
 * instead of being scattered per-chunk.
 *
 * ## 3. `outDir` — straight into the plugin package
 *
 * `packages/plugin/ui/` is what `build-zip.mjs` stages into the archive. A
 * separate `dist/` that someone then has to remember to copy is precisely the
 * step that gets skipped, and the resulting ZIP installs with a nav entry
 * pointing at a 404.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  // Mirrors `compilerOptions.paths` in tsconfig.json. Both halves are needed:
  // TypeScript resolves types through its own mapping and never consults this
  // one, Vite resolves modules through this one and never consults tsconfig.
  // Adding an alias to only one of them typechecks and then fails at build.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL('../plugin/ui', import.meta.url)),
    emptyOutDir: true,
    cssCodeSplit: false,
    // The static router freezes a file for a year when its basename carries a
    // hash of 8+ chars containing a digit, and revalidates everything else.
    // Vite's default 8-hex hash satisfies that, but only for `assets/`; the
    // entry HTML is deliberately left unhashed so it stays revalidated.
    assetsDir: 'assets',
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
