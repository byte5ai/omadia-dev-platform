/**
 * Epic #470 C11 — the nine witnesses, and the guard around them.
 *
 * ## What can go wrong here, and what each test catches
 *
 * The handoff is a claim about a database this repo cannot see. Almost nothing
 * about it can be proved locally — but three specific ways of getting it wrong
 * can, and all three are silent in production:
 *
 *   1. **A migration ships without a witness.** It would then be re-applied on
 *      every upgrade forever, which is invisible because the files are
 *      idempotent. Caught by comparing the entry list against `migrations/`.
 *   2. **A witness casts to `regclass`.** `'public.dev_jobs'::regclass` THROWS
 *      for a missing table — the exact case the witness exists to detect — so
 *      the restore scenario becomes an activation crash instead of a repair.
 *      Caught by rejecting the cast syntax outright.
 *   3. **A witness proves the wrong object.** The rule is "the last object the
 *      file creates", and the file is right there in `migrations/`. Caught by
 *      grepping the migration's own SQL for the object the witness names.
 *
 * (3) is the interesting one: it turns the reviewer's rule into a test, so a
 * witness that names a table from a DIFFERENT migration — the easy mistake,
 * since all nine touch `dev_jobs` — fails here rather than in an upgrade.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LEDGER_HANDOFF_ENTRIES,
  SEED_LEDGER_ENTRIES,
} from '../src/ledgerHandoff.js';

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

function shippedMigrations(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

/** The object name a witness asserts on, whichever helper produced it. */
function witnessTarget(sql: string): string | undefined {
  return (
    /to_regclass\('public\.([a-z0-9_]+)'\)/.exec(sql)?.[1] ??
    /column_name = '([a-z0-9_]+)'/.exec(sql)?.[1] ??
    /c\.conname = '([a-z0-9_]+)'/.exec(sql)?.[1]
  );
}

describe('#470 C11 ledger handoff entries', () => {
  it('covers exactly the migrations this package ships', () => {
    assert.deepEqual(
      LEDGER_HANDOFF_ENTRIES.map((e) => e.filename).sort(),
      shippedMigrations(),
      'a migration with no witness is re-applied on every upgrade — invisibly, because the files are idempotent',
    );
  });

  it('lists them in the order they ran', () => {
    const names = LEDGER_HANDOFF_ENTRIES.map((e) => e.filename);
    assert.deepEqual([...names].sort(), names);
  });

  it('names each file exactly once', () => {
    const names = LEDGER_HANDOFF_ENTRIES.map((e) => e.filename);
    assert.equal(new Set(names).size, names.length);
  });

  it('never casts to regclass — that throws on the very case a witness detects', () => {
    for (const entry of LEDGER_HANDOFF_ENTRIES) {
      assert.ok(
        !/::\s*regclass/.test(entry.witnessSql),
        `${entry.filename}: '...'::regclass throws for a missing relation; use to_regclass or a catalog join`,
      );
    }
  });

  it('is a single-row single-column boolean SELECT in every case', () => {
    for (const entry of LEDGER_HANDOFF_ENTRIES) {
      assert.match(
        entry.witnessSql,
        /^SELECT (EXISTS \(|to_regclass\()/,
        `${entry.filename}: the kernel requires exactly one boolean column`,
      );
      assert.ok(
        !/\bcount\s*\(/i.test(entry.witnessSql),
        `${entry.filename}: count(*) is 1 for a table that exists, 0 for one that is empty, and a throw for one that does not`,
      );
      assert.ok(
        !entry.witnessSql.includes(';'),
        `${entry.filename}: a witness is one statement`,
      );
    }
  });

  it('proves an object the migration it belongs to actually creates', () => {
    for (const entry of LEDGER_HANDOFF_ENTRIES) {
      const target = witnessTarget(entry.witnessSql);
      assert.ok(target, `${entry.filename}: could not read the witness target`);
      const source = readFileSync(join(migrationsDir, entry.filename), 'utf8');
      assert.ok(
        source.includes(target),
        `${entry.filename}: its witness asserts on '${target}', which does not appear in the migration — ` +
          'the rule is the LAST object the file creates, and all nine touch dev_jobs, so this is the easy mistake',
      );
      assert.ok(
        entry.proves.includes(target),
        `${entry.filename}: the human-readable 'proves' (${entry.proves}) disagrees with the SQL (${target})`,
      );
    }
  });

  it('reads the constraint DEFINITION for 0025, not merely its presence', () => {
    const entry = LEDGER_HANDOFF_ENTRIES.find((e) =>
      e.filename.startsWith('0025_'),
    );
    assert.ok(entry);
    // 0025 REPLACES an existing CHECK to admit a new `source` value. The
    // constraint name is present before the migration too, so presence alone
    // would be true on a database that never ran it.
    assert.match(entry.witnessSql, /pg_get_constraintdef/);
    assert.match(entry.witnessSql, /plugin/);
  });

  it('keeps handoff-plan.json in step with the code', () => {
    // The operator dry-runs the handoff against production BEFORE installing
    // anything, with core's CLI:
    //
    //   node middleware/scripts/plugin-ledger-handoff.mjs \
    //     --plan packages/plugin/handoff-plan.json
    //
    // That file is a second copy of the same facts, and a second copy drifts.
    // Here the drift is worse than usual: the plan an operator reads would
    // stop describing the handoff the plugin actually performs, and the dry
    // run — whose entire purpose is to be trustworthy — would be lying.
    const plan = JSON.parse(
      readFileSync(join(migrationsDir, '..', 'handoff-plan.json'), 'utf8'),
    ) as {
      pluginId: string;
      ledger: string;
      migrationsDir: string;
      entries: { filename: string; witnessSql: string }[];
    };
    assert.equal(plan.pluginId, '@omadia/dev-platform');
    assert.equal(plan.ledger, 'plg_omadia_dev_platform_migrations');
    assert.equal(plan.migrationsDir, 'migrations');
    assert.deepEqual(plan.entries, [...SEED_LEDGER_ENTRIES]);
  });

  it('exports the kernel-facing shape without the documentation fields', () => {
    assert.equal(SEED_LEDGER_ENTRIES.length, LEDGER_HANDOFF_ENTRIES.length);
    for (const entry of SEED_LEDGER_ENTRIES) {
      assert.deepEqual(Object.keys(entry).sort(), ['filename', 'witnessSql']);
    }
  });
});
