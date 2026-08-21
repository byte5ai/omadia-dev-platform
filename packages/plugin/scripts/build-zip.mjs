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
 * `ui/` payload — the compiled operator SPA that `packages/ui` builds into this
 * package (epic #470 P2).
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
 *
 * ## It BUILDS. It does not trust that you did (issue #11)
 *
 * This script used to stage whatever `dist/` and `ui/` happened to contain.
 * During the 0.3.1 acceptance run that produced a 142,081-byte ZIP — against a
 * healthy 537,065 — from a `tsc` that had FAILED: `dist/` had been deleted, the
 * stale `*.tsbuildinfo` next to it told the compiler there was nothing to do,
 * and the archive came out missing the UI bundle and otherwise indistinguishable
 * from a valid one. It uploaded. It installed. It 404'd.
 *
 * So the build is not an assumption here, it is a step: the stale outputs and
 * their `*.tsbuildinfo` are DELETED, `npm run build` runs from the repository
 * root, and a non-zero exit stops the packaging. "Assume it was built" and
 * "check the build info" are the same bug — the second one is just harder to
 * see.
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

import {
  assertArchiveSize,
  assertStagedPayload,
  countSourceMigrations,
} from './package-payload.mjs';

/** Resolved from this file, not from `process.cwd()`: `npm run package -w
 *  packages/plugin` and a direct `node scripts/build-zip.mjs` must produce the
 *  same archive. */
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `packages/plugin` → the workspace root that owns the `build` script. */
const repoRoot = resolve(pkgRoot, '..', '..');

/** Everything the host needs at runtime. `node_modules` must never be in here.
 *
 * `migrations/` is REQUIRED, not optional. `permissions.sql.migrations` names
 * it, `ctx.sql.runMigrations()` reads it, and the kernel THROWS on an empty or
 * missing directory rather than treating it as "no migrations to run" — which
 * is the right call, and it means a ZIP cut without this directory installs and
 * then fails at activation with the plugin's nine tables absent. The first cut
 * of this script shipped exactly that ZIP.
 *
 * `handoff-plan.json` is REQUIRED for a narrower but similar reason (epic #470
 * C11). `activate()` performs the ledger handoff unconditionally; the plan file
 * is how an operator DRY-RUNS that handoff against production first, with
 * core's `middleware/scripts/plugin-ledger-handoff.mjs`. A ZIP without it
 * installs perfectly and quietly removes the only step that de-risks the
 * upgrade. `ledgerHandoff.test.ts` proves the file agrees with the code, so a
 * missing one here is a packaging bug, not a choice.
 *
 * `README.md` moved from optional to REQUIRED with issue #11. It is the only
 * documentation that travels with the artifact — the hub renders a storefront
 * page from the manifest and links no repository, so an operator inspecting an
 * unzipped plugin has this file or has nothing.
 */
const REQUIRED_FILES = ['manifest.yaml', 'handoff-plan.json', 'README.md'];
const REQUIRED_DIRS = ['dist', 'migrations', 'ui'];
const OPTIONAL_FILES = ['LICENSE', 'NOTICE'];
const OPTIONAL_DIRS = ['assets', 'skills'];

/**
 * `ui/` is REQUIRED, alongside `dist` and `migrations`, and the reasoning is
 * the same one that made `migrations/` required after the first cut of this
 * script shipped without it.
 *
 * `activate()` registers a nav entry pointing at `/plugin-ui/<id>`, which core
 * renders as an iframe onto `/p/<id>/ui/index.html`. A ZIP cut without `ui/`
 * therefore installs cleanly, activates cleanly, adds a nav entry to the
 * operator's sidebar — and answers 404 when they click it. Optional would mean
 * "a build that forgot to run `vite build` ships silently"; required means it
 * fails here, where the fix is one command.
 *
 * The directory is produced by `npm run build -w packages/ui`, which the root
 * `build` script runs after the plugin's `tsc`. It is gitignored: it is build
 * output that happens to live inside a sibling package.
 *
 * What must be INSIDE it — `index.html` plus at least one hashed bundle, and no
 * stylesheet — lives in `package-payload.mjs`, with everything else the archive
 * must and must not contain.
 */

/**
 * Build outputs that must be REGENERATED, never inherited, and the incremental
 * state that would let `tsc` skip regenerating them.
 *
 * Deleting `dist/` alone is what produced the broken 0.3.1 artifact: the
 * `*.tsbuildinfo` beside it still described the outputs as current, so `tsc`
 * exited 0 having emitted nothing. Output and build info are one unit — remove
 * both or neither.
 *
 * `packages/plugin/ui` is in the list because it is `packages/ui`'s output
 * written into this package. A vite run that fails leaves the PREVIOUS bundle
 * there, which stages, zips and installs, serving whatever the operator's last
 * successful build happened to contain.
 */
const BUILD_OUTPUTS = [
  'packages/plugin-api/dist',
  'packages/runner-shim/dist',
  'packages/plugin/dist',
  'packages/plugin/ui',
];

/** Where `*.tsbuildinfo` files live, one level up from each output. */
const BUILD_INFO_DIRS = ['packages/plugin-api', 'packages/runner-shim', 'packages/plugin'];

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

// --- build gate ------------------------------------------------------------
// Not "was it built?" — BUILD IT. The failure this replaces was a `tsc` that
// exited non-zero while a stale `*.tsbuildinfo` kept a later, successful-looking
// `tsc` from emitting anything, and a packaging run that never asked either
// question. Checking for the presence of `dist/plugin.js` would not have caught
// it: the file was there, from the previous version.
//
// Runs from the REPOSITORY ROOT because build order is a property of the
// workspace, not of this package: `plugin-api` before `runner-shim` before
// `plugin` before `ui`, and `ui` writes into `packages/plugin/ui`. Invoking
// this package's own `tsc` would produce a `dist/` with no bundle beside it.
{
  console.log('▶ cleaning stale build outputs');
  for (const rel of BUILD_OUTPUTS) {
    rmSync(join(repoRoot, rel), { recursive: true, force: true });
  }
  for (const rel of BUILD_INFO_DIRS) {
    const dir = join(repoRoot, rel);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.tsbuildinfo')) rmSync(join(dir, name), { force: true });
    }
  }

  console.log('▶ npm run build (from the repository root)');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const built = spawnSync(npm, ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  if (built.error) {
    throw new Error(`could not run \`${npm} run build\` in ${repoRoot}: ${built.error.message}`);
  }
  if (built.status !== 0) {
    throw new Error(
      `\`npm run build\` exited ${built.status} — refusing to package. A ZIP cut from a failed ` +
        'build is not a smaller ZIP, it is a broken one that installs and fails at activation ' +
        '(issue #11).',
    );
  }
}

// --- stage -----------------------------------------------------------------
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const outDir = join(pkgRoot, 'out');
const stageDir = join(outDir, `${safeName}-${pkg.version}-stage`);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// A missing required input is NOT thrown here. It is staged as far as it can be
// and then reported by `assertStagedPayload` below, together with everything
// else that is wrong — one list, once. Throwing on the first absence turns a
// broken build into a sequence of edit-run cycles, each revealing one more
// missing thing (issue #11).
for (const rel of REQUIRED_FILES) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) {
    console.log(`  ✗ ${rel} (absent)`);
    continue;
  }
  cpSync(src, join(stageDir, rel));
  console.log(`  + ${rel}`);
}

