/**
 * The packaging gate, against FIXTURES (issue byte5ai/omadia-dev-platform#11).
 *
 * `packagedArtifact.test.ts` asserts properties of the archive this checkout
 * actually staged. It cannot assert the more important thing: that packaging
 * REFUSES when the payload is wrong. There is only one real stage per run, it is
 * correct, and deliberately breaking it would break the suite that reads it.
 *
 * So these cases build synthetic stages — a good one, then one defect at a time
 * — and check what `collectPayloadProblems` says about each. The two the issue
 * names explicitly are `ui/` absent (the 0.3.1 artifact: 142,081 bytes instead
 * of 537,065, installed, activated, 404'd) and a `.map` that sneaks past the
 * prune (a `.js.map` republishes this plugin's TypeScript into every
 * installation).
 *
 * Every case asserts a NAMED problem, never merely `problems.length > 0`. A gate
 * that fails for the wrong reason is a gate that will pass for the wrong reason
 * later.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

// Imported from `scripts/`, not from `src/`: the gate has to run BEFORE and
// WITHOUT a build, so it is plain `.mjs` build tooling rather than compiled
// plugin code. `test/` is excluded from this package's tsconfig and esbuild
// bundles the suite, so the untyped import costs nothing here.
import {
  MAX_ZIP_BYTES,
  MIN_MIGRATION_COUNT,
  MIN_ZIP_BYTES,
  assertArchiveSize,
  assertStagedPayload,
  collectPayloadProblems,
  countSourceMigrations,
} from '../scripts/package-payload.mjs';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A stage that a real `npm run package` would have produced. */
function goodStage(): string {
  const root = mkdtempSync(join(tmpdir(), 'odp-stage-'));
  roots.push(root);
  const put = (rel: string, body = 'x') => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  put('manifest.yaml', 'schema_version: "1"\n');
  put('package.json', '{"name":"@omadia/dev-platform","version":"0.0.0"}\n');
  put('handoff-plan.json', '{}\n');
  put('README.md', '# plugin\n');
  put('dist/plugin.js', 'export const activate = () => {};\n');
  put('dist/plugin.d.ts', 'export declare const activate: () => void;\n');
  put('ui/index.html', '<!doctype html><script src="/assets/index-BnGGkA-G.js"></script>');
  put('ui/assets/index-BnGGkA-G.js', 'console.log(1)');
  for (let i = 0; i < MIN_MIGRATION_COUNT; i += 1) {
    put(`migrations/00${22 + i}_dev_platform.js`, 'export const up = () => {};\n');
  }
  put('migrations/checksums.json', '{}\n');
  return root;
}

/** Shorthand: the problems reported for `stage`, with the fixture's own count. */
function problemsFor(stage: string, sourceMigrationCount = MIN_MIGRATION_COUNT): string[] {
  return collectPayloadProblems({ stageDir: stage, sourceMigrationCount }) as string[];
}

/** `true` when some reported problem mentions `needle`. */
function mentions(problems: string[], needle: string | RegExp): boolean {
  const re = typeof needle === 'string' ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : needle;
  return problems.some((p) => re.test(p));
}

