/**
 * Adopting core's migration ledger — the nine witnesses. Epic #470, C11.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Slots `0022`–`0030` are already applied on every installation that ran the
 * Dev Platform inside core, recorded in CORE's ledger. This plugin's ledger
 * (`plg_omadia_dev_platform_migrations`) starts empty, so `runMigrations()`
 * would re-apply all nine. They are idempotent, so on a healthy database that
 * is merely slow — but idempotence is a property of the files, and betting an
 * upgrade on it nine times over is not a plan.
 *
 * `ctx.sql.seedLedger()` records them as applied instead. It will NOT take
 * core's word for it: each file must be backed by a WITNESS, a query against
 * the live catalog that is true only when the schema object that file creates
 * is actually there. Core's row corroborates; the witness decides.
 *
 * The case that makes this necessary is **rows present, tables absent** — a
 * database restored from a snapshot taken before the objects existed, a
 * version-skewed rollback, an operator who dropped a table during an incident.
 * A seed that trusted core's rows would activate this plugin green and make
 * every request 500. With witnesses, the seed declines and `runMigrations()`
 * applies the files, which is the repair.
 *
 * WHICH OBJECT EACH WITNESS PROVES
 * --------------------------------
 * The LAST one the file creates. Each core migration ran inside a single
 * transaction, so the last object exists exactly when the whole file was
 * applied — an earlier one could in principle be there from a half-applied
 * predecessor of the same batch. One rule, checkable by a reviewer against the
 * `.sql` in `migrations/`.
 *
 * TWO TRAPS
 * ---------
 *   - `'public.dev_jobs'::regclass` THROWS for a missing table. That is the
 *     case the witness exists to detect, so a cast turns the detection into an
 *     activation crash. Use `to_regclass`, which returns NULL, or a catalog
 *     join, which returns no rows.
 *   - `SELECT count(*) FROM t` is not a witness. It is 1 for a table that
 *     exists, 0 for one that exists and is empty, and a throw for one that does
 *     not — three readings, none of them the question being asked. The kernel
 *     enforces the shape rather than guessing: exactly one row, exactly one
 *     column, a real boolean.
 */

/** One file's claim on core's ledger, and the proof behind it. */
export interface LedgerHandoffEntry {
  /** This plugin's own filename, as shipped in `migrations/`. Core matches it
   *  to its `.sql` row by STEM — `0022_dev_platform.js` adopts
   *  `0022_dev_platform.sql`. */
  readonly filename: string;
  /** The last schema object the file creates, for the reviewer. */
  readonly proves: string;
  /** Single-row, single-column boolean SELECT. Safe on a database where the
   *  objects are missing. */
  readonly witnessSql: string;
}

/** `to_regclass` is NULL for an absent relation — never a throw. Good for
 *  tables and indexes alike; both are relations. */
function relationExists(name: string): string {
  return `SELECT to_regclass('public.${name}') IS NOT NULL`;
}

/** A catalog lookup rather than a cast, so a missing TABLE yields `false`
 *  instead of an error. */
function columnExists(table: string, column: string): string {
  return (
    'SELECT EXISTS (SELECT 1 FROM information_schema.columns ' +
    `WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}')`
  );
}

/**
 * A CHECK constraint whose definition contains a given literal.
 *
 * Joined through `pg_class`/`pg_namespace` rather than casting the table name
 * to `regclass`, for the same reason as above: on the restore this exists to
 * detect, `dev_jobs` may not be there at all.
 */
function constraintDefContains(
  table: string,
  constraint: string,
  needle: string,
): string {
  return (
    'SELECT EXISTS (SELECT 1 FROM pg_constraint c ' +
    'JOIN pg_class t ON t.oid = c.conrelid ' +
    'JOIN pg_namespace n ON n.oid = t.relnamespace ' +
    `WHERE n.nspname = 'public' AND t.relname = '${table}' AND c.conname = '${constraint}' ` +
    `AND pg_get_constraintdef(c.oid) LIKE '%''${needle}''%')`
  );
}

/**
 * The nine files, in the order they ran, each with the last object it creates.
 *
 * Cross-check against `migrations/*.js` — `ledgerHandoff.test.ts` asserts the
 * two lists are the same set, so a tenth migration added without a witness
 * fails the suite rather than silently re-running on every upgrade.
 */
export const LEDGER_HANDOFF_ENTRIES: readonly LedgerHandoffEntry[] = [
  {
    filename: '0022_dev_platform.js',
    proves: 'table dev_job_artifacts',
    witnessSql: relationExists('dev_job_artifacts'),
  },
  {
    filename: '0023_dev_platform_pipeline.js',
    proves: 'table dev_github_app_installations',
    witnessSql: relationExists('dev_github_app_installations'),
  },
  {
    filename: '0024_dev_platform_w3.js',
    proves: 'column dev_jobs.conductor_await_id',
    witnessSql: columnExists('dev_jobs', 'conductor_await_id'),
  },
  {
    // The only file whose last act neither creates a relation nor adds a
    // column: it REPLACES a CHECK constraint to admit a new `source` value. So
    // the witness reads the constraint's definition — the presence of the
    // constraint alone would be true before this migration too.
    filename: '0025_dev_jobs_source_plugin.js',
    proves: "constraint dev_jobs_source_check admitting 'plugin'",
    witnessSql: constraintDefContains('dev_jobs', 'dev_jobs_source_check', 'plugin'),
  },
  {
    filename: '0026_dev_job_gate_kind.js',
    proves: 'column dev_job_gates.gate_kind',
    witnessSql: columnExists('dev_job_gates', 'gate_kind'),
  },
  {
    filename: '0027_dev_platform_triggers.js',
    proves: 'column dev_jobs.usage_estimated',
    witnessSql: columnExists('dev_jobs', 'usage_estimated'),
  },
  {
    filename: '0028_dev_jobs_webhook_one_active.js',
    proves: 'index dev_jobs_webhook_one_active',
    witnessSql: relationExists('dev_jobs_webhook_one_active'),
  },
  {
    filename: '0029_dev_platform_retention.js',
    proves: 'index dev_jobs_terminal_ended_idx',
    witnessSql: relationExists('dev_jobs_terminal_ended_idx'),
  },
  {
    filename: '0030_dev_job_events_truncated_marker.js',
    proves: 'index dev_job_events_truncated_once_idx',
    witnessSql: relationExists('dev_job_events_truncated_once_idx'),
  },
];

/** The shape `ctx.sql.seedLedger` takes. */
export const SEED_LEDGER_ENTRIES: readonly {
  readonly filename: string;
  readonly witnessSql: string;
}[] = LEDGER_HANDOFF_ENTRIES.map((e) => ({
  filename: e.filename,
  witnessSql: e.witnessSql,
}));