for (const rel of REQUIRED_DIRS) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) {
    console.log(`  ✗ ${rel}/ (absent)`);
    continue;
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

// --- sourcemaps ------------------------------------------------------------
// Stripped from the ARCHIVE, not from the build. `.map` sits in core's ZIP
// extension allowlist (middleware/src/plugins/zipExtractor.ts:28), so nothing
// downstream rejects one and nothing downstream reads one either: no operator
// opens devtools against a plugin bundle inside core's sandboxed iframe, and
// the plugin's own `dist/` runs server-side where the map is never fetched.
// It is dead weight that is also a disclosure — a `.js.map` carries the full
// original TypeScript, so shipping it publishes the plugin's source into every
// installation that ever unzips it.
//
// The weight is not marginal. The UI map alone was 1,196,047 bytes against a
// 292,797-byte bundle: 80% of the uncompressed payload, and 284 KB of the
// 965 KB archive, to carry something no consumer reads.
//
// Pruned from the stage rather than excluded at zip time because `createFlatZip`
// has three backends and only `zip` honours `-x` patterns — a stage-level delete
// is the only form that holds identically on all three.
{
  const pruned = [];
  const prune = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) prune(join(dir, entry.name), rel);
      else if (entry.name.toLowerCase().endsWith('.map')) {
        const bytes = statSync(join(dir, entry.name)).size;
        rmSync(join(dir, entry.name));
        pruned.push({ rel, bytes });
      }
    }
  };
  prune(stageDir, '');
  const saved = pruned.reduce((n, p) => n + p.bytes, 0);
  // Count and weight, not the roll call: 145 filenames scrolls the build log
  // past everything else it just said.
  console.log(`  - ${pruned.length} sourcemap(s) pruned (${saved} bytes)`);
}

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

// --- the payload gate ------------------------------------------------------
// Runs LAST over the finished stage, on purpose: after the sourcemap prune, so
// it guards the prune rather than duplicating it, and after the package.json
// rewrite, so what it inspects is byte-for-byte what the ZIP will carry.
//
// Reports EVERY problem at once (issue #11). The migration count is compared
// against the SOURCE directory rather than a constant — a migration added and
// never codegen'd is drift a hard-coded nine cannot see.
{
  const { entries } = assertStagedPayload({
    stageDir,
    sourceMigrationCount: countSourceMigrations(join(pkgRoot, 'migrations')),
  });
  console.log(`✓ payload verified (${entries.length} file(s) staged)`);
}

// --- zip -------------------------------------------------------------------
const zipPath = join(outDir, `${safeName}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });
createFlatZip({ zipPath, stageDir });

// The backstop. Everything above names what is missing; a size can only say
// that something is — which is exactly the signal that was available, and
// ignored, when 0.3.1 came out at 142,081 bytes against a healthy 537,065.
const zipBytes = statSync(zipPath).size;
assertArchiveSize({ bytes: zipBytes, zipPath });

console.log(`✓ built ${zipPath} (${zipBytes} bytes)`);

/**
 * Archive the CONTENTS of `stageDir` at the archive root, using whichever
 * zipper this machine has. `zip` is tried first; on Windows it is usually
 * absent, so 7-Zip and PowerShell's `Compress-Archive` follow. All three are
 * invoked so the payload lands flat — `Compress-Archive` needs the `/*` glob
 * for that, since pointing it at the directory itself would nest one level.
 */
function createFlatZip({ zipPath, stageDir }) {
  // `*.map` is belt-and-braces: the stage prune above already removed them,
  // and only the `zip` backend honours these patterns at all.
  const EXCLUDES = ['*.DS_Store', 'node_modules/*', '*.tsbuildinfo', '*.map'];
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