void describe('the packaging payload gate', () => {
  void it('passes a complete stage — the inverse guard for everything below', () => {
    // Without this, every assertion in this file could be satisfied by a
    // `collectPayloadProblems` that returns a complaint unconditionally.
    assert.deepEqual(problemsFor(goodStage()), []);
  });

  void it('FAILS when ui/ is absent — the 0.3.1 artifact', () => {
    // The one the issue names. A ZIP without `ui/` installs cleanly, activates
    // cleanly, adds a nav entry to the operator's sidebar and answers 404 when
    // they click it. Nothing downstream notices; the hub checks no payload.
    const stage = goodStage();
    rmSync(join(stage, 'ui'), { recursive: true, force: true });

    const problems = problemsFor(stage);
    assert.ok(mentions(problems, 'ui/index.html'), `no problem named ui/index.html: ${problems}`);
    assert.ok(
      mentions(problems, /ui\/assets\/index-<hash>\.js/),
      'the missing hashed bundle went unreported — index.html alone renders a blank page',
    );
    assert.throws(
      () => assertStagedPayload({ stageDir: stage, sourceMigrationCount: MIN_MIGRATION_COUNT }),
      /not shippable/,
    );
  });

  void it('FAILS when ui/index.html exists but the hashed bundle does not', () => {
    // A vite run that emitted the shell and no chunk. The entry point resolves,
    // the iframe loads, and the operator sees nothing at all — which reads as a
    // plugin bug rather than a packaging one.
    const stage = goodStage();
    rmSync(join(stage, 'ui', 'assets'), { recursive: true, force: true });
    assert.ok(mentions(problemsFor(stage), /ui\/assets\/index-<hash>\.js/));
  });

  void it('FAILS when a .map sneaks in', () => {
    // The other case the issue names. `.map` IS in core's ZIP extension
    // allowlist, so ingest accepts it silently — and a `.js.map` carries the
    // full original TypeScript, republishing the plugin's source into every
    // installation that unzips it. `build-zip.mjs` prunes them from the stage;
    // this is the guard on the prune, not a duplicate of it.
    const stage = goodStage();
    writeFileSync(join(stage, 'ui', 'assets', 'index-BnGGkA-G.js.map'), '{"version":3}');

    const problems = problemsFor(stage);
    assert.ok(mentions(problems, 'sourcemap'), `no sourcemap problem: ${problems}`);
    assert.ok(mentions(problems, 'index-BnGGkA-G.js.map'), 'the offending file was not named');
    assert.throws(
      () => assertStagedPayload({ stageDir: stage, sourceMigrationCount: MIN_MIGRATION_COUNT }),
      /not shippable/,
    );
  });

  void it('FAILS when dist/plugin.js is absent — a `tsc` that emitted nothing', () => {
    const stage = goodStage();
    rmSync(join(stage, 'dist', 'plugin.js'), { force: true });
    assert.ok(mentions(problemsFor(stage), 'dist/plugin.js'));
  });

  void it('FAILS when a stylesheet is staged', () => {
    // `.css` is ABSENT from the allowlist, so this one is rejected at ingest —
    // after upload, by someone else, with a message that does not name the build
    // that produced it.
    const stage = goodStage();
    writeFileSync(join(stage, 'ui', 'assets', 'index-BnGGkA-G.css'), '.a{}');
    assert.ok(mentions(problemsFor(stage), 'stylesheet'));
  });

  void it('FAILS when migrations are one short of the source tree', () => {
    const stage = goodStage();
    rmSync(join(stage, `migrations/00${22 + MIN_MIGRATION_COUNT - 1}_dev_platform.js`), {
      force: true,
    });
    const problems = problemsFor(stage);
    assert.ok(mentions(problems, 'migrations/'), `no migrations problem: ${problems}`);
    assert.ok(
      mentions(problems, `${MIN_MIGRATION_COUNT - 1} .js file(s)`) ||
        mentions(problems, `${MIN_MIGRATION_COUNT - 1} staged`),
      'the problem did not report the actual count',
    );
  });

  void it('FAILS when the source tree grew a migration the codegen never ran for', () => {
    // The drift a hard-coded nine cannot see: the stage is internally consistent
    // and one table behind the repository.
    const stage = goodStage();
    const problems = problemsFor(stage, MIN_MIGRATION_COUNT + 1);
    assert.ok(mentions(problems, `${MIN_MIGRATION_COUNT + 1} in the source tree`), `${problems}`);
  });

  void it('FAILS on a .sql migration, which install would drop silently', () => {
    const stage = goodStage();
    writeFileSync(join(stage, 'migrations', '0031_dev_platform.sql'), 'SELECT 1;');
    assert.ok(mentions(problemsFor(stage), '.sql'));
  });

  void it('FAILS when node_modules is staged', () => {
    const stage = goodStage();
    mkdirSync(join(stage, 'node_modules', 'pg'), { recursive: true });
    writeFileSync(join(stage, 'node_modules', 'pg', 'index.js'), 'module.exports={}');
    assert.ok(mentions(problemsFor(stage), 'node_modules'));
  });

  void it('FAILS when README.md is absent', () => {
    // The only documentation that travels with the artifact: the hub renders a
    // storefront page from the manifest and links no repository.
    const stage = goodStage();
    rmSync(join(stage, 'README.md'), { force: true });
    assert.ok(mentions(problemsFor(stage), 'README.md'));
  });

  void it('FAILS when manifest.yaml or handoff-plan.json is absent', () => {
    const stage = goodStage();
    rmSync(join(stage, 'manifest.yaml'), { force: true });
    rmSync(join(stage, 'handoff-plan.json'), { force: true });
    const problems = problemsFor(stage);
    assert.ok(mentions(problems, 'manifest.yaml'));
    assert.ok(mentions(problems, 'handoff-plan.json'));
  });

  void it('reports EVERY problem at once, not just the first', () => {
    // The whole reason this returns a list. One broken build should cost one
    // edit-run cycle, not one per missing thing.
    const stage = goodStage();
    rmSync(join(stage, 'ui'), { recursive: true, force: true });
    rmSync(join(stage, 'README.md'), { force: true });
    rmSync(join(stage, 'dist', 'plugin.js'), { force: true });
    writeFileSync(join(stage, 'dist', 'plugin.js.map'), '{}');

    const problems = problemsFor(stage);
    assert.ok(problems.length >= 4, `expected several problems, got ${problems.length}`);
    for (const named of ['ui/index.html', 'README.md', 'dist/plugin.js', 'sourcemap']) {
      assert.ok(mentions(problems, named), `${named} was not among the reported problems`);
    }
    // …and the thrown message carries all of them, so the console shows the list.
    assert.throws(
      () => assertStagedPayload({ stageDir: stage, sourceMigrationCount: MIN_MIGRATION_COUNT }),
      (err: Error) =>
        /README\.md/.test(err.message) && /sourcemap/.test(err.message) && /ui\/index\.html/.test(err.message),
    );
  });

  void it('reports a stage directory that does not exist at all', () => {
    const problems = collectPayloadProblems({
      stageDir: join(tmpdir(), 'odp-stage-does-not-exist-ever'),
      sourceMigrationCount: MIN_MIGRATION_COUNT,
    }) as string[];
    assert.equal(problems.length, 1);
    assert.ok(mentions(problems, 'does not exist'));
  });
});

