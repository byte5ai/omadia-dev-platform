#!/usr/bin/env node
/**
 * check-lock-sync.mjs — assert `package-lock.json` records the version every
 * workspace member's `package.json` declares (issue #16).
 *
 *     node scripts/check-lock-sync.mjs      # or `npm run check:lock`
 *
 * ## The bug this exists to prevent
 *
 * `package-lock.json` pinned `packages/plugin` at 0.3.1 across #8, #13 and #15
 * while `package.json` went to 0.3.4. Nothing caught it, and nothing could:
 * `npm ci` reconstructs the dependency TREE, and a workspace member's own
 * `version` field is not part of that tree. A drifted lockfile installs
 * perfectly, tests green, packages a correct ZIP — and tells every reader of a
 * public repository that this plugin is a version it has not been for three
 * releases.
 *
 * ## Why this is a CHECK and not a regeneration
 *
 * The one-command repair is the one that must never run here. `npm install
 * --package-lock-only` would fix `packages/plugin` and, in the same pass,
 * rewrite
 *
 *     "../odoo-bot/middleware/packages/plugin-api"
 *
 * from whatever core checkout happens to sit next to this repo on the machine
 * it runs on. That entry is committed as 0.1.0; the developer who found #16 had
 * 1.6.0 on disk, and a later one had 1.10.0. None of those numbers describe this
 * repository — they describe a laptop. npm has no way to know that the `file:`
 * target is somebody's working tree rather than a pinned dependency, so the only
 * safe tool is one that cannot write at all.
 *
 * So: this script READS. When it finds drift it prints the exact field to edit
 * by hand, and says why the obvious shortcut is forbidden. Two lines of JSON,
 * no regeneration, no machine state.
 *
 * ## What it does NOT check
 *
 * Anything outside the repository. A `packages` key beginning with `../` is a
 * `file:` external with no committed package.json in this tree to agree with, so
 * it is never a member: `readWorkspaceMembers` yields only directories the
 * `workspaces` patterns name, and `expandPattern` THROWS on any pattern that
 * resolves outside the repo rather than reading a version off someone's disk.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `scripts/` → the workspace root that owns `package-lock.json`. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Expand one `workspaces` pattern to member directories, relative to the root
 * and with `/` separators (the form `package-lock.json` keys by).
 *
 * Only the two shapes this repository uses are supported — a literal path and a
 * single trailing `/*` — and anything else THROWS. A pattern quietly expanding
 * to nothing would silently drop a member from the check, which is the same
 * class of failure as the drift itself: a gate that examines less than it
 * claims. Widen this deliberately if a pattern is ever added.
 */
function expandPattern(rootDir, pattern) {
  const star = pattern.indexOf('*');
  const supported =
    !pattern.startsWith('!') &&
    (star === -1 || (star === pattern.length - 1 && pattern.endsWith('/*')));
  if (!supported) {
    throw new Error(
      `check-lock-sync: unsupported workspaces pattern ${JSON.stringify(pattern)}. ` +
        'Only a literal path or one trailing "/*" is understood — teach this script the new shape ' +
        'rather than letting it check fewer members than the workspace has.',
    );
  }

  // Containment is a HARD invariant, not a property of today's pattern list. A
  // member that resolves outside the repo has no committed package.json to agree
  // with — it is a working tree on someone's disk. `package.json` already carries
  // a `file:../odoo-bot/...` dep (see scripts/link-core.mjs); the day that path
  // reaches `workspaces`, an unguarded checker would assert the developer's local
  // core version against the committed one and red every release. That is the
  // exact machine-state coupling this whole change exists to keep out.
  const insideRepo = (dir) => {
    const abs = resolve(rootDir, dir);
    const rel = relative(rootDir, abs);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };

  // A directory is a member iff it holds a package.json — and npm reads it, so a
  // broken symlink is "not a member", not a crash. `existsSync` already follows
  // links and returns false on a dangling one.
  const hasManifest = (dir) => existsSync(join(rootDir, dir, 'package.json'));

  if (!pattern.endsWith('/*')) {
    if (!insideRepo(pattern)) {
      throw new Error(
        `check-lock-sync: workspaces pattern ${JSON.stringify(pattern)} resolves outside the repository. ` +
          'A member outside the repo has no committed package.json to check against — its version is machine state (issue #16).',
      );
    }
    // A NAMED member that is gone is a defect, not an empty glob: unlike a scratch
    // subdirectory under `packages/`, someone wrote this path down. Silently
    // dropping it checks one member fewer while reporting success — the same
    // "examines less than it claims" failure the drift itself was.
    if (!hasManifest(pattern)) {
      throw new Error(
        `check-lock-sync: workspaces lists ${JSON.stringify(pattern)} but it has no package.json. ` +
          'Fix the pattern or restore the member — do not let the gate skip it.',
      );
    }
    return [pattern];
  }

  const parent = pattern.slice(0, -2);
  const parentDir = join(rootDir, parent);
  if (!existsSync(parentDir)) return [];

  return readdirSync(parentDir)
    .filter((name) => !name.startsWith('.')) // npm's glob runs with dot:false
    .map((name) => `${parent}/${name}`)
    .filter((dir) => {
      const candidate = join(rootDir, dir);
      const st = statSync(candidate, { throwIfNoEntry: false });
      return st?.isDirectory() === true && hasManifest(dir);
    })
    .sort();
}

