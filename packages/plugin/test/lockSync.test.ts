/**
 * The lockfile drift gate (issue byte5ai/omadia-dev-platform#16).
 *
 * `package-lock.json` recorded `packages/plugin` at 0.3.1 for three releases
 * while `package.json` moved on to 0.3.4. Nothing noticed: `npm ci` installs the
 * dependency TREE, and a workspace member's own `version` field is not part of
 * it. So the drift is invisible to every command this repository runs, and the
 * public lockfile claims a version the plugin has not been since #8.
 *
 * The obvious repair is the one that must not be used. `npm install
 * --package-lock-only` fixes `packages/plugin` and, in the same pass, rewrites
 * the `../odoo-bot/middleware/packages/plugin-api` entry from whatever core
 * checkout happens to sit next to this repo on the developer's disk — 0.1.0 as
 * committed, 1.6.0 on the machine that found the bug. That is machine state,
 * and it would land in a public lockfile.
 *
 * Hence a checker rather than a regeneration: it reads, it never writes, and
 * the fix it prints is a hand edit of one field.
 *
 * Every case asserts a NAMED member and NAMED versions, never merely
 * `drift.length > 0`. A gate that fails for the wrong reason is a gate that
 * will pass for the wrong reason later.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

// Imported from the REPOSITORY's `scripts/`, not this package's: the lockfile is
// a property of the workspace root and every member is a subject, so the checker
// cannot live inside one of them. `test/` is excluded from this package's
// tsconfig and esbuild bundles the suite, so the untyped import costs nothing.
import {
  assertLockInSync,
  collectLockDrift,
  readWorkspaceMembers,
} from '../../../scripts/check-lock-sync.mjs';

/**
 * `scripts/test.mjs` spawns the runner with `cwd` set to this package's root,
 * which is the only path assumption that survives bundling — `import.meta.url`
 * points into `.test-build/` once esbuild is done with this file.
 */
const repoRoot = resolve(process.cwd(), '..', '..');

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

type Member = {
  dir: string;
  name: string;
  pkgVersion: string;
  /** Omit to mirror `pkgVersion`; `null` to leave the member out of the lock. */
  lockVersion?: string | null;
};

type TreeOptions = {
  workspaces?: string[];
  rootPkgVersion?: string;
  rootLockVersion?: string;
  /** Extra `packages` keys, e.g. a `file:` external outside the repository. */
  extraLockPackages?: Record<string, unknown>;
};

function makeTree(members: Member[], opts: TreeOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'odp-lock-sync-'));
  roots.push(root);

  const workspaces = opts.workspaces ?? ['packages/*'];
  const rootPkgVersion = opts.rootPkgVersion ?? '0.0.0';
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', version: rootPkgVersion, workspaces }, null, 2),
  );

  const lockPackages: Record<string, unknown> = {
    '': { name: 'fixture-root', version: opts.rootLockVersion ?? rootPkgVersion },
    ...(opts.extraLockPackages ?? {}),
  };

  for (const m of members) {
    mkdirSync(join(root, m.dir), { recursive: true });
    writeFileSync(
      join(root, m.dir, 'package.json'),
      JSON.stringify({ name: m.name, version: m.pkgVersion }, null, 2),
    );
    if (m.lockVersion !== null) {
      lockPackages[m.dir] = { name: m.name, version: m.lockVersion ?? m.pkgVersion };
    }
  }

  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'fixture-root',
        version: rootPkgVersion,
        lockfileVersion: 3,
        requires: true,
        packages: lockPackages,
      },
      null,
      2,
    ),
  );
  return root;
}