void describe('the archive size backstop', () => {
  void it('rejects the 142,081-byte artifact that motivated this gate', () => {
    assert.throws(
      () => assertArchiveSize({ bytes: 142_081, zipPath: '/out/x.zip' }),
      /below the .* floor/,
    );
  });

  void it('accepts a healthy archive', () => {
    // The real one at the time of writing is 538,458 bytes.
    assertArchiveSize({ bytes: 538_458, zipPath: '/out/x.zip' });
  });

  void it('rejects an archive several times its normal size', () => {
    assert.throws(
      () => assertArchiveSize({ bytes: MAX_ZIP_BYTES + 1, zipPath: '/out/x.zip' }),
      /above the .* ceiling/,
    );
  });

  void it('has a floor below the ceiling and both in a plausible range', () => {
    // Guards a future edit that inverts them, which would make one bound
    // unreachable and the other permanently violated.
    assert.ok(MIN_ZIP_BYTES < MAX_ZIP_BYTES);
    assert.ok(MIN_ZIP_BYTES >= 100_000, 'a floor this low would not have caught 0.3.1');
    assert.ok(MIN_ZIP_BYTES <= 500_000, 'a floor above a healthy archive fails every good build');
  });
});

void describe('countSourceMigrations', () => {
  void it('counts .js files and ignores checksums.json', () => {
    const stage = goodStage();
    assert.equal(countSourceMigrations(join(stage, 'migrations')), MIN_MIGRATION_COUNT);
  });

  void it('answers 0 for a directory that is not there, rather than throwing', () => {
    // The count feeds an equality check that is SKIPPED at 0. A throw here would
    // turn "the source migrations moved" into a stack trace instead of the
    // named problem `collectPayloadProblems` already reports.
    assert.equal(countSourceMigrations(join(tmpdir(), 'odp-no-such-migrations')), 0);
  });

  void it('agrees with the repository: the real source tree has at least nine', () => {
    // Ties the fixtures to reality. Every case above uses MIN_MIGRATION_COUNT;
    // if the repository moved past it, the fixtures are describing a plugin
    // nobody ships.
    const real = countSourceMigrations(join(process.cwd(), 'migrations')) as number;
    assert.ok(real >= MIN_MIGRATION_COUNT, `the source tree has ${real} migrations`);
  });
});
