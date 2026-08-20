/**
 * `activate()` — the preconditions, the refusals, and the symmetry of
 * registration and disposal.
 *
 * ## Why a fake context and not a real host
 *
 * The thing worth testing here is not that Express mounts a router. It is the
 * DECISIONS: which prefixes get which auth mode, whether a refusal fires before
 * anything is registered, and whether `close()` gives back exactly what
 * `activate()` took. A recording double makes all four observable; a real host
 * would make none of them observable without reaching into its internals.
 *
 * ## The disposal assertion is the one with history
 *
 * `#470` B2: `ServiceRegistry` was never disposed on deactivate, so a provider
 * whose `close()` forgot left the service registered on a torn-down module and
 * the next install threw `duplicate provider`. The kernel-side fix only works if
 * plugins actually hand their disposers back — which is a property of THIS file,
 * not of the kernel. So the count is asserted both ways: everything registered
 * is disposed, and a PARTIAL activation disposes what it got as far as.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { activate, type DevPlatformPluginContext } from '../src/plugin.js';

interface Recorded {
  routes: Array<{ prefix: string; auth?: string; body?: string }>;
  navs: number;
  tools: number;
  jobs: string[];
  status: Array<{ status: string; message?: string }>;
  logs: string[];
  disposed: number;
  migrationsRun: number;
}

function makeCtx(over: {
  answers?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  noPool?: boolean;
  noSql?: boolean;
  readOnlySecrets?: boolean;
}): { ctx: DevPlatformPluginContext; rec: Recorded } {
  const rec: Recorded = {
    routes: [],
    navs: 0,
    tools: 0,
    toolNames: [] as string[],
    toolSpecs: [] as { name: string; hasHandler: boolean; hasPromptDoc: boolean }[],
    jobs: [],
    status: [],
    logs: [],
    disposed: 0,
    migrationsRun: 0,
  };
  const dispose = () => {
    rec.disposed += 1;
  };
  const caps: Record<string, unknown> = { ...(over.capabilities ?? {}) };
  if (!over.noPool && !('graphPool' in caps)) caps['graphPool'] = fakePool();

  const ctx: DevPlatformPluginContext = {
    agentId: '@omadia/dev-platform',
    secrets: {
      get: async () => undefined,
      keys: async () => [],
      ...(over.readOnlySecrets ? {} : { set: async () => undefined, delete: async () => undefined }),
    },
    config: { get: <T,>(k: string) => (over.answers ?? {})[k] as T | undefined },
    services: {
      get: <T,>(n: string) => caps[n] as T | undefined,
      has: (n: string) => n in caps,
    },
    ...(over.noSql
      ? {}
      : {
          sql: {
            ledger: 'plg_omadia_dev_platform_migrations',
            runMigrations: async () => {
              rec.migrationsRun += 1;
              return { applied: [], skipped: [], ledger: 'plg_omadia_dev_platform_migrations', durationMs: 1 };
            },
          },
        }),
    routes: {
      register: (prefix, _router, options) => {
        rec.routes.push({ prefix, ...(options?.auth ? { auth: options.auth } : {}), ...(options?.body ? { body: options.body } : {}) });
        return dispose;
      },
    },
    tools: {
      // Faithful to the kernel: `register` and `registerHandler` are two doors
      // into ONE name-keyed map, and both THROW on a name already present
      // (harness-orchestrator/src/nativeToolRegistry.ts:148, :198). The previous
      // stub accepted anything and returned a disposer, which is why it stayed
      // green while activate() double-registered every tool and died on the
      // first one against a real core.
      register: (spec, handler, options) => {
        if (rec.toolNames.includes(spec.name)) {
          throw new Error(`NativeToolRegistry: duplicate native-tool name '${spec.name}'`);
        }
        rec.toolNames.push(spec.name);
        rec.toolSpecs.push({
          name: spec.name,
          hasHandler: typeof handler === 'function',
          hasPromptDoc: options?.promptDoc !== undefined,
        });
        rec.tools += 1;
        return dispose;
      },
      registerHandler: (name, handler) => {
        if (rec.toolNames.includes(name)) {
          throw new Error(`NativeToolRegistry: duplicate native-tool name '${name}'`);
        }
        rec.toolNames.push(name);
        rec.toolSpecs.push({ name, hasHandler: typeof handler === 'function', hasPromptDoc: false });
        rec.tools += 1;
        return dispose;
      },
    },
    uiRoutes: {
      registerNav: () => {
        rec.navs += 1;
        return dispose;
      },
    },
    jobs: {
      register: (spec) => {
        rec.jobs.push(spec.name);
        return dispose;
      },
    },
    status: { report: (status, message) => rec.status.push({ status, ...(message ? { message } : {}) }) },
    log: (...args) => rec.logs.push(args.map(String).join(' ')),
  };
  return { ctx, rec };
}

/** Enough of `pg.Pool` for assembly. Nothing here opens a socket: `activate()`
 *  constructs stores and starts loops but issues no query until a job appears,
 *  and `wired.start()`'s rehydrate short-circuits with no docker backend. */
