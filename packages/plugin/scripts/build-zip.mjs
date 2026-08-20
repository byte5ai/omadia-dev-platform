#!/usr/bin/env node
/**
 * build-zip.mjs — stage the built plugin into an uploadable ZIP.
 *
 *     npm run build && npm run package     # → out/<id>-<version>.zip
 *
 * ## Why this exists
 *
 * A repository that cannot build its own release artifact is a repository whose
 * releases keep flowing through a tree nobody edits any more. That is exactly
 * how `@omadia/integration-odoo` ended up published from a commit that lived
 * only on a frozen monorepo branch. This repo cuts its own artifact from day
 * one, while the artifact is still empty and the pipeline is cheap to fix.
 *
 * Adapted from `omadia-integration-odoo/scripts/build-zip.mjs`. The differences
 * are the workspace layout (this package sits under `packages/plugin`, so the
 * script resolves paths from its own location, not from an assumed CWD) and the
 * `packages/ui` payload, which is not built yet.
 *
 * ## It does NOT bundle
 *
 * Plain `tsc` output ships as-is. Everything this package will import at
 * runtime is provided by the Omadia host through peers, so bundling would
 * change dependency resolution for no gain.
 *
 * ## Archive layout: FLAT, on purpose
 *
 * `manifest.yaml`, `package.json` and `dist/` sit at the archive root — no
 * wrapping `<id>-<version>-package/` directory. This matches what the hub has
 * always received from `@omadia/integration-odoo`. The Telegram script nests
 * its payload one level deeper; the two shapes are not interchangeable.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolved from this file, not from `process.cwd()`: `npm run package -w
 *  packages/plugin` and a direct `node scripts/build-zip.mjs` must produce the
 *  same archive. */
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything the host needs at runtime. `node_modules` must never be in here.
 *
 * `migrations/` is REQUIRED, not optional. `permissions.sql.migrations` names
 * it, `ctx.sql.runMigrations()` reads it, and the kernel THROWS on an empty or
 * missing directory rather than treating it as "no migrations to run" — which
 * is the right call, and it means a ZIP cut without this directory installs and
 * then fails at activation with the plugin's nine tables absent. The first cut
 * of this script shipped exactly that ZIP.
 */
const REQUIRED_FILES = ['manifest.yaml'];
const REQUIRED_DIRS = ['dist', 'migrations'];
const OPTIONAL_FILES = ['README.md', 'LICENSE', 'NOTICE'];
const OPTIONAL_DIRS = ['assets', 'skills'];

/** The manifest's `lifecycle.entry`. Its absence means `tsc` did not finish. */
const REQUIRED_IN_DIST = ['plugin.js'];

/** The nine codegen'd migrations, by name. Counted rather than assumed: a
 *  partial codegen produces a directory that exists, passes the check above, and
 *  leaves the plugin a schema short. */
const REQUIRED_MIGRATION_COUNT = 9;

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
if (!pkg.name || !pkg.version) {
  throw new Error('package.json: "name" and "version" are required');
}

// --- version drift guard ---------------------------------------------------
// The version lives in two files and the hub reads the MANIFEST, not
// package.json. When they disagree, the published artifact carries a different
// version than the repository believes it cut — which is how a release ends up
// unattributable to a commit. Measured drift of exactly this kind is why the
// check is here rather than in a reviewer's head.
const manifestText = readFileSync(join(pkgRoot, 'manifest.yaml'), 'utf8');
const manifestVersion = manifestText.match(
  /^\s{2}version:\s*["']?([^"'\s]+)/m,
)?.[1];
if (!manifestVersion) {
  throw new Error('manifest.yaml: could not read identity.version');
}
if (manifestVersion !== pkg.version) {
  throw new Error(
    `version drift: package.json says ${pkg.version}, manifest.yaml says ${manifestVersion}. ` +
      'The hub reads the manifest — bump both.',
  );
}

// --- identity drift guard --------------------------------------------------
// Same class of bug, one field over. The hub keys a plugin by `identity.id`;
// npm keys it by `name`. If they diverge, an upgrade silently installs a second
// plugin alongside the first instead of replacing it.
const manifestId = manifestText.match(/^\s{2}id:\s*["']?([^"'\s]+)/m)?.[1];
if (manifestId !== pkg.name) {
  throw new Error(
    `identity drift: package.json name is ${pkg.name}, manifest.yaml id is ${String(manifestId)}.`,
  );
}

// --- stage -----------------------------------------------------------------
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const outDir = join(pkgRoot, 'out');
const stageDir = join(outDir, `${safeName}-${pkg.version}-stage`);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const rel of REQUIRED_FILES) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) throw new Error(`missing required file: ${rel}`);
  cpSync(src, join(stageDir, rel));
  console.log(`  + ${rel}`);
}