describe('workspace member discovery', () => {
  it('expands a `packages/*` glob and a literal path, and nothing else', () => {
    const root = makeTree(
      [
        { dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4' },
        { dir: 'packages/ui', name: '@fixture/ui', pkgVersion: '0.3.0' },
        { dir: 'sidecars/daemon', name: '@fixture/daemon', pkgVersion: '0.3.0' },
      ],
      { workspaces: ['packages/*', 'sidecars/daemon'] },
    );
    // A sibling of a literal member, WITH a package.json, that no pattern names.
    // The `sidecars/*` directories that are not `dev-runner-daemon` carry no
    // package.json in this repo, so this fixture proves the stricter thing: even
    // a manifest-bearing sibling stays out unless a pattern names it.
    mkdirSync(join(root, 'sidecars', 'not-a-member'), { recursive: true });
    writeFileSync(
      join(root, 'sidecars', 'not-a-member', 'package.json'),
      JSON.stringify({ name: '@fixture/stray', version: '9.9.9' }),
    );

    const dirs = readWorkspaceMembers(root).map((m) => m.dir);
    assert.deepEqual(dirs, ['', 'packages/plugin', 'packages/ui', 'sidecars/daemon']);
  });

  it('refuses a pattern it cannot expand instead of checking fewer members', () => {
    // Silently expanding to nothing is the same class of failure as the drift:
    // a gate that examines less than it claims to. Every shape npm allows and
    // this script does not must be loud.
    for (const pattern of ['packages/**', '!packages/private', 'packages/*/lib', '*']) {
      const root = makeTree([{ dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4' }], {
        workspaces: [pattern],
      });
      assert.throws(
        () => readWorkspaceMembers(root),
        /unsupported workspaces pattern/,
        `pattern ${pattern} must be rejected, not silently skipped`,
      );
    }
  });

  it('skips a glob match that carries no package.json', () => {
    const root = makeTree([
      { dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4' },
    ]);
    mkdirSync(join(root, 'packages', 'scratch'), { recursive: true });

    const dirs = readWorkspaceMembers(root).map((m) => m.dir);
    assert.deepEqual(dirs, ['', 'packages/plugin']);
  });

  it('ignores a dot-directory under a glob, as npm does (dot:false)', () => {
    const root = makeTree([
      { dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4' },
    ]);
    // A leading-dot dir with a real package.json. npm's glob never matches it, so
    // the lockfile carries no entry — treating it as a member would red the gate
    // over a directory npm ignores.
    mkdirSync(join(root, 'packages', '.cache'), { recursive: true });
    writeFileSync(
      join(root, 'packages', '.cache', 'package.json'),
      JSON.stringify({ name: '@fixture/cache', version: '1.0.0' }),
    );

    const dirs = readWorkspaceMembers(root).map((m) => m.dir);
    assert.deepEqual(dirs, ['', 'packages/plugin']);
  });

  it('THROWS on a literal member whose directory is gone, rather than skip it', () => {
    // A named path that vanished is a defect, not an empty glob. Silently
    // dropping it is the "examines less than it claims" failure the gate exists
    // to prevent — the same shape as the drift itself.
    const root = makeTree(
      [{ dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4' }],
      { workspaces: ['packages/*', 'sidecars/gone'] },
    );
    assert.throws(() => readWorkspaceMembers(root), /has no package\.json/);
  });

  it('THROWS on a pattern that resolves outside the repository', () => {
    // The machine-state trap. A member outside the repo has no committed
    // package.json — its version lives on a laptop (issue #16). Reading it at all
    // is the coupling this change exists to keep out, so it must fail loudly, not
    // quietly report drift on someone's checkout.
    const root = makeTree(
      [{ dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4' }],
      { workspaces: ['packages/*', '../outside'] },
    );
    // A real package.json outside the root, so the ONLY thing standing between
    // the gate and that version is the containment guard.
    const outside = resolve(root, '..', 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, 'package.json'),
      JSON.stringify({ name: '@fixture/outside', version: '7.7.7' }),
    );
    roots.push(outside);

    assert.throws(() => readWorkspaceMembers(root), /resolves outside the repository/);
  });
});

describe('lockfile drift detection', () => {
  it('finds nothing when every member agrees with the lockfile', () => {
    const root = makeTree([
      { dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4' },
      { dir: 'packages/ui', name: '@fixture/ui', pkgVersion: '0.3.0' },
    ]);
    assert.deepEqual(collectLockDrift(root), []);
  });

  it('names the member whose lockfile version trails package.json — the #16 shape', () => {
    const root = makeTree([
      { dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4', lockVersion: '0.3.1' },
      { dir: 'packages/ui', name: '@fixture/ui', pkgVersion: '0.3.0' },
    ]);

    const drift = collectLockDrift(root);
    assert.equal(drift.length, 1, 'only the drifted member is reported');
    assert.equal(drift[0].dir, 'packages/plugin');
    assert.equal(drift[0].name, '@fixture/plugin');
    assert.equal(drift[0].packageVersion, '0.3.4');
    assert.equal(drift[0].lockVersion, '0.3.1');
  });

  it('reports a workspace member the lockfile does not mention at all', () => {
    const root = makeTree([
      { dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4', lockVersion: null },
    ]);

    const drift = collectLockDrift(root);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].dir, 'packages/plugin');
    assert.equal(drift[0].lockVersion, null, 'absent stays distinguishable from wrong');
  });

  it('checks the workspace ROOT entry too', () => {
    const root = makeTree(
      [{ dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4' }],
      { rootPkgVersion: '0.0.0', rootLockVersion: '0.0.1' },
    );

    const drift = collectLockDrift(root);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].dir, '', 'the root is the "" key in a lockfileVersion 3 file');
    assert.equal(drift[0].packageVersion, '0.0.0');
    assert.equal(drift[0].lockVersion, '0.0.1');
  });

  it('never looks at a `file:` external outside the repository', () => {
    // The whole reason this checker exists instead of `npm install
    // --package-lock-only`. The external's recorded version has no package.json
    // in this tree to agree with, so it is neither a member nor drift.
    const root = makeTree(
      [{ dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4' }],
      {
        extraLockPackages: {
          '../odoo-bot/middleware/packages/plugin-api': {
            name: '@omadia/plugin-api',
            version: '0.1.0',
          },
        },
      },
    );

    assert.deepEqual(collectLockDrift(root), []);
    // The external key exists in the lockfile but is not a member the checker
    // discovers — discovery is driven by `workspaces`, never by lockfile keys.
    const dirs = readWorkspaceMembers(root).map((m) => m.dir);
    assert.deepEqual(dirs, ['', 'packages/plugin']);
  });
});

describe('assertLockInSync', () => {
  it('returns the checked members when the tree is clean', () => {
    const root = makeTree([
      { dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4' },
    ]);
    const members = assertLockInSync(root);
    assert.equal(members.length, 2, 'the root plus one member');
  });

  it('throws a message that names the member, both versions, and the hand edit', () => {
    const root = makeTree([
      { dir: 'packages/plugin', name: '@fixture/plugin', pkgVersion: '0.3.4', lockVersion: '0.3.1' },
    ]);

    assert.throws(
      () => assertLockInSync(root),
      (err: unknown) => {
        const msg = String((err as Error).message);
        assert.match(msg, /packages\/plugin/, 'names the member directory');
        assert.match(msg, /@fixture\/plugin/, 'names the package');
        assert.match(msg, /0\.3\.1/, 'names the lockfile version');
        assert.match(msg, /0\.3\.4/, 'names the package.json version');
        assert.match(msg, /package-lock\.json/, 'names the file to edit');
        // The instruction has to be npm-free, and has to say why.
        assert.match(
          msg,
          /do NOT run `npm install --package-lock-only`/,
          'forbids the regeneration that would leak the local core checkout',
        );
        assert.match(msg, /"version": "0\.3\.4"/, 'shows the exact replacement field');
        return true;
      },
    );
  });
});

describe('this repository', () => {
  it('has a package-lock.json in sync with every workspace member', () => {
    const drift = collectLockDrift(repoRoot);
    assert.deepEqual(
      drift,
      [],
      `package-lock.json drifted: ${drift
        .map((d) => `${d.dir || '<root>'} lock=${d.lockVersion} pkg=${d.packageVersion}`)
        .join(', ')}`,
    );
  });

  it('wires the gate into `npm run package` via build-zip.mjs', () => {
    // The library working was never the risk — the WIRING is the deliverable, and
    // this repo family has shipped a declared-but-unread hook before. Delete the
    // call and every other case here still passes; this one does not.
    const buildZip = readFileSync(join(repoRoot, 'packages/plugin/scripts/build-zip.mjs'), 'utf8');
    assert.match(
      buildZip,
      /assertLockInSync\(repoRoot\)/,
      'build-zip.mjs must gate packaging on the lockfile check',
    );
    assert.match(
      buildZip,
      /from '\.\.\/\.\.\/\.\.\/scripts\/check-lock-sync\.mjs'/,
      'build-zip.mjs must import the checker from the repo-root scripts dir',
    );
  });

  it('runs the lockfile check in CI BEFORE `npm ci`', () => {
    // `npm ci` exits 0 on a drifted member version, so the check has to precede
    // it — a check after install proves nothing the install already accepted.
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const checkAt = ci.indexOf('scripts/check-lock-sync.mjs');
    const npmCiAt = ci.search(/run:\s*npm ci/);
    assert.ok(checkAt !== -1, 'CI must run scripts/check-lock-sync.mjs');
    assert.ok(npmCiAt !== -1, 'CI must run npm ci');
    assert.ok(checkAt < npmCiAt, 'the lockfile check must come before npm ci');
  });

  it('still records the core checkout external exactly as committed', () => {
    // Not a version this repo controls — a value that must survive every future
    // lockfile edit. If a regeneration ever runs on a developer machine, this is
    // the assertion that catches the machine state on the way in.
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    const external = lock.packages['../odoo-bot/middleware/packages/plugin-api'];
    assert.ok(external, 'the external entry must stay in the lockfile');
    assert.equal(
      external.version,
      '0.1.0',
      'core plugin-api as committed, not as checked out locally',
    );
  });
});