function fakePool(): unknown {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }),
    end: async () => undefined,
  };
}

void describe('activate() preconditions', () => {
  void it('refuses without the graphPool capability, naming the fix', async () => {
    const { ctx } = makeCtx({ noPool: true });
    await assert.rejects(() => activate(ctx), /graphPool@1/);
  });

  void it('refuses when ctx.sql is absent (permission undeclared or ungranted)', async () => {
    const { ctx } = makeCtx({ noSql: true });
    await assert.rejects(() => activate(ctx), /permissions\.sql/);
  });

  void it('refuses read-only secrets rather than silently dropping credential writes', async () => {
    const { ctx } = makeCtx({ readOnlySecrets: true });
    await assert.rejects(() => activate(ctx), /runtime_write/);
  });

  void it('refuses an interlock violation BEFORE registering or migrating anything', async () => {
    const { ctx, rec } = makeCtx({ answers: { subscription_mode: true } });
    await assert.rejects(() => activate(ctx), /subscription_ack/);
    assert.equal(rec.migrationsRun, 0, 'a refused activation must not touch the schema');
    assert.equal(rec.routes.length, 0, 'a refused activation must not mount a route');
    assert.deepEqual(
      rec.status.map((s) => s.status),
      ['error'],
      'the operator must see the refusal on the plugin card, not only in a log',
    );
  });
});

