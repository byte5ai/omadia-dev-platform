/**
 * SEAM (test-only) — was `runMultiOrchestratorMigrations` from
 * `@omadia/orchestrator`.
 *
 * Fifteen pg suites call it to stand the BASE schema up before the
 * dev-platform tables are created. That is not incidental: migrations
 * `0022`–`0030` reference tables core's `0001`–`0021` create, so a bare database
 * cannot run this plugin's schema at all.
 *
 * `@omadia/orchestrator` is a private core workspace package, so the plugin
 * cannot depend on it — but the WORK it does is simply "apply
 * `middleware/migrations/*.sql` in filename order, once each, under a ledger".
 * This helper does exactly that against a core checkout, and it applies ONLY the
 * files below this plugin's own range: the plugin's nine are applied by
 * `ctx.sql.runMigrations()` in production and by `applyPluginMigrations()` here,
 * and running them twice from two ledgers is precisely the divergence C11's
 * witness-based seeding exists to prevent.
 *
 * When no core checkout is reachable the suites skip LOUDLY, the same
 * convention `pgTestDb.ts` uses for a missing database (issue #572): a skipped
 * suite must never read as a silently-passing one.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Pool } from 'pg';

/**
 * The package root.
 *
 * Deliberately `process.cwd()` and NOT `import.meta.url`: `scripts/test.mjs`
 * BUNDLES each suite with esbuild, so this helper's `import.meta.url` is the
 * bundle's location in `.test-build/`, not this file's. Every `../..` written
 * against the source layout then resolves one directory too high — silently,
 * and only for the suites that need a path. The runner sets `cwd` to the
 * package root precisely so there is one stable anchor.
 */
const pkgRoot = process.cwd();

/** Core's own ledger table name — unchanged, so a database seeded by this
 *  helper is indistinguishable from one core migrated itself. */
const CORE_LEDGER = '_multi_orchestrator_migrations';

/** The plugin's own slots. Applied by the plugin, never by this helper. */
const PLUGIN_MIGRATION_RANGE = /^00(2[2-9]|30)_/;

/** Session-scoped advisory-lock key serialising concurrent suite bootstraps. */
const MIGRATION_LOCK_KEY = 470_0022;

/** Resolve a core checkout's `middleware/migrations` directory, or undefined.
 *  `OMADIA_CORE_DIR` first, then the committed sibling default. */
export function coreMigrationsDir(): string | undefined {
  const candidates = [
    process.env['OMADIA_CORE_DIR'],
    resolve(pkgRoot, '..', '..', '..', 'odoo-bot'),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  for (const c of candidates) {
    const dir = join(resolve(c), 'middleware', 'migrations');
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

/**
 * Apply core's base migrations. Drop-in for `runMultiOrchestratorMigrations`,
 * minus the advisory lock — a test database has exactly one writer, and adding
 * a lock here would only be ceremony.
 */
export async function runMultiOrchestratorMigrations(
  pool: Pool,
  log: (msg: string) => void = () => undefined,
  migrationsDir: string | undefined = coreMigrationsDir(),
): Promise<void> {
  await runCoreMigrations(pool, log, migrationsDir);
  // Then the plugin's own nine, from the SHIPPED `.js` artifacts — so a pg
  // suite exercises what the ZIP contains, not the `.sql` it was generated
  // from. Under core one call did both halves because `0022`-`0030` sat in the
  // same directory; they are this package's now, and fourteen call sites should
  // not each have to learn that.
  await applyPluginMigrations(pool);
}

async function runCoreMigrations(
  pool: Pool,
  log: (msg: string) => void,
  migrationsDir: string | undefined,
): Promise<void> {
  if (!migrationsDir) {
    throw new Error(
      'core migrations not found — set OMADIA_CORE_DIR to a byte5ai/omadia checkout. ' +
        'The dev-platform schema builds on core tables 0001-0021 and cannot be created without them.',
    );
  }
  const client = await pool.connect();
  let lockHeld = false;
  try {
    // The advisory lock is NOT ceremony here, which is what I first assumed.
    // `node --test` runs suite FILES in parallel, so a dozen of them race to
    // create the same types against one database and lose with
    // `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`.
    // That is bug B3 from `implementation.md` reproduced inside the test
    // harness — core's migrator holds this lock for exactly this reason.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    lockHeld = true;
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${CORE_LEDGER} (
         id TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const applied = new Set(
      (await client.query<{ id: string }>(`SELECT id FROM ${CORE_LEDGER}`)).rows.map((r) => r.id),
    );
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => !PLUGIN_MIGRATION_RANGE.test(f))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      log(`[core-schema] applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO ${CORE_LEDGER} (id) VALUES ($1)`, [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    if (lockHeld) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    client.release();
  }
}

/**
 * Apply the PLUGIN's nine codegen'd migrations, through the same ledger shape
 * `ctx.sql.runMigrations()` uses in production — so a pg suite exercises the
 * artifact that actually ships, not the `.sql` it was generated from.
 */
export async function applyPluginMigrations(
  pool: Pool,
  ledger = 'plg_omadia_dev_platform_migrations',
): Promise<string[]> {
  const dir = resolve(pkgRoot, 'migrations');
  const client = await pool.connect();
  const applied: string[] = [];
  let lockHeld = false;
  try {
    // Same reason as the core half: `node --test` runs suite files in parallel,
    // and two of them creating `dev_jobs` at once lose on a unique index rather
    // than on anything that names the real problem.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY + 1]);
    lockHeld = true;
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${ledger}" (
         filename TEXT PRIMARY KEY,
         checksum TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await client.query<{ filename: string }>(`SELECT filename FROM "${ledger}"`)).rows.map(
        (r) => r.filename,
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.js')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const mod = (await import(`${join(dir, file)}`)) as {
        default: (c: { query: (sql: string) => Promise<unknown> }) => Promise<void>;
      };
      await client.query('BEGIN');
      try {
        await mod.default(client as unknown as { query: (sql: string) => Promise<unknown> });
        await client.query(`INSERT INTO "${ledger}" (filename, checksum) VALUES ($1, $2)`, [
          file,
          createHash('sha256').update(await readFile(join(dir, file), 'utf8')).digest('hex'),
        ]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    if (lockHeld) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY + 1]);
    client.release();
  }
  return applied;
}
