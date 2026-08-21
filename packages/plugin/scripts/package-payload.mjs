#!/usr/bin/env node
/**
 * package-payload.mjs — what a shippable plugin archive must and must not contain.
 *
 * Split out of `build-zip.mjs` (issue byte5ai/omadia-dev-platform#11) so the
 * assertions can be exercised against FIXTURES. The bug this file exists for is
 * not one a reviewer can see: `npm run package` produced
 * `omadia-dev-platform-0.3.1.zip` at 142,081 bytes instead of 537,065 after a
 * `tsc` that had failed — UI bundle absent, and otherwise indistinguishable from
 * a valid artifact. It installed. It activated. It 404'd.
 *
 * Two design choices follow from that:
 *
 *  1. **Every problem is COLLECTED, then reported together.** Throwing on the
 *     first missing thing turns one broken build into a sequence of edit-run
 *     cycles, each revealing one more absence. The whole list, once, is what an
 *     operator can act on.
 *  2. **The checks read the STAGE, not the source tree.** A source tree can be
 *     perfect while the archive is empty; only the staged payload is what the
 *     hub receives.
 *
 * Pure: no I/O beyond reading the stage directory, no process exit, no logging.
 * `build-zip.mjs` owns the exit codes and the console; the tests own the
 * fixtures.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The archive size floor.
 *
 * The broken 0.3.1 artifact was 142,081 bytes; a healthy one is ~538,000. The
 * floor sits at 400 KB — comfortably under a real archive, comfortably over
 * every partial one observed. It is a BACKSTOP, not the primary check: the
 * payload assertions below name what is missing, while a size alone only says
 * that something is.
 */
export const MIN_ZIP_BYTES = 400 * 1024;

/**
 * The archive size ceiling.
 *
 * ~4x a healthy archive. The named guards below already catch the two specific
 * ways this archive has grown by accident (sourcemaps, a staged `node_modules`),
 * so the ceiling is deliberately loose: it is here to catch the growth nobody
 * predicted — a vendored binary, a bundled dependency tree, an `assets/`
 * directory someone dropped a video into — before the hub receives it, rather
 * than to police normal UI growth.
 */
export const MAX_ZIP_BYTES = 2 * 1024 * 1024;

/**
 * The floor on codegen'd migrations.
 *
 * The count is also compared against the SOURCE directory (see
 * `countSourceMigrations`), which is the check that actually tracks reality. The
 * floor is the second half: a source tree that itself lost migrations would
 * satisfy an equality check while shipping a plugin several tables short.
 */
export const MIN_MIGRATION_COUNT = 9;

/**
 * Files that must exist in the staged archive, at these exact paths.
 *
 * `dist/plugin.js` is the manifest's `lifecycle.entry` — absent means `tsc` did
 * not finish. `ui/index.html` is what core's iframe loads at
 * `/p/<id>/ui/index.html` — absent means `vite build` did not finish, and the
 * plugin installs, activates, adds a nav entry and 404s when it is clicked.
 * `handoff-plan.json` is how an operator dry-runs the ledger handoff that
 * `activate()` performs unconditionally (epic #470 C11). `README.md` is the only
 * documentation that travels with the artifact — the hub renders no repository.
 */
export const REQUIRED_STAGED_FILES = [
  'manifest.yaml',
  'package.json',
  'handoff-plan.json',
  'README.md',
  'dist/plugin.js',
  'ui/index.html',
];

/**
 * The hashed UI bundle `index.html` loads.
 *
 * Checked SEPARATELY from `ui/index.html` because the two fail apart: a vite run
 * that emitted the HTML shell and no chunk leaves an entry point that resolves
 * and a page that renders nothing. Also the inverse guard for the no-sourcemap
 * assertion — deleting `ui/` entirely yields zero `.map` files too.
 */
export const HASHED_UI_BUNDLE_RE = /^ui\/assets\/index-[A-Za-z0-9_-]+\.js$/;

/**
 * Every FILE in `dir`, relative to it, with `/` separators.
 *
 * @param {string} dir
 * @param {string} [base]
 * @param {string[]} [acc]
 * @returns {string[]}
 */
export function walkStage(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = abs.slice(base.length + 1).split(/[\\/]/).join('/');
    if (statSync(abs).isDirectory()) walkStage(abs, base, acc);
    else acc.push(rel);
  }
  return acc;
}

/**
 * How many migrations the SOURCE tree has.
 *
 * The staged count is compared against this rather than against a hard-coded
 * number: a migration added to the source and not codegen'd is exactly the kind
 * of drift a constant cannot see. `checksums.json` is not a migration.
 *
 * @param {string} migrationsDir
 * @returns {number}
 */
export function countSourceMigrations(migrationsDir) {
  if (!existsSync(migrationsDir)) return 0;
  return readdirSync(migrationsDir).filter((f) => f.endsWith('.js')).length;
}

/**
 * Everything wrong with a staged payload, as human sentences.
 *
 * @param {{ stageDir: string, sourceMigrationCount: number }} opts
 * @returns {string[]} Empty when the payload is shippable.
 */
