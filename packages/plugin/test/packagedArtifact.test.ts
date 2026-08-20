/**
 * What the plugin ZIP does and does not contain (epic byte5ai/omadia#470 P4).
 *
 * `build-zip.mjs` already refuses to cut an archive that is MISSING something.
 * This suite asserts the other direction — that the archive does not GAIN
 * something — because a staging script grows by accident and nothing else here
 * would notice.
 *
 * Reads the STAGE directory rather than unzipping, so it runs after
 * `npm run package` without needing a zip tool, and skips loudly when no
 * artifact has been staged.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const pkgRoot = resolve(process.cwd());
const outDir = join(pkgRoot, 'out');

/**
 * The stage directory for the version THIS package.json declares.
 *
 * Pinned to the version rather than picked as "the newest `*-stage/`". `out/`
 * accumulates a directory per version built in the checkout, and an mtime sort
 * across them reads whichever was touched last — which during development is
 * routinely a stale `0.1.0-stage` from before a bump. Every assertion below
 * then describes an artifact nobody is shipping, and the inverse guard fails
 * for a reason that has nothing to do with the code under test. (Observed
 * exactly that while mutation-checking the no-shim assertion.)
 *
 * It is the same stale-glob hazard `ci.yml` guards against by refusing to
 * proceed when `out/*.zip` matches more than one file.
 */
function stageForThisVersion(): string | null {
  if (!existsSync(outDir)) return null;
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
  const dir = join(outDir, `${safeName}-${pkg.version}-stage`);
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : null;
}

const stage = stageForThisVersion();
if (!stage) {
  console.warn(
    '[packagedArtifact] no staged archive for this package version — run `npm run package` to ' +
      'exercise these assertions. SKIPPED.',
  );
}

/** Every path in the staged archive, relative to its root. */
function walk(dir: string, base = dir, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = abs.slice(base.length + 1);
    if (statSync(abs).isDirectory()) {
      acc.push(`${rel}/`);
      walk(abs, base, acc);
    } else {
      acc.push(rel);
    }
  }
  return acc;
}

void describe('the plugin ZIP', { skip: !stage }, () => {
  const entries = walk(stage!);

  void it('ships NO runner shim', () => {
    // DECISION (docs/SUPPLY_CHAIN.md). The shim is the code that drives an
    // agent over a repository — the most sensitive artifact this project has.
    // On every production backend it reaches the job baked into the dev-runner
    // IMAGE, which is signed, attested and digest-pinned. A second copy inside
    // the plugin ZIP would be a parallel provenance path for exactly that code,
    // verified by nothing: the hub checks no signature and the ZIP carries no
    // attestation.
    //
    // Its only filesystem consumer is `LocalProcessBackend`, built solely under
    // `unsafe_local` — a mode that already demands an explicit uid
    // acknowledgment and implies a workspace checkout where the shim is present
    // anyway.
    const offenders = entries.filter((e) => /(^|\/)(shim|runner-shim)(\/|$)/.test(e));
    assert.deepEqual(
      offenders,
      [],
      'the ZIP contains a runner shim — see docs/SUPPLY_CHAIN.md, "Why the plugin ZIP ships no shim"',
    );
  });

  void it('ships no sidecar, Dockerfile or compose file', () => {
    // These are deployment artifacts an operator builds or pulls, not things
    // the kernel loads. A Dockerfile inside a plugin ZIP is inert at best and
    // misleading at worst — it suggests the host builds something.
    const offenders = entries.filter(
      (e) => /(^|\/)sidecars(\/|$)/.test(e) || /Dockerfile/.test(e) || /docker-compose/.test(e),
    );
    assert.deepEqual(offenders, []);
  });

  void it('ships no test tree, node_modules or build metadata', () => {
    const offenders = entries.filter(
      (e) =>
        /(^|\/)(test|__tests__|\.test-build|node_modules)(\/|$)/.test(e) ||
        e.endsWith('.tsbuildinfo') ||
        e.endsWith('.test.js'),
    );
    assert.deepEqual(offenders, []);
  });

  void it('ships no operator CLI bundle', () => {
    // `bin/dev-transcript.mjs` is a tool an operator runs against a deployment's
    // database. It needs `pg` as a real dependency and a DATABASE_URL, neither
    // of which a plugin ZIP provides.
    assert.deepEqual(entries.filter((e) => /(^|\/)bin(\/|$)/.test(e)), []);
  });

  void it('still ships the four things the kernel does need', () => {
    // The inverse guard. A test that only ever asserts absence passes on an
    // empty archive.
    for (const required of ['manifest.yaml', 'package.json', 'dist/', 'migrations/']) {
      assert.ok(
        entries.includes(required) || entries.some((e) => e.startsWith(required)),
        `the ZIP is missing ${required}`,
      );
    }
    assert.ok(entries.includes('dist/plugin.js'), 'lifecycle.entry is absent from the archive');
  });
});
