/**
 * Epic byte5ai/omadia#470 P4 — decision D3, the uninstall data lifecycle.
 *
 * ## The decision this file implements
 *
 * **Deactivate and uninstall NEVER drop a table.** `activate()`'s `close()`
 * disposes routes, tools, nav and background loops; it touches no schema. A
 * reinstall must be lossless — an operator who removes the plugin to upgrade it,
 * or to try a fork, gets every job, repo, gate and artifact back.
 *
 * That leaves a real question unanswered rather than answered wrongly: an
 * operator who is genuinely done with the dev platform is left with nine tables
 * of rows they did not ask to keep. So the destructive path exists — as a
 * SEPARATE, explicit, type-to-confirm route that an operator has to mean.
 *
 * ## Why type-to-confirm rather than a flag
 *
 * `DELETE /…?force=true` is one stray curl from unrecoverable. Requiring the
 * body to carry the plugin's own id means the request cannot be produced by
 * accident, cannot be replayed from a URL, and cannot be reached by a CSRF form
 * post that does not already know what it is destroying. It is the same shape
 * GitHub uses to delete a repository, for the same reason.
 *
 * ## Ordering, and why it is one transaction
 *
 * `dev_job_events` and `dev_job_artifacts` cascade from `dev_jobs` (migration
 * 0022), but the drop does not rely on that: `DROP TABLE … CASCADE` on a partial
 * list would silently take dependent objects with it, and a half-dropped schema
 * is worse than either outcome — the plugin then activates, runs its migrations
 * against a database that has some of its tables, and the ledger says they are
 * all present. One transaction, all ten objects (nine tables + the ledger), or
 * none.
 *
 * The LEDGER goes too. Dropping the tables while keeping
 * `plg_omadia_dev_platform_migrations` populated is the single worst end state
 * available here: the next activation reads a full ledger, applies nothing, and
 * the plugin comes up believing in nine tables that do not exist.
 */

import { Router, json as expressJson } from 'express';
import type { Request, Response } from 'express';

import type { Pool } from 'pg';

import { DEV_PLATFORM_PLUGIN_ID } from '../pluginIdentity.js';

/**
 * Every table migrations 0022–0030 create, in DEPENDENCY ORDER (children first).
 *
 * Written out rather than discovered from `information_schema` by prefix: a
 * `dev_%` LIKE query would also match a table some future plugin or an operator
 * happened to name that way, and this is the one route in the plugin where
 * being approximately right is unrecoverable. `test/devPlatformPurge.test.ts`
 * cross-checks this list against the migration files, so a tenth table cannot be
 * added without either updating this list or failing the suite.
 */
export const DEV_PLATFORM_TABLES: readonly string[] = [
  // `dev_job_gates` FIRST: besides `dev_jobs` it also references
  // `dev_job_artifacts` (`plan_artifact_id`, migration 0026). The obvious
  // reading — "artifacts and events and gates are all children of dev_jobs, so
  // any order among them works" — is wrong, and it is wrong in a way that only
  // a real database reports: `cannot drop table dev_job_artifacts because other
  // objects depend on it`. The pg case in `test/devPlatformPurge.test.ts` is
  // what found it.
  'dev_job_gates',
  'dev_job_events',
  'dev_job_artifacts',
  'dev_webhook_deliveries',
  'dev_repo_plugin_grants',
  'dev_github_app_installations',
  'dev_github_apps',
  // Self-referencing (`parent_job_id`), which a plain DROP handles fine.
  'dev_jobs',
  'dev_repos',
];

/** The migration ledger, as declared in `manifest.yaml`'s `permissions.sql`. */
export const DEV_PLATFORM_LEDGER = 'plg_omadia_dev_platform_migrations';

export interface DevPlatformPurgeDeps {
  pool: Pool;
  /** The string the operator must type. Defaults to the plugin id. */
  confirmPhrase?: string;
  log?: (msg: string) => void;
}

/** What the route reports back, and what the tests assert on. */
export interface PurgeOutcome {
  dropped: readonly string[];
  ledger: string;
}

/**
 * Drop the plugin's schema in ONE transaction.
 *
 * Exported separately from the route so the destructive step can be tested
 * against a real database without going through express, and so an operator
 * script could call it directly.
 */
export async function purgeDevPlatformSchema(pool: Pool): Promise<PurgeOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of DEV_PLATFORM_TABLES) {
      // No CASCADE. The list is complete and correctly ordered, so a plain DROP
      // succeeds — and if it ever does NOT, that means something outside this
      // plugin depends on its tables. CASCADE would destroy that something
      // silently; failing the transaction reports it instead.
      await client.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await client.query(`DROP TABLE IF EXISTS "${DEV_PLATFORM_LEDGER}"`);
    await client.query('COMMIT');
    return { dropped: DEV_PLATFORM_TABLES, ledger: DEV_PLATFORM_LEDGER };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * `POST /admin/purge` — mounted under the admin prefix, so its full path is
 * `/api/v1/admin/dev-platform/admin/purge`.
 *
 * Registered with `auth: 'session'` like the rest of the admin surface. The
 * handler re-reads `req.session` anyway: the admin prefix is the one surface
 * whose ONLY authentication is the session, and this is the one route on it
 * whose blast radius is the whole schema. A wiring mistake must fail closed
 * here too, not only one layer up.
 */
export function createDevPlatformPurgeRouter(deps: DevPlatformPurgeDeps): Router {
  const router = Router();
  // A tiny body — nothing but the confirmation phrase. The cap is deliberate:
  // an unauthenticated flood cannot make this route buffer anything.
  router.use(expressJson({ limit: '1kb' }));
  const log = deps.log ?? ((): void => {});
  const confirmPhrase = deps.confirmPhrase ?? DEV_PLATFORM_PLUGIN_ID;

  router.post('/admin/purge', (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      const session = req.session;
      const sub = typeof session?.sub === 'string' ? session.sub : '';
      if (!sub) {
        res.status(401).json({ code: 'devplatform.unauthorized', message: 'no session' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const confirm = body['confirm'];
      if (confirm !== confirmPhrase) {
        // 400, not 403: the caller IS allowed to do this, they just have not
        // said so. The message names the exact phrase because a confirmation
        // nobody can satisfy is a broken route, not a safe one.
        res.status(400).json({
          code: 'devplatform.purge_not_confirmed',
          message:
            `This permanently drops ${String(DEV_PLATFORM_TABLES.length)} tables and the migration ` +
            `ledger. Every dev job, repository, gate and artifact is destroyed and cannot be ` +
            `recovered by reinstalling. To proceed, send {"confirm": "${confirmPhrase}"}.`,
        });
        return;
      }

      try {
        const outcome = await purgeDevPlatformSchema(deps.pool);
        log(
          `[dev-platform] PURGED by ${sub}: dropped ${String(outcome.dropped.length)} table(s) ` +
            `and the ledger '${outcome.ledger}'`,
        );
        res.status(200).json(outcome);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[dev-platform] purge FAILED for ${sub}: ${message}`);
        res.status(500).json({ code: 'devplatform.purge_failed', message });
      }
    })();
  });

  return router;
}