export function collectPayloadProblems({ stageDir, sourceMigrationCount }) {
  /** @type {string[]} */
  const problems = [];

  if (!existsSync(stageDir)) {
    return [`the stage directory does not exist: ${stageDir}`];
  }

  const entries = walkStage(stageDir);
  const present = new Set(entries);

  // --- must be there -------------------------------------------------------
  for (const rel of REQUIRED_STAGED_FILES) {
    if (!present.has(rel)) problems.push(`missing: ${rel}`);
  }

  if (!entries.some((e) => HASHED_UI_BUNDLE_RE.test(e))) {
    problems.push(
      'missing: ui/assets/index-<hash>.js — the SPA shell without its bundle renders a blank page ' +
        '(run `npm run build -w packages/ui`)',
    );
  }

  // --- migrations ----------------------------------------------------------
  // The kernel THROWS on an empty or missing migrations directory rather than
  // treating it as "nothing to run", so a short set is an activation failure
  // with the plugin's tables absent — discovered by an operator, not here.
  const stagedMigrations = entries.filter((e) => /^migrations\/[^/]+\.js$/.test(e));
  if (stagedMigrations.length < MIN_MIGRATION_COUNT) {
    problems.push(
      `migrations/: ${stagedMigrations.length} .js file(s), at least ${MIN_MIGRATION_COUNT} required — ` +
        'run `npm run codegen:migrations` against a core checkout',
    );
  }
  if (sourceMigrationCount > 0 && stagedMigrations.length !== sourceMigrationCount) {
    problems.push(
      `migrations/: ${stagedMigrations.length} staged, ${sourceMigrationCount} in the source tree — ` +
        'the archive would install a schema the repository does not describe',
    );
  }
  // `.sql` is NOT in core's ZIP extension allowlist (zipExtractor.ts), which is
  // why these are `.js` at all. A staged `.sql` is dropped silently on install.
  const strayJsSql = entries.filter((e) => e.startsWith('migrations/') && e.endsWith('.sql'));
  if (strayJsSql.length > 0) {
    problems.push(
      `migrations/ contains ${strayJsSql.length} .sql file(s) — \`.sql\` is absent from the ZIP ` +
        'extension allowlist and would be dropped silently on install',
    );
  }

  // --- must NOT be there ---------------------------------------------------
  // A `.js.map` carries the full original TypeScript, so shipping one publishes
  // this plugin's source into every installation that unzips it. `.map` IS in
  // core's allowlist, so nothing downstream rejects it and nothing reads it.
  const maps = entries.filter((e) => e.toLowerCase().endsWith('.map'));
  if (maps.length > 0) {
    problems.push(
      `${maps.length} sourcemap(s) staged (${maps.slice(0, 5).join(', ')}${maps.length > 5 ? ', …' : ''}) — ` +
        'a .js.map republishes the plugin source into every installation',
    );
  }

  // `.css` is absent from the allowlist, so a ZIP carrying one is rejected at
  // ingest with `zip.forbidden_extension` — after upload, by someone else, with
  // a message that does not name this build.
  const styles = entries.filter((e) => e.toLowerCase().endsWith('.css'));
  if (styles.length > 0) {
    problems.push(
      `${styles.length} stylesheet(s) staged (${styles.join(', ')}) — plugins ship no CSS; the bundle ` +
        'links the sheet core serves (see packages/ui/vocabulary/README.md)',
    );
  }

  const vendored = entries.filter((e) => /(^|\/)node_modules\//.test(e));
  if (vendored.length > 0) {
    problems.push(
      `${vendored.length} node_modules path(s) staged — the host resolves every runtime dependency ` +
        'through peers; a vendored tree is weight and a second provenance path',
    );
  }

  const buildMeta = entries.filter((e) => e.endsWith('.tsbuildinfo'));
  if (buildMeta.length > 0) {
    problems.push(`${buildMeta.length} .tsbuildinfo file(s) staged — build metadata is not payload`);
  }

  return problems;
}

/**
 * Throw unless the staged payload is shippable, naming EVERY problem at once.
 *
 * @param {{ stageDir: string, sourceMigrationCount: number }} opts
 * @returns {{ entries: string[] }}
 */
export function assertStagedPayload(opts) {
  const problems = collectPayloadProblems(opts);
  if (problems.length > 0) {
    throw new Error(
      `the staged payload is not shippable — ${problems.length} problem(s):\n` +
        problems.map((p) => `  ✗ ${p}`).join('\n') +
        '\n\nRefusing to cut an archive that would install and then fail. ' +
        'A broken ZIP is indistinguishable from a good one once it reaches the hub.',
    );
  }
  return { entries: walkStage(opts.stageDir) };
}

/**
 * Throw unless the finished archive's size is plausible.
 *
 * @param {{ bytes: number, zipPath: string }} opts
 */
export function assertArchiveSize({ bytes, zipPath }) {
  if (bytes < MIN_ZIP_BYTES) {
    throw new Error(
      `${zipPath} is ${bytes} bytes, below the ${MIN_ZIP_BYTES}-byte floor. A healthy archive is ` +
        '~538 KB; the broken 0.3.1 artifact that motivated this gate was 142,081. Something the ' +
        'payload assertions did not name is absent — inspect the stage before publishing.',
    );
  }
  if (bytes > MAX_ZIP_BYTES) {
    throw new Error(
      `${zipPath} is ${bytes} bytes, above the ${MAX_ZIP_BYTES}-byte ceiling. The archive has grown ` +
        'several times its normal size — check for a vendored dependency tree, an unpruned sourcemap ' +
        'or a large asset before publishing.',
    );
  }
}