/**
 * Every package whose version the lockfile mirrors: the workspace root (the
 * `""` key in a lockfileVersion 3 file) followed by each member, sorted.
 *
 * @returns {{ dir: string, name: string, version: string }[]}
 */
export function readWorkspaceMembers(rootDir = REPO_ROOT) {
  const rootPkg = readJson(join(rootDir, 'package.json'));
  const members = [{ dir: '', name: rootPkg.name, version: rootPkg.version }];

  const seen = new Set();
  for (const pattern of rootPkg.workspaces ?? []) {
    for (const dir of expandPattern(rootDir, pattern)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const pkg = readJson(join(rootDir, dir, 'package.json'));
      members.push({ dir, name: pkg.name, version: pkg.version });
    }
  }

  return members;
}

/**
 * Members whose lockfile entry disagrees with their `package.json`.
 *
 * `lockVersion` is `null` when the lockfile has no entry for the member at all —
 * a different defect (a member added without an install) that deserves a
 * different sentence, so the two stay distinguishable rather than collapsing
 * into "wrong".
 *
 * @returns {{ dir: string, name: string, packageVersion: string, lockVersion: string | null }[]}
 */
export function collectLockDrift(rootDir = REPO_ROOT) {
  const lock = readJson(join(rootDir, 'package-lock.json'));
  const entries = lock.packages ?? {};

  return readWorkspaceMembers(rootDir)
    .map((member) => {
      const entry = entries[member.dir];
      const lockVersion = entry?.version ?? null;
      return lockVersion === member.version
        ? null
        : {
            dir: member.dir,
            name: member.name,
            packageVersion: member.version,
            lockVersion,
          };
    })
    .filter((d) => d !== null);
}

/** The remediation, spelled out far enough that nobody reaches for npm. */
export function formatLockDrift(drift) {
  const lines = [
    `package-lock.json is out of sync with ${drift.length} workspace member(s):`,
    '',
  ];

  for (const d of drift) {
    lines.push(`  ${d.dir || '<workspace root>'}  (${d.name})`);
    lines.push(`      package.json:      ${d.packageVersion}`);
    lines.push(
      d.lockVersion === null
        ? '      package-lock.json: (no entry)'
        : `      package-lock.json: ${d.lockVersion}`,
    );
    lines.push('');
  }

  lines.push('Fix it BY HAND — do NOT run `npm install --package-lock-only`.');
  lines.push('');
  lines.push(
    'That command repairs these entries and, in the same pass, rewrites the',
    '"../odoo-bot/middleware/packages/plugin-api" entry from whatever core checkout',
    'sits next to this repo on YOUR machine. That version describes a laptop, not',
    'this repository, and it must never land in a public lockfile (issue #16).',
    '',
    'Open package-lock.json, find these keys under "packages", and set:',
    '',
  );

  for (const d of drift) {
    lines.push(`  "${d.dir}": { "version": "${d.packageVersion}", ... }`);
  }

  lines.push(
    '',
    'Change nothing else. `npm ci` reads the same file afterwards and needs no',
    'regeneration — the dependency tree did not move, only the member version did.',
  );

  return lines.join('\n');
}

/**
 * Throw unless every workspace member's lockfile entry matches its package.json.
 *
 * @returns the members that were checked, so a caller can prove it checked some.
 */
export function assertLockInSync(rootDir = REPO_ROOT) {
  const drift = collectLockDrift(rootDir);
  if (drift.length > 0) throw new Error(formatLockDrift(drift));
  return readWorkspaceMembers(rootDir);
}

/**
 * CLI entry.
 *
 * Deliberately NOT the usual `import.meta.url === \`file://${process.argv[1]}\``
 * guard. `packages/plugin/test/lockSync.test.ts` imports this module and esbuild
 * BUNDLES it, at which point `import.meta.url` becomes the bundle's path — which
 * is also `process.argv[1]` under `node --test`. The guard would fire at import
 * time and run the CLI inside the suite. `packages/runner-shim` is on record
 * with exactly that bug (see the `external` list in `scripts/test.mjs`); the
 * basename cannot collide, so the basename is what is checked.
 */
if (process.argv[1] && basename(process.argv[1]) === 'check-lock-sync.mjs') {
  try {
    const members = assertLockInSync();
    console.log(
      `✓ package-lock.json in sync — ${members.length} workspace entr${members.length === 1 ? 'y' : 'ies'} checked`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
