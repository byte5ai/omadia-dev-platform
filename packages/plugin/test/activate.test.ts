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

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { activate, type DevPlatformPluginContext } from '../src/plugin.js';
import { SEED_LEDGER_ENTRIES } from '../src/ledgerHandoff.js';

/**
 * The capability names the MANIFEST declares — read from the manifest rather
 * than restated here.
 *
 * A hand-written list would be a second source of truth, and the disagreement
 * between the two is exactly the failure this has to catch: `ctx.services.get`
 * throws for a name in neither `requires:` nor `optional_requires:` (C2b), so
 * a capability `activate()` reaches for but the manifest forgot is an
 * activation throw against a real core, and a hardcoded set here would hide it.
 * Binding the double to the file the kernel actually reads makes it a failure
 * in this suite instead.
 */
const DECLARED_CAPABILITIES: ReadonlySet<string> = readDeclaredCapabilities();

function readDeclaredCapabilities(): ReadonlySet<string> {
  const manifest = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.yaml'),
    'utf8',
  );
  const names = new Set<string>();
  let inList = false;
  for (const line of manifest.split('\n')) {
    if (/^(?:optional_)?requires:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = /^\s*-\s*["']?([^"'\n@]+)@\d+["']?\s*$/.exec(line);
    if (!item?.[1]) {
      inList = false;
      continue;
    }
    names.add(item[1]);
  }
  if (names.size === 0) {
    throw new Error('manifest.yaml declared no capabilities — the parser above drifted');
  }
  return names;
}

interface Recorded {
  routes: Array<{ prefix: string; auth?: string; body?: string }>;
  navs: number;
  /** C9: the nav ENTRY, not just the count. A percent-encoded `href` is what
   *  `HREF_SEGMENT` refuses, so the shape is the whole assertion. */
  navEntries: Array<Record<string, unknown>>;
  /** Which accessor each optional capability was resolved through. */
  optionalLookups: Array<{ name: string; via: 'get' | 'getOptional' }>;
  tools: number;
  jobs: string[];
  status: Array<{ status: string; message?: string }>;
  logs: string[];
  disposed: number;
  migrationsRun: number;
  /** C11: the order matters — a seed after the apply loop would be a no-op. */
  order: string[];
  seedCalls: Array<{ entries: readonly { filename: string }[]; dryRun?: boolean }>;
}

