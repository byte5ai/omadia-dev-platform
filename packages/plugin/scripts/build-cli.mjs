#!/usr/bin/env node
/**
 * build-cli.mjs — bundle the operator transcript CLI into one runnable file.
 *
 *     npm run build:cli -w packages/plugin
 *     DATABASE_URL=postgres://… node packages/plugin/bin/dev-transcript.mjs list <jobId>
 *
 * ## Why a bundle rather than `dist/`
 *
 * The plugin's `tsconfig.json` has `rootDir: "src"`, because `manifest.yaml`
 * declares `lifecycle.entry: dist/plugin.js` and the ZIP ships `dist/` flat.
 * Widening `rootDir` to include `scripts/` would push everything down a level
 * to `dist/src/plugin.js` and silently break the manifest entry.
 *
 * So the CLI gets its own artifact instead. It is NOT part of the plugin ZIP:
 * `pg` is a peer the host provides, and this is a tool an operator runs against
 * a deployment's database, not something the kernel loads.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(pkgRoot, 'bin', 'dev-transcript.mjs');

await build({
  entryPoints: [join(pkgRoot, 'scripts', 'dev-transcript.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'error',
  banner: { js: '#!/usr/bin/env node' },
  // `pg` is a host-provided peer. Bundling it would give the CLI a second copy
  // of the driver — the same `instanceof Pool` hazard scripts/test.mjs avoids.
  external: ['pg'],
});

console.log(`✓ built ${outfile}`);
