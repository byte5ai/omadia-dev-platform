#!/usr/bin/env node
/**
 * test.mjs — run the TypeScript test suite with zero extra dependencies.
 *
 * Node's built-in test runner (`node:test`) + assert drive the tests; esbuild
 * (a dev dependency of the workspace root) transpiles each `tests/*.test.ts`
 * into `.test-build/` first, then `node --test` runs the transpiled output.
 *
 * Adapted from `omadia-integration-odoo/scripts/test.mjs`. The differences:
 * paths resolve from this file rather than from `process.cwd()` (so `npm test
 * -w packages/plugin` and a direct invocation agree), and the suite is run with
 * `cwd: pkgRoot` because the smoke test resolves `dist/plugin.js` relative to
 * it — the point of that test is to load the BUILT artifact, not a bundled copy
 * of the source.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const testsDir = join(pkgRoot, 'tests');
const outDir = join(pkgRoot, '.test-build');

if (!existsSync(join(pkgRoot, 'dist', 'plugin.js'))) {
  console.error('dist/plugin.js is missing — run `npm run build` first.');
  process.exit(1);
}

const entryPoints = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(testsDir, f));

if (entryPoints.length === 0) {
  console.error('no tests found in tests/');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`▶ transpiling ${entryPoints.length} test file(s)`);
await build({
  entryPoints,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'error',
  external: ['@omadia/plugin-api', '@omadia/dev-platform-plugin-api'],
});

const built = readdirSync(outDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(outDir, f));

console.log('▶ node --test');
const res = spawnSync(process.execPath, ['--test', ...built], {
  cwd: pkgRoot,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