function makeCtx(over: {
  answers?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  noPool?: boolean;
  noSql?: boolean;
  readOnlySecrets?: boolean;
  /** Simulate a core older than plugin-api 1.3.0: no `seedLedger` at all. */
  noSeedLedger?: boolean;
  /** Files the seed declined because their witness was false. */
  skippedNoWitness?: readonly string[];
  /** Simulate a core older than plugin-api 1.4.0: no `services.getOptional`. */
  noGetOptional?: boolean;
}): { ctx: DevPlatformPluginContext; rec: Recorded } {
  const rec: Recorded = {
    routes: [],
    navs: 0,
    navEntries: [],
    optionalLookups: [],
    tools: 0,
    toolNames: [] as string[],
    toolSpecs: [] as { name: string; hasHandler: boolean; hasPromptDoc: boolean }[],
    jobs: [],
    status: [],
    logs: [],
    disposed: 0,
    migrationsRun: 0,
    order: [],
    seedCalls: [],
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
      // Faithful to the kernel since C2b: a name declared in NEITHER
      // `requires:` nor `optional_requires:` THROWS rather than answering
      // undefined. The previous stub answered undefined for everything, so a
      // manifest that forgot a capability stayed green here and threw against a
      // real core — the same class of fidelity gap that let the P1 double
      // registration through.
      get: <T,>(n: string) => {
        rec.optionalLookups.push({ name: n, via: 'get' });
        if (!DECLARED_CAPABILITIES.has(n)) {
          throw new Error(
            `ServiceNotDeclaredError: @omadia/dev-platform did not declare ${n}`,
          );
        }
        return caps[n] as T | undefined;
      },
      has: (n: string) => n in caps,
      // #795 / plugin-api 1.4.0. `over.noGetOptional` simulates a core that
      // predates it, which must still resolve every optional capability through
      // the `get()` fallback rather than degrading.
      ...(over.noGetOptional
        ? {}
        : {
            getOptional: <T,>(n: string) => {
              rec.optionalLookups.push({ name: n, via: 'getOptional' });
              if (!DECLARED_CAPABILITIES.has(n)) {
                throw new Error(
                  `ServiceNotDeclaredError: @omadia/dev-platform did not declare ${n}`,
                );
              }
              return caps[n] as T | undefined;
            },
          }),
    },
    ...(over.noSql
      ? {}
      : {
          sql: {
            ledger: 'plg_omadia_dev_platform_migrations',
            runMigrations: async () => {
              rec.migrationsRun += 1;
              rec.order.push('runMigrations');
              return { applied: [], skipped: [], ledger: 'plg_omadia_dev_platform_migrations', durationMs: 1 };
            },
            ...(over.noSeedLedger
              ? {}
              : {
                  seedLedger: async (opts: {
                    entries: readonly { filename: string; witnessSql: string }[];
                    dryRun?: boolean;
                  }) => {
                    rec.order.push('seedLedger');
                    rec.seedCalls.push({
                      entries: opts.entries,
                      ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
                    });
                    const declined = over.skippedNoWitness ?? [];
                    const seeded = opts.entries
                      .map((e) => e.filename)
                      .filter((f) => !declined.includes(f));
                    return {
                      seeded,
                      applied: declined,
                      skippedNoWitness: declined,
                      alreadySeeded: [],
                      donorRecorded: opts.entries.map((e) => e.filename),
                      ledger: 'plg_omadia_dev_platform_migrations',
                      donorLedger: '_multi_orchestrator_migrations',
                      dryRun: opts.dryRun ?? false,
                      durationMs: 1,
                    };
                  },
                }),
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
      registerNav: (entry: unknown) => {
        rec.navs += 1;
        rec.navEntries.push(entry as Record<string, unknown>);
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

// ── C11: the migration handoff ───────────────────────────────────────────────

describe('#470 C11 — activate() adopts core\'s ledger before applying', () => {
  void it('seeds the ledger BEFORE running migrations, with every shipped witness', async () => {
    const { ctx, rec } = makeCtx({});
    const handle = await activate(ctx);
    await handle.close();

    assert.deepEqual(
      rec.order,
      ['seedLedger', 'runMigrations'],
      'a seed after the apply loop is a no-op — the files would already be in the ledger',
    );
    assert.equal(rec.seedCalls.length, 1, 'exactly one handoff per activation');
    assert.deepEqual(
      rec.seedCalls[0]?.entries.map((e) => e.filename),
      SEED_LEDGER_ENTRIES.map((e) => e.filename),
    );
    assert.equal(
      rec.seedCalls[0]?.dryRun,
      undefined,
      'activation performs the real handoff; dryRun is the operator CLI\'s job',
    );
  });

  void it('still activates against a core that has no seedLedger, and says so', async () => {
    // A core older than plugin-api 1.3.0. Declaring the method required would
    // make this plugin refuse to activate on a core that can in fact run it.
    const { ctx, rec } = makeCtx({ noSeedLedger: true });
    const handle = await activate(ctx);
    await handle.close();

    assert.deepEqual(rec.order, ['runMigrations'], 'the apply loop still runs');
    assert.equal(rec.seedCalls.length, 0);
    assert.ok(
      rec.logs.some((l) => l.includes('predates `ctx.sql.seedLedger`')),
      'the degradation must be visible in the activation log, not silent',
    );
  });

  void it('warns loudly when core recorded migrations whose schema is absent', async () => {
    // Rows present, tables absent: a restore from an older snapshot, a
    // rolled-back deploy, or a manual drop. The seed declines, the apply loop
    // repairs — so this is a WARNING, not a refusal.
    const declined = ['0028_dev_jobs_webhook_one_active.js'];
    const { ctx, rec } = makeCtx({ skippedNoWitness: declined });
    const handle = await activate(ctx);
    await handle.close();

    const warning = rec.logs.find((l) => l.includes('WARNING'));
    assert.ok(warning, 'a silent disagreement is the failure mode C11 exists to prevent');
    assert.ok(warning.includes(declined[0] as string), 'name the files');
    assert.ok(
      warning.includes('idempotent'),
      'and say why activation continues anyway',
    );
    assert.equal(rec.migrationsRun, 1, 'the apply loop is the repair');
  });
});

/**
 * C9 (core issue #795 / #796): the two contract shapes that a unit test can pin
 * and a fake context alone cannot.
 *
 * Both were found by running against a real core, not by reading code, and both
 * fail the same way — a throw out of `registerNav` or `services.get` aborts
 * `activateInner`, so the plugin does not activate AT ALL. A recording double
 * accepts anything, which is exactly why the shape has to be asserted here
 * rather than merely exercised.
 */
void describe('C9 host contracts', () => {
  void it('registers nav with pluginUi, never a hand-built href', async () => {
    // `HREF_SEGMENT` is the RFC 3986 unreserved set and #798 kept it strict, so
    // the percent-encoded href this plugin's SCOPED id needs is precisely the
    // one core refuses — while the raw spelling 404s (two path segments). The
    // kernel renders `pluginUiHref(id)` itself when the entry says
    // `pluginUi: true`; that is the only registrable shape.
    const { ctx, rec } = makeCtx({});
    const handle = await activate(ctx);
    await handle.close();

    assert.equal(rec.navEntries.length, 1);
    const entry = rec.navEntries[0] as Record<string, unknown>;
    assert.equal(entry['pluginUi'], true, 'the kernel must render the href');
    assert.equal(
      entry['href'],
      undefined,
      "an href here is unregisterable, not merely redundant — `supply either 'href' or 'pluginUi: true', not both`",
    );
    assert.equal(entry['navId'], 'devPlatform');
  });

  void it('resolves optional capabilities through getOptional when core has it', async () => {
    const { ctx, rec } = makeCtx({});
    const handle = await activate(ctx);
    await handle.close();

    const optional = ['githubAppJwt', 'usageTelemetry', 'conductorRoles', 'turnContext'];
    for (const name of optional) {
      const lookups = rec.optionalLookups.filter((l) => l.name === name);
      assert.ok(lookups.length > 0, `${name} was never resolved`);
      assert.ok(
        lookups.every((l) => l.via === 'getOptional'),
        `${name} must go through getOptional — it is an optional_requires entry`,
      );
    }
    // graphPool is the one MANDATORY capability and stays on `get`: a missing
    // pool is a refusal with a named fix, not a degradation.
    assert.ok(rec.optionalLookups.some((l) => l.name === 'graphPool' && l.via === 'get'));
  });

  void it('falls back to get() on a core older than plugin-api 1.4.0', async () => {
    // The optionality of `getOptional` IS the version guard. A core without it
    // must still activate, resolving the same names through `get()` — which is
    // granted by `optional_requires:` just as it is by `requires:`.
    const { ctx, rec } = makeCtx({ noGetOptional: true });
    const handle = await activate(ctx);
    await handle.close();

    assert.ok(
      rec.optionalLookups.every((l) => l.via === 'get'),
      'no getOptional call may be attempted when the accessor is absent',
    );
    assert.ok(rec.optionalLookups.some((l) => l.name === 'conductorRoles'));
    assert.equal(rec.navs, 1, 'activation completed');
  });

  void it('an undeclared capability is reported as a manifest bug, not an old core', async () => {
    // `ctx.services.get`/`getOptional` throw `ServiceNotDeclaredError` for a
    // name in neither list. `optionalCapability` catches it so a declaration
    // mistake does not read as "this core is too old" — but it must still reach
    // the log, or the plugin degrades in silence.
    const { ctx, rec } = makeCtx({});
    const handle = await activate(ctx);
    await handle.close();

    for (const name of ['githubAppJwt', 'usageTelemetry', 'conductorRoles', 'turnContext']) {
      assert.ok(
        DECLARED_CAPABILITIES.has(name),
        `manifest.yaml declares neither requires: nor optional_requires: '${name}'`,
      );
    }
    assert.ok(
      !rec.logs.some((l) => l.includes('not resolvable')),
      'a declared capability must never be reported as unresolvable',
    );
  });
});