for (const rel of REQUIRED_DIRS) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) {
    throw new Error(`missing required directory: ${rel} — run \`npm run build\` first`);
  }
  cpSync(src, join(stageDir, rel), { recursive: true });
  console.log(`  + ${rel}/`);
}

for (const rel of [...OPTIONAL_FILES, ...OPTIONAL_DIRS]) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) continue;
  cpSync(src, join(stageDir, rel), { recursive: true });
  console.log(`  + ${rel}${statSync(src).isDirectory() ? '/' : ''}`);
}

for (const rel of REQUIRED_IN_DIST) {
  if (!existsSync(join(stageDir, 'dist', rel))) {
    throw new Error(`staged dist/ is missing ${rel} — the build artefact is incomplete`);
  }
}

// The ZIP extension allowlist has no `.sql` (bug B4), which is why these are
// `.js` at all. Verify the codegen actually ran AND produced all nine: a ZIP one
// migration short installs cleanly and breaks at activation.
const stagedMigrations = readdirSync(join(stageDir, 'migrations')).filter((f) => f.endsWith('.js'));
if (stagedMigrations.length !== REQUIRED_MIGRATION_COUNT) {
  throw new Error(
    `staged migrations/ has ${stagedMigrations.length} .js file(s), expected ${REQUIRED_MIGRATION_COUNT} — ` +
      'run `npm run codegen:migrations` against a core checkout',
  );
}
if (readdirSync(join(stageDir, 'migrations')).some((f) => f.endsWith('.sql'))) {
  throw new Error(
    'staged migrations/ contains a .sql file — `.sql` is NOT in the ZIP extension allowlist ' +
      '(zipExtractor.ts), so it would be silently dropped on install',
  );
}
console.log(`  + migrations/ verified (${stagedMigrations.length} codegen'd + checksums.json)`);

// --- package.json, without devDependencies ---------------------------------
// devDependencies are meaningless inside a published artifact — nothing ever
// installs them from a plugin ZIP — and in this repo they point at a sibling
// checkout (`file:../odoo-bot/middleware/...`) and at workspace siblings.
// Shipping those paths would embed one machine's directory layout in a public
// artifact, and any host that did run an install against it would fail on a
// path that exists nowhere but here.
const shipped = { ...pkg };
delete shipped.devDependencies;
delete shipped.scripts;
writeFileSync(
  join(stageDir, 'package.json'),
  `${JSON.stringify(shipped, null, 2)}\n`,
);
console.log('  + package.json (devDependencies + scripts stripped)');

// --- zip -------------------------------------------------------------------
const zipPath = join(outDir, `${safeName}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });
createFlatZip({ zipPath, stageDir });

console.log(`✓ built ${zipPath} (${statSync(zipPath).size} bytes)`);

/**
 * Archive the CONTENTS of `stageDir` at the archive root, using whichever
 * zipper this machine has. `zip` is tried first; on Windows it is usually
 * absent, so 7-Zip and PowerShell's `Compress-Archive` follow. All three are
 * invoked so the payload lands flat — `Compress-Archive` needs the `/*` glob
 * for that, since pointing it at the directory itself would nest one level.
 */
function createFlatZip({ zipPath, stageDir }) {
  const EXCLUDES = ['*.DS_Store', 'node_modules/*', '*.tsbuildinfo'];
  const strategies = [
    {
      label: 'zip',
      cmd: 'zip',
      args: ['-r', '-q', zipPath, '.', ...EXCLUDES.flatMap((p) => ['-x', p])],
      opts: { cwd: stageDir, stdio: 'inherit' },
    },
    {
      label: '7z',
      cmd: '7z',
      args: ['a', '-tzip', '-bd', '-bso0', zipPath, '.'],
      opts: { cwd: stageDir, stdio: 'inherit' },
    },
    {
      label: 'Compress-Archive',
      cmd: 'powershell',
      args: [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${stageDir}/*' -DestinationPath '${zipPath}' -Force`,
      ],
      opts: { stdio: 'inherit' },
    },
  ];

  const attempted = [];
  for (const s of strategies) {
    const res = spawnSync(s.cmd, s.args, s.opts);
    if (res.error && res.error.code === 'ENOENT') {
      attempted.push(`${s.label} (not installed)`);
      continue;
    }
    if (res.error) {
      attempted.push(`${s.label} (${res.error.message})`);
      continue;
    }
    if (res.status === 0 && existsSync(zipPath)) return;
    attempted.push(`${s.label} (exit ${res.status})`);
  }

  throw new Error(
    `could not create ${zipPath} — no working zip tool. Tried: ${attempted.join(', ')}. ` +
      'Install `zip`, install 7-Zip (`7z`), or ensure PowerShell (Compress-Archive) is available.',
  );
}
