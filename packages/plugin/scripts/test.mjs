#!/usr/bin/env node
/**
 * test.mjs — run the TypeScript test suite with zero extra dependencies.
 *
 *     npm test                      # everything
 *     npm test -- devWebhooks       # only files whose path contains 'devWebhooks'
 *
 * Node's built-in runner (`node:test`) drives the tests; esbuild transpiles each
 * `test/**\/*.test.ts` into `.test-build/` first.
 *
 * ## What is EXTERNAL, and why it matters
 *
 * Everything the Omadia host provides at runtime — `@omadia/plugin-api`,
 * `@omadia/dev-platform-plugin-api`, `express`, `pg`, `zod` — is marked
 * external. Bundling `pg` would give the suite a SECOND copy of the driver, and
 * `instanceof Pool` checks across two copies fail in ways that read as logic
 * bugs. The plugin's OWN sources are bundled, so a test exercises the tree as
 * written rather than the emitted `dist/`.
 *
 * ## Postgres suites
 *
 * `*.pg.test.ts` need a database and skip LOUDLY without one (issue #572 — a
 * skipped suite must never read as a passing one). Start the CI recipe container
 * and point the suites at it:
 *
 *     docker run -d --name omadia-pg-test -p 55438:5432 \
 *       -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test pgvector/pgvector:pg16
 *     export DEV_PLATFORM_PG_TEST_URL=postgres://test:test@127.0.0.1:55438/test
 *     export OMADIA_CORE_DIR=../odoo-bot     # core's base migrations 0001-0021
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const testsDir = join(pkgRoot, 'test');
const outDir = join(pkgRoot, '.test-build');
const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));

if (!existsSync(join(pkgRoot, 'dist', 'plugin.js'))) {
  console.error('dist/plugin.js is missing — run `npm run build` first.');
  process.exit(1);
}

/** Recursive, because `test/_helpers/` sits beside the suites. */
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

let entryPoints = walk(testsDir).sort();
if (filter.length > 0) {
  entryPoints = entryPoints.filter((p) => filter.some((f) => p.includes(f)));
}
if (entryPoints.length === 0) {
  console.error(`no tests found in test/${filter.length ? ` matching ${filter.join(', ')}` : ''}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`▶ transpiling ${entryPoints.length} test file(s)`);
await build({
  entryPoints,
  outdir: outDir,
  outbase: testsDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'error',
  // Host-provided at runtime. See the header — a second copy of `pg` breaks
  // `instanceof` in ways that look like logic bugs.
  //
  // `yaml` is external for a DIFFERENT reason: it is a test-only devDependency,
  // it is CommonJS, and bundling it into an ESM output turns its internal
  // `require()` calls into esbuild's "Dynamic require of X is not supported"
  // shim — which throws at import time, before a single assertion runs.
  // Resolved from node_modules at runtime instead (the runner sets cwd to the
  // package root). Only `composeTopology.test.ts` uses it.
  //
  // `@omadia/dev-runner-shim` MUST stay external too, and for a third reason
  // again: `src/index.ts` ends in
  //   `if (process.argv[1] && import.meta.url === \`file://${process.argv[1]}\`)`
  // — the guard that lets the same file be both the image entrypoint and an
  // importable module. Bundle it into a suite and `import.meta.url` becomes the
  // BUNDLE's path, which is also `process.argv[1]` under `node --test`. The
  // guard then fires at import time and the shim runs itself, reading a real
  // runner's environment out of the test process ("missing required env
  // OMADIA_JOB_BASE_URL", before a single assertion). External keeps it a
  // separate module with its own identity, so the guard stays quiet.
  // `goldenFixture.e2e.test.ts` therefore imports it BY PACKAGE NAME.
  external: [
    '@omadia/plugin-api',
    '@omadia/dev-platform-plugin-api',
    '@omadia/dev-runner-shim',
    'express',
    'pg',
    'zod',
    'yaml',
  ],
});

const built = walk(outDir, []).length ? [] : [];
const builtFiles = [];
(function collect(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p);
    else if (name.endsWith('.js')) builtFiles.push(p);
  }
})(outDir);

/**
 * Serialise the run when a Postgres URL is configured.
 *
 * `node --test` runs test FILES in parallel. That is free while every suite is
 * pure, and it is WRONG the moment a dozen of them share one database: several
 * of these suites start a real `DevJobWorker` claim loop against the same
 * `dev_jobs` table, so one suite's worker claims another suite's job and both
 * report a defect that exists in neither ("lease lost", "the job was
 * claimable"). Every one of them passes alone.
 *
 * The same shape is on record in core as a long-standing full-suite flake. It
 * is inherited with the tree, not introduced by the port — and this repo owns
 * its runner, so it gets fixed here instead of carried. Concurrency stays on
 * for the pure run, where it costs nothing and there is nothing to race.
 */
const usesPg = ['DEV_PLATFORM_PG_TEST_URL', 'GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'WS5_PG_TEST_URL', 'DATABASE_URL']
  .some((v) => (process.env[v] ?? '').trim().length > 0);
const concurrency = usesPg ? ['--test-concurrency=1'] : [];

console.log(`▶ node --test (${builtFiles.length} file(s)${usesPg ? ', serial — shared database' : ''})`);
const res = spawnSync(process.execPath, ['--test', ...concurrency, ...builtFiles.sort()], {
  cwd: pkgRoot,
  stdio: 'inherit',
  env: process.env,
});
process.exit(res.status ?? 1);