void describe('activate() registrations', () => {
  void it('runs migrations before mounting anything', async () => {
    const { ctx, rec } = makeCtx({});
    const handle = await activate(ctx);
    assert.equal(rec.migrationsRun, 1);
    await handle.close();
  });

  void it('mounts each wire path with the auth mode its authentication actually is', async () => {
    const { ctx, rec } = makeCtx({});
    const handle = await activate(ctx);
    const byPrefix = (p: string) => rec.routes.filter((r) => r.prefix === p);

    // Admin: the session IS the authentication.
    assert.ok(byPrefix('/api/v1/admin/dev-platform').length >= 3);
    for (const r of byPrefix('/api/v1/admin/dev-platform')) assert.equal(r.auth, 'session');

    // Runner: per-job bearer token inside the router. `'public'` would be a lie
    // about a surface that does authenticate; `'session'` would lock out the
    // runner, which has no session.
    const runner = byPrefix('/api/v1/dev-runner')[0];
    assert.equal(runner?.auth, 'custom');
    assert.equal(runner?.body, 'none', 'the router owns its per-endpoint parsers and proxies the LLM stream');

    // Webhook: HMAC over the RAW bytes. G3 exists for exactly this.
    const hook = byPrefix('/api/webhooks/github')[0];
    assert.equal(hook?.auth, 'custom');
    assert.equal(hook?.body, 'raw');

    // GitHub App callback: kernel-signed state token, no session.
    assert.equal(byPrefix('/api/v1/dev-platform')[0]?.auth, 'custom');
    await handle.close();
  });

  void it('registers no webhook route at all when the operator disabled webhooks', async () => {
    const { ctx, rec } = makeCtx({ answers: { webhooks_enabled: false } });
    const handle = await activate(ctx);
    assert.equal(rec.routes.filter((r) => r.prefix === '/api/webhooks/github').length, 0);
    await handle.close();
  });

  void it('registers the nav entry PR #536 wired temporarily from index.ts', async () => {
    const { ctx, rec } = makeCtx({});
    const handle = await activate(ctx);
    assert.equal(rec.navs, 1);
    await handle.close();
  });

  void it('registers the retention cron at core’s schedule', async () => {
    const { ctx, rec } = makeCtx({});
    const handle = await activate(ctx);
    assert.deepEqual(rec.jobs, ['dev-retention']);
    await handle.close();
  });

  void it('does NOT register chat tools without turnContext — refusing beats always-refusing', async () => {
    const { ctx, rec } = makeCtx({});
    const handle = await activate(ctx);
    assert.equal(rec.tools, 0);
    assert.ok(rec.logs.some((l) => l.includes('turnContext')));
    await handle.close();
  });

  void it('registers the three chat tools when turnContext resolves', async () => {
    const { ctx, rec } = makeCtx({
      capabilities: { graphPool: fakePool(), turnContext: { current: () => ({ userId: 'u1' }) } },
    });
    const handle = await activate(ctx);
    assert.equal(rec.tools, 3, 'dev_job_start / dev_job_status / dev_job_list');
    assert.deepEqual(rec.toolNames, ['dev_job_start', 'dev_job_status', 'dev_job_list']);
    await handle.close();
  });

  void it('registers each chat tool EXACTLY once, with a handler and a promptDoc', async () => {
    // P5 acceptance run. activate() called BOTH `ctx.tools.registerHandler(...)`
    // and `ctx.tools.register(...)` per tool. They are alternative doors into
    // one name-keyed kernel map and both throw on duplicate, so against a real
    // core the first tool threw `duplicate native-tool name 'dev_job_start'`,
    // activate() rolled back, and the plugin served NOTHING while the installed
    // registry still read `status: active`.
    //
    // Three properties, because the count alone would also pass if the plugin
    // registered three handler-only entries with no spec — which is the other
    // half of what was wrong (`register(reg.spec)` passed no handler at all).
    const { ctx, rec } = makeCtx({
      capabilities: { graphPool: fakePool(), turnContext: { current: () => ({ userId: 'u1' }) } },
    });
    const handle = await activate(ctx);
    assert.equal(new Set(rec.toolNames).size, rec.toolNames.length, 'a name was registered twice');
    for (const t of rec.toolSpecs) {
      assert.ok(t.hasHandler, `${t.name} registered without a handler — dispatch would hit undefined`);
      assert.ok(t.hasPromptDoc, `${t.name} registered without its promptDoc`);
    }
    await handle.close();
  });

  void it('reports ok on the plugin card when everything came up', async () => {
    const { ctx, rec } = makeCtx({});
    const handle = await activate(ctx);
    assert.deepEqual(rec.status.map((s) => s.status), ['ok']);
    await handle.close();
  });
});

void describe('close() symmetry (#470 B2)', () => {
  void it('disposes exactly what activate() registered', async () => {
    const { ctx, rec } = makeCtx({
      capabilities: { graphPool: fakePool(), turnContext: { current: () => ({ userId: 'u1' }) } },
    });
    const handle = await activate(ctx);
    const registered =
      rec.routes.length + rec.navs + rec.jobs.length + rec.tools; /* one register() per tool */
    rec.disposed = 0;
    await handle.close();
    assert.ok(
      rec.disposed >= registered,
      `disposed ${String(rec.disposed)} of ${String(registered)} registrations — a leaked handle is exactly bug B2`,
    );
  });

  void it('a failed activation rolls back the registrations it already made', async () => {
    // Fail at the LAST step the plugin controls: migrations succeed, routes
    // mount, then the nav registration throws. Everything up to that point must
    // come back off.
    const { ctx, rec } = makeCtx({});
    const boom = new Error('nav registry exploded');
    (ctx as { uiRoutes: { registerNav: () => never } }).uiRoutes = {
      registerNav: () => {
        throw boom;
      },
    };
    await assert.rejects(() => activate(ctx), /nav registry exploded/);
    assert.ok(rec.routes.length > 0, 'the test is meaningless if nothing was registered before the throw');
    assert.ok(rec.disposed >= rec.routes.length, 'a partial activation must not leave routes mounted');
    assert.deepEqual(rec.status.map((s) => s.status), ['error']);
  });
});
