/**
 * The migrations shipped as `.js` must carry the SAME SQL core shipped as
 * `.sql` — byte for byte.
 *
 * ## Why this is the load-bearing test of the whole port
 *
 * Slots `0022`–`0030` are ALREADY APPLIED on every existing installation, from
 * core's ledger. C11 seeds this plugin's ledger from those donor rows BY
 * FILENAME with a per-file schema witness; the plugin then reports them
 * `skipped` and never runs them again.
 *
 * That handoff is safe only while the two files say the same thing. If the
 * codegen dropped a constraint, folded a comment into a statement, or lost a
 * character to template-literal escaping, the drift would be INVISIBLE: the
 * ledger says applied, the plugin says skipped, and nothing ever compares the
 * bytes. A fresh install would then end up with a different schema than an
 * upgraded one — the worst kind of divergence, because both look healthy.
 *
 * ## The oracle hashes what POSTGRES would receive
 *
 * Not the file, and not an un-escaped copy of the file. The test imports each
 * module and runs it against a recording client, so what is hashed is the exact
 * string the migration passes to `client.query` — after every template-literal
 * escape has already been resolved by the JavaScript engine. An escaping bug
 * cannot hide behind a symmetrical un-escape in the test, because the test does
 * not un-escape anything.
 *
 * `migrations/checksums.json` holds the SHA-256 of each ORIGINAL core `.sql`,
 * committed at codegen time, so this needs no core checkout and is a real
 * oracle in CI rather than a skip.
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const checksums = JSON.parse(readFileSync(join(migrationsDir, 'checksums.json'), 'utf8')) as Record<
  string,
  string
>;

/** The nine dev-platform slots, in core's contiguous range. */
const EXPECTED_SQL_FILES = [
  '0022_dev_platform.sql',
  '0023_dev_platform_pipeline.sql',
  '0024_dev_platform_w3.sql',
  '0025_dev_jobs_source_plugin.sql',
  '0026_dev_job_gate_kind.sql',
  '0027_dev_platform_triggers.sql',
  '0028_dev_jobs_webhook_one_active.sql',
  '0029_dev_platform_retention.sql',
  '0030_dev_job_events_truncated_marker.sql',
];

const BEGIN = '/*__OMADIA_SQL_BEGIN__*/';
const END = '/*__OMADIA_SQL_END__*/';

/** Run one migration against a recording client and return every statement it
 *  issued. The client is deliberately dumb: a migration that reached for
 *  anything beyond `query` would throw here rather than pass. */
async function runRecording(jsName: string): Promise<string[]> {
  const mod = (await import(join(migrationsDir, jsName))) as { default?: unknown };
  assert.equal(typeof mod.default, 'function', `${jsName} must \`export default async (client) => { … }\``);
  const issued: string[] = [];
  await (mod.default as (c: { query: (sql: string) => Promise<unknown> }) => Promise<void>)({
    query: async (sql: string) => {
      issued.push(sql);
      return undefined;
    },
  });
  return issued;
}

/** Strip the sentinels the codegen wraps the payload in. They are SQL comments,
 *  so they are inert in Postgres — they exist purely so this test can find the
 *  payload without depending on the module's surrounding formatting. */
function payloadOf(statement: string): string {
  const begin = statement.indexOf(BEGIN);
  const end = statement.lastIndexOf(END);
  assert.ok(begin >= 0 && end > begin, 'SQL sentinels missing — regenerate with scripts/codegen-migrations.mjs');
  return statement.slice(begin + BEGIN.length, end);
}

void describe("codegen'd migrations", () => {
  void it('ships exactly the nine dev-platform slots, filenames preserved', () => {
    const shipped = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.js'))
      .sort();
    assert.deepEqual(
      shipped,
      EXPECTED_SQL_FILES.map((f) => f.replace(/\.sql$/, '.js')),
      'no renumbering: the ledger is keyed by filename and C11 seeds it from core’s donor rows by that key',
    );
    assert.deepEqual(Object.keys(checksums).sort(), [...EXPECTED_SQL_FILES].sort());
  });

  for (const sqlName of EXPECTED_SQL_FILES) {
    const jsName = sqlName.replace(/\.sql$/, '.js');

    void it(`${jsName} sends the byte-identical SQL of ${sqlName}`, async () => {
      const issued = await runRecording(jsName);
      assert.equal(
        issued.length,
        1,
        'the whole file must reach the client in ONE query — splitting it would change transactional grouping',
      );
      const sql = payloadOf(issued[0] ?? '');
      const actual = createHash('sha256').update(sql, 'utf8').digest('hex');
      assert.equal(
        actual,
        checksums[sqlName],
        `SQL drift in ${jsName}. The plugin would create a different schema than the one already applied from ` +
          `core's ledger, and C11's filename seeding would hide it. Re-run \`npm run codegen:migrations\` ` +
          `against a core checkout rather than editing the generated file.`,
      );
    });
  }

  void it('the payload is never empty (a codegen that silently emitted nothing)', async () => {
    for (const sqlName of EXPECTED_SQL_FILES) {
      const issued = await runRecording(sqlName.replace(/\.sql$/, '.js'));
      assert.ok(payloadOf(issued[0] ?? '').trim().length > 100, `${sqlName} payload is suspiciously small`);
    }
  });
});
