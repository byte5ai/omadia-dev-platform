/**
 * Epic byte5ai/omadia#470 P4 — decision D3.
 *
 * Two things are proven here, and the second matters more than the first:
 *
 *  1. The purge route drops the schema when — and only when — the operator
 *     types the plugin id.
 *  2. Nothing ELSE in the plugin drops anything. `close()` is the uninstall
 *     path, and an uninstall that quietly took the data with it would pass every
 *     other test in this repo.
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { describe, it, before, after } from 'node:test';

import express from 'express';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';
import { coreMigrationsDir, runMultiOrchestratorMigrations } from './_helpers/coreSchema.js';
import { listenLoopback } from './_helpers/listenLoopback.js';
import {
  DEV_PLATFORM_LEDGER,
  DEV_PLATFORM_TABLES,
  createDevPlatformPurgeRouter,
  purgeDevPlatformSchema,
} from '../src/routes/devPlatformPurge.js';
import { DEV_PLATFORM_PLUGIN_ID } from '../src/pluginIdentity.js';

const pkgRoot = resolve(process.cwd());

// ---------------------------------------------------------------------------
// The table list is an oracle, so it needs its own oracle.
// ---------------------------------------------------------------------------

void describe('DEV_PLATFORM_TABLES — the list matches the migrations', () => {
  void it('names every table the nine migrations create, and nothing else', async () => {
    // A hand-written list of things to DROP is exactly the kind of constant that
    // rots silently: a tenth table added in migration 0031 would simply survive
    // every purge, and the operator who asked for their data to be gone would
    // never learn otherwise. Derive the truth from the migrations themselves.
    const dir = resolve(pkgRoot, 'migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.js')).sort();
    assert.ok(files.length > 0, 'found migration files to read');

    const created = new Set<string>();
    for (const f of files) {
      const raw = await readFile(resolve(dir, f), 'utf8');
      // Strip SQL and JS comments FIRST. `0024_dev_platform_w3.js` contains the
      // prose "…CREATE TABLE IF NOT EXISTS), safe to re-run." — the optional
      // `IF NOT EXISTS` group matched, then hit `)` where a name should be,
      // backtracked, skipped the group, and captured `IF` as a table. Grep the
      // executable SQL, not the commentary about it.
      const body = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*--.*$/gm, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const m of body.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
        if (m[1]) created.add(m[1]);
      }
    }

    assert.deepEqual(
      [...DEV_PLATFORM_TABLES].sort(),
      [...created].sort(),
      'the purge list and the migrations disagree — a table would survive a purge, or a DROP would ' +
        'name something this plugin does not own',
    );
  });

  void it('lists children before parents', async () => {
    // `purgeDevPlatformSchema` deliberately does NOT use CASCADE, so ordering is
    // load-bearing rather than cosmetic. `dev_job_*` reference `dev_jobs`, which
    // references `dev_repos`.
    const idx = (t: string): number => DEV_PLATFORM_TABLES.indexOf(t);
    for (const child of ['dev_job_artifacts', 'dev_job_events', 'dev_job_gates']) {
      assert.ok(idx(child) < idx('dev_jobs'), `${child} must be dropped before dev_jobs`);
    }
    assert.ok(idx('dev_jobs') < idx('dev_repos'), 'dev_jobs must be dropped before dev_repos');
    // The edge the first draft of this list missed. `dev_job_gates` is not only
    // a child of `dev_jobs` — `plan_artifact_id` points at `dev_job_artifacts`
    // (migration 0026), so the two sibling-looking children are ordered too.
    assert.ok(
      idx('dev_job_gates') < idx('dev_job_artifacts'),
      'dev_job_gates references dev_job_artifacts.plan_artifact_id and must be dropped first',
    );
    assert.ok(
      idx('dev_repo_plugin_grants') < idx('dev_repos'),
      'dev_repo_plugin_grants must be dropped before dev_repos',
    );
    assert.ok(
      idx('dev_github_app_installations') < idx('dev_github_apps'),
      'dev_github_app_installations must be dropped before dev_github_apps',
    );
  });

  void it('drops the migration ledger too', () => {
    // Dropping the tables and keeping a populated ledger is the worst available
    // end state: the next activation applies nothing and comes up believing in
    // nine tables that no longer exist.
    assert.equal(DEV_PLATFORM_LEDGER, 'plg_omadia_dev_platform_migrations');
  });
});

// ---------------------------------------------------------------------------
// The route's gate, with no database involved.
// ---------------------------------------------------------------------------

/** Mount the purge router behind a session double, like the kernel does. */
async function mountPurge(opts: {
  session?: Record<string, string>;
  pool?: unknown;
}): Promise<{ url: string; close: () => Promise<void>; purged: () => number }> {
  let purgeCalls = 0;
  const app = express();
  app.use((req, _res, next) => {
    if (opts.session) (req as unknown as { session?: unknown }).session = opts.session;
    next();
  });
  const fakePool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (/^DROP TABLE/i.test(sql)) purgeCalls += 1;
        return { rows: [] };
      },
      release: () => undefined,
    }),
  };
  app.use(
    createDevPlatformPurgeRouter({
      pool: (opts.pool ?? fakePool) as Pool,
      log: () => {},
    }),
  );
  const server = await listenLoopback(app);
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url,
    purged: () => purgeCalls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const SESSION = { sub: 'operator-1', email: 'op@example.com', role: 'admin' };

void describe('POST /admin/purge — the gate', () => {
  void it('401s with no session, and drops nothing', async () => {
    const m = await mountPurge({});
    try {
      const res = await fetch(`${m.url}/admin/purge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: DEV_PLATFORM_PLUGIN_ID }),
      });
      assert.equal(res.status, 401);
      assert.equal(m.purged(), 0, 'an unauthenticated request must never reach a DROP');
    } finally {
      await m.close();
    }
  });

  for (const [label, body] of [
    ['an empty body', {}],
    ['a missing confirm', { other: 'x' }],
    ['the wrong phrase', { confirm: 'dev-platform' }],
    ['a near miss', { confirm: '@omadia/dev-platform ' }],
    ['a truthy non-string', { confirm: true }],
    ['a boolean force flag instead', { force: true }],
  ] as const) {
    void it(`400s on ${label}, and drops nothing`, async () => {
      const m = await mountPurge({ session: SESSION });
      try {
        const res = await fetch(`${m.url}/admin/purge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 400);
        const json = (await res.json()) as { code: string; message: string };
        assert.equal(json.code, 'devplatform.purge_not_confirmed');
        // The refusal must name the phrase — a confirmation nobody can satisfy
        // is a broken route, not a safe one.
        assert.match(json.message, /@omadia\/dev-platform/);
        assert.equal(m.purged(), 0);
      } finally {
        await m.close();
      }
    });
  }

  void it('proceeds on the exact phrase', async () => {
    const m = await mountPurge({ session: SESSION });
    try {
      const res = await fetch(`${m.url}/admin/purge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: DEV_PLATFORM_PLUGIN_ID }),
      });
      assert.equal(res.status, 200);
      const json = (await res.json()) as { dropped: string[]; ledger: string };
      assert.deepEqual(json.dropped, [...DEV_PLATFORM_TABLES]);
      assert.equal(json.ledger, DEV_PLATFORM_LEDGER);
      // Nine tables + the ledger.
      assert.equal(m.purged(), DEV_PLATFORM_TABLES.length + 1);
    } finally {
      await m.close();
    }
  });

  void it('reports a failure rather than claiming success', async () => {
    const explodingPool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (/^DROP TABLE/i.test(sql)) throw new Error('dependent view still exists');
          return { rows: [] };
        },
        release: () => undefined,
      }),
    };
    const m = await mountPurge({ session: SESSION, pool: explodingPool });
    try {
      const res = await fetch(`${m.url}/admin/purge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: DEV_PLATFORM_PLUGIN_ID }),
      });
      assert.equal(res.status, 500);
      const json = (await res.json()) as { code: string; message: string };
      assert.equal(json.code, 'devplatform.purge_failed');
      assert.match(json.message, /dependent view/);
    } finally {
      await m.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Nothing else drops anything.
// ---------------------------------------------------------------------------

void describe('D3 — deactivate never drops', () => {
  void it('no source file outside the purge module issues a DROP TABLE', async () => {
    // THE decision, asserted rather than trusted to review. `close()` disposes
    // registrations; a DROP appearing anywhere else — in a retention sweep, in a
    // migration rollback, in a "clean up on uninstall" helper — would make
    // reinstall lossy, and every other test here would still pass.
    const srcRoot = resolve(pkgRoot, 'src');
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (abs.endsWith(`routes/devPlatformPurge.ts`)) continue;
        const body = await readFile(abs, 'utf8');
        // Strip line and block comments: this module's own decision is
        // documented in prose elsewhere, and prose must not trip the check.
        const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/\bDROP\s+TABLE\b/i.test(code)) offenders.push(abs.slice(srcRoot.length + 1));
      }
    };
    await walk(srcRoot);
    assert.deepEqual(
      offenders,
      [],
      'only the type-to-confirm purge route may drop a table (epic #470 D3)',
    );
  });
});

// ---------------------------------------------------------------------------
// Against a real database.
// ---------------------------------------------------------------------------

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'devPlatformPurge',
  vars: ['DEV_PLATFORM_PG_TEST_URL', 'GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
});

void describe('purgeDevPlatformSchema — against Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
    await runMultiOrchestratorMigrations(pool, undefined, coreMigrationsDir());
  });

  after(async () => {
    await pool?.end().catch(() => undefined);
  });

  void it('leaves no dev_* table and no ledger behind', async () => {
    const present = async (): Promise<string[]> => {
      const r = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = current_schema()
            AND (tablename = ANY($1::text[]) OR tablename = $2)
          ORDER BY tablename`,
        [[...DEV_PLATFORM_TABLES], DEV_PLATFORM_LEDGER],
      );
      return r.rows.map((x) => x.tablename);
    };

    // The migrations just ran, so everything is here — asserted, because a purge
    // test that starts from an empty schema proves nothing at all.
    const before = await present();
    assert.equal(
      before.length,
      DEV_PLATFORM_TABLES.length + 1,
      `expected all tables + ledger before the purge, saw: ${before.join(', ')}`,
    );

    await purgeDevPlatformSchema(pool);
    assert.deepEqual(await present(), [], 'the purge left something behind');

    // And the schema can be rebuilt from scratch afterwards — the purge must
    // leave a database the plugin can reinstall into, not a poisoned one.
    await runMultiOrchestratorMigrations(pool, undefined, coreMigrationsDir());
    assert.equal((await present()).length, DEV_PLATFORM_TABLES.length + 1, 'reinstall failed after purge');
  });
});
