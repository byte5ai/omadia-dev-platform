/**
 * `@omadia/dev-platform` — plugin entry point (epic byte5ai/omadia#470, P3).
 *
 * ## What `activate()` is
 *
 * It is `middleware/src/index.ts:3352-3499` — the 150-line dev-platform assembly
 * block core used to run behind `DEV_PLATFORM_ENABLED` — expressed against the
 * plugin contract instead of against core's module graph. Same objects, same
 * order, same wire paths. What changed is where each input comes from:
 *
 * | core `index.ts` did              | `activate()` does                                    |
 * |----------------------------------|------------------------------------------------------|
 * | `if (config.devPlatform.enabled)`| the install IS the switch                             |
 * | `graphPool` from the registry    | `ctx.services.get('graphPool')`, gated by `permissions.sql` |
 * | `secretVault`                    | `secretVaultFromContext(ctx.secrets)`                 |
 * | 43 `DEV_*` env keys              | 21 `setup.fields` + deployment env (`pluginConfig.ts`) |
 * | boot refusals in `loadConfig()`  | activation refusals — blast radius is one plugin      |
 * | core's migrator, slots 0022-0030 | `ctx.sql.runMigrations()` on the plugin's own ledger   |
 * | `app.use(prefix, requireAuth, r)`| `ctx.routes.register(prefix, r, {auth, body})`         |
 * | `nativeToolRegistry.register`    | `ctx.tools.register`                                  |
 * | `uiRouteCatalog.registerNav('core:…')` | `ctx.uiRoutes.registerNav(...)`                 |
 * | `jobScheduler.register('dev-platform', …)` | `ctx.jobs.register(...)`                     |
 * | `process.once('SIGTERM', stop)`  | `close()` — the kernel owns the lifecycle             |
 *
 * ## The four wire paths are invariants
 *
 * `/api/v1/dev-runner`, `/api/v1/admin/dev-platform`, `/api/webhooks/github` and
 * `RUNNER_PROTOCOL_VERSION` may NOT change (plan.md §7). Deployed runner images
 * phone home to literal URLs and a rename bricks in-flight jobs with no
 * compile-time signal. `test/wirePaths.test.ts` pins all four.
 *
 * ## Registration order, and why `close()` reverses it
 *
 * Migrations → routes → tools → nav → background loops. `close()` disposes in
 * reverse and stops the loops FIRST: a worker that keeps claiming jobs after its
 * routes are gone would provision runners that phone home to a 404.
 */

import { assembleDevPlatform, type WiredDevPlatform } from './wireDevPlatform.js';
import { createDevPlatformGithubAppRouter } from './routes/devPlatformGithubApp.js';
import { createDevWebhooksRouter, type DevWebhooksRouterDeps } from './routes/devWebhooks.js';
import { createChatDevJobOrchestratorTools } from './chatDevJobToolWiring.js';
import { isPermittedLauncher } from './routes/devPlatformShared.js';
import { DevGithubAppStore } from './githubApp/appStore.js';
import { ManifestFlowStore } from './githubApp/manifestFlow.js';
import { DevJobStore } from './devJobStore.js';
import { DevRepoStore } from './devRepoStore.js';
import { DevJobGateStore } from './pipeline/gateStore.js';
import { WebhookDeliveryStore } from './triggers/webhookDeliveryStore.js';
import { createTriggerJob, hasActiveTriggerJob } from './triggers/triggerJobService.js';
import { mintRunnerToken } from './jobToken.js';
import { DevRetentionRunner } from './retention.js';
import { buildDevPlatformConfig, isTrackerPollingEnabled } from './pluginConfig.js';
import { secretVaultFromContext } from './host/vault.js';
import { SEED_LEDGER_ENTRIES } from './ledgerHandoff.js';
import { installAppJwtMinter, type GithubAppJwtMinter } from './host/githubAppJwt.js';
import { installUsageRecorder, droppedUsageRows, type UsageRecorder } from './host/usageTelemetry.js';

// Side-effect import: declares `Request.session` for the whole compilation, the
// way core's `auth/requireAuth.ts` did. See `host/expressSession.ts`.
import './host/expressSession.js';

import type { Pool } from 'pg';

/**
 * Re-exported so consumers depend on the DEV PLATFORM's contract rather than on
 * omadia core (#470, G8 — the `DevJob*` types left `@omadia/plugin-api`).
 * `export type`, so nothing is emitted into `dist/plugin.js`.
 */
export type {
  DevJobDescriptor,
  DevJobEventRecord,
  DevJobKind,
  DevJobStatus,
} from '@omadia/dev-platform-plugin-api';

/** The manifest's `identity.id`. Drift between the manifest, the package name
 *  and the code is a test failure rather than an install-time surprise. */
export const DEV_PLATFORM_PLUGIN_ID = '@omadia/dev-platform';

/**
 * The four wire paths. Exported so `test/wirePaths.test.ts` can pin them and so
 * `manifest.yaml`'s `permissions.public_paths` can be checked against the two
 * that are actually served without a session.
 */
export const WIRE_PATHS = {
  /** Runner phone-home. Authenticated by the per-job bearer token INSIDE the
   *  router — never by a session, which a runner does not have. */
  runner: '/api/v1/dev-runner',
  /** Operator admin surface (jobs, repos, gates, GitHub App admin). */
  admin: '/api/v1/admin/dev-platform',
  /** GitHub App manifest-conversion callback. Authenticated by the state token
   *  the kernel's `flows` machinery minted — no session. */
  githubAppPublic: '/api/v1/dev-platform',
  /** Inbound GitHub webhooks. Authenticated by HMAC over the RAW body. */
  webhooks: '/api/webhooks/github',
} as const;

/** The prefixes served without a kernel session. MUST equal the manifest's
 *  `permissions.public_paths` — `test/manifest.test.ts` asserts it. */
export const PUBLIC_PATHS: readonly string[] = [
  WIRE_PATHS.runner,
  WIRE_PATHS.githubAppPublic,
  WIRE_PATHS.webhooks,
];

/** What `activate()` hands back to the kernel. */
export interface DevPlatformPluginHandle {
  close(): Promise<void>;
  /** The assembled platform. Test-only reach-through; the kernel ignores it. */
  readonly wired?: WiredDevPlatform;
}

/** The slice of `PluginContext` this plugin uses. Declared structurally rather
 *  than imported as the concrete type so the unit tests can drive `activate()`
 *  with a hand-built double — and so a core that predates one optional accessor
 *  is a runtime refusal with a readable message, not a `tsc` error in a repo the
 *  operator cannot rebuild. */
export interface DevPlatformPluginContext {
  readonly agentId: string;
  readonly secrets: {
    get(key: string): Promise<string | undefined>;
    keys(): Promise<string[]>;
    set?(key: string, value: string): Promise<void>;
    delete?(key: string): Promise<void>;
  };
  readonly config: { get<T = unknown>(key: string): T | undefined };
  readonly services: { get<T>(name: string): T | undefined; has(name: string): boolean };
  readonly sql?: {
    readonly ledger: string;
    runMigrations(opts?: { dir?: string }): Promise<{
      applied: readonly string[];
      skipped: readonly string[];
      ledger: string;
      durationMs: number;
    }>;
    /**
     * OPTIONAL, and the optionality is the version guard.
     *
     * Added in `@omadia/plugin-api` 1.3.0 (epic #470 C11). A core that predates
     * it simply does not have the method, and the correct behaviour there is to
     * let `runMigrations()` apply the nine idempotent files — slower on an
     * upgrade, never wrong. Declaring it required would make this plugin
     * refuse to activate on a core that can in fact run it.
     */
    seedLedger?(opts: {
      entries: readonly { filename: string; witnessSql: string }[];
      dryRun?: boolean;
      dir?: string;
    }): Promise<{
      seeded: readonly string[];
      applied: readonly string[];
      skippedNoWitness: readonly string[];
      alreadySeeded: readonly string[];
      donorRecorded: readonly string[];
      ledger: string;
      donorLedger: string;
      dryRun: boolean;
      durationMs: number;
    }>;
  };
  readonly routes: {
    register(
      prefix: string,
      router: unknown,
      options?: { auth?: 'session' | 'public' | 'custom'; body?: 'json' | 'raw' | 'none'; bodyLimit?: string },
    ): () => void;
  };
  readonly tools: {
    /**
     * Full registration: spec + handler + options, mirroring core's
     * `ToolsAccessor.register` (@omadia/plugin-api pluginContext.d.ts). The
     * `handler` slot was MISSING from this hand-narrowed type, and that
     * omission is what caused the P5 activation failure: with nowhere to pass
     * a handler, activate() reached for `registerHandler` as well, and the two
     * are alternative doors into one name-keyed kernel map that both throw on
     * duplicate. A structural type narrower than the real contract does not
     * merely under-describe it — here it made the correct call unwritable.
     */
    register(
      spec: unknown,
      handler: (input: unknown) => Promise<string>,
      options?: { promptDoc?: string },
    ): () => void;
    /** ONLY for tools whose spec the KERNEL emits (e.g. `memory_20250818`).
     *  Not these — see the registration site below. */
    registerHandler(name: string, handler: (input: unknown) => Promise<string>, options?: { promptDoc?: string }): () => void;
  };
  readonly uiRoutes: { registerNav(entry: unknown): () => void };
  readonly jobs: {
    register(
      spec: { name: string; schedule: { cron: string } | { intervalMs: number }; overlap?: 'skip' | 'queue' },
      handler: (signal: AbortSignal) => Promise<void>,
    ): () => void;
  };
  readonly status: { report(status: 'ok' | 'attention' | 'error', message?: string): void };
  log(...args: unknown[]): void;
}

/** SECURITY (Forge W4): cache the registered Apps' webhook secrets briefly so an
 *  unauthenticated flood cannot amplify into a Vault round-trip per request.
 *  30s is short enough that a newly-registered App starts verifying within one
 *  TTL. Copied from `index.ts:2547` — the reason is unchanged by the move. */
const WEBHOOK_SECRETS_TTL_MS = 30_000;

/** The daily retention sweep, at core's cron. Kept identical so an operator's
 *  log timestamps do not move when the plugin takes over the job. */
const RETENTION_CRON = '17 3 * * *';

export async function activate(
  ctx: DevPlatformPluginContext,
): Promise<DevPlatformPluginHandle> {
  const log = (msg: string): void => {
    ctx.log(msg);
  };
  /** Everything registered so far, newest last. `close()` walks it backwards. */
  const disposers: Array<() => void | Promise<void>> = [];
  const undo = async (): Promise<void> => {
    for (const d of [...disposers].reverse()) {
      try {
        await d();
      } catch (err) {
        log(`[dev-platform] disposer failed: ${errText(err)}`);
      }
    }
    disposers.length = 0;
  };
  // Everything from here on reports its failure on the plugin card, not only in
  // a log line. An operator whose plugin refused to activate must be able to see
  // WHY without reading stdout — and the refusals below are configuration
  // mistakes, which is exactly the class they will need to fix themselves.
  try {
    return await activateInner(ctx, log, disposers, undo);
  } catch (err) {
    ctx.status.report('error', errText(err));
    await undo();
    throw err;
  }
}

async function activateInner(
  ctx: DevPlatformPluginContext,
  log: (msg: string) => void,
  disposers: Array<() => void | Promise<void>>,
  undo: () => Promise<void>,
): Promise<DevPlatformPluginHandle> {
  // ── 1. Preconditions ─────────────────────────────────────────────────────
  // Core guarded the whole block on `config.devPlatform.enabled && graphPool`
  // and, when the pool was absent, warned and carried on. A plugin does better:
  // an installed dev platform with no database can do NOTHING, and reporting
  // healthy while contributing nothing is the failure mode an operator cannot
  // see. Refuse, loudly, with the fix in the message.
  const pool = ctx.services.get<Pool>('graphPool');
  if (!pool) {
    throw new Error(
      '@omadia/dev-platform requires the `graphPool@1` capability (a Postgres-backed knowledge graph). ' +
        'Set DATABASE_URL and install the Neon KG plugin, or uninstall this one — the job spine, repo, ' +
        'gate and artifact tables have nowhere to persist without it.',
    );
  }
  if (!ctx.sql) {
    throw new Error(
      '@omadia/dev-platform declares `permissions.sql` but `ctx.sql` is undefined — either this core ' +
        'predates epic #470 C7, or the operator has not granted the SQL permission. The plugin owns nine ' +
        'tables and will not run against a schema it cannot migrate.',
    );
  }
  if (!ctx.secrets.set) {
    throw new Error(
      '@omadia/dev-platform requires `permissions.secrets.runtime_write`: it persists GitHub App private ' +
        'keys and per-repo clone tokens at runtime. Without write access every repo would be unconnectable.',
    );
  }

  const vault = secretVaultFromContext(ctx.secrets);
  // Throws `DevPlatformActivationRefused` on an interlock violation — BEFORE a
  // single route, tool or migration lands. See `pluginConfig.ts`.
  const config = buildDevPlatformConfig(ctx.config, process.env);

  // ── 2. Optional host capabilities ────────────────────────────────────────
  // Each is looked up, not assumed. `ctx.services.get` throws for a name the
  // manifest does not declare, so every lookup is wrapped: a manifest bug must
  // not read as "core does not have it".
  const jwtMinter = optionalCapability<GithubAppJwtMinter>(ctx, 'githubAppJwt', log);
  disposers.push(installAppJwtMinter(jwtMinter));
  if (!jwtMinter) {
    log(
      '[dev-platform] no `githubAppJwt@1` capability — using the local RS256 signer (SEAMS.md S2). ' +
        'Functionally identical; the capability is the intended end state.',
    );
  }
  disposers.push(installUsageRecorder(optionalCapability<UsageRecorder>(ctx, 'usageTelemetry', log)));

  // W2: role-principal gates resolve their live holder set against the conductor
  // role store. Core has no `conductorRoles@1` capability, so this degrades to
  // the assembly's own fail-CLOSED default — an empty holder set, meaning nobody
  // can approve a role gate. That is the safe direction (a gate that cannot be
  // approved blocks a job; a gate approvable by anyone would not), but it IS a
  // capability regression and the operator must be told, not left to discover it
  // when a job sits in `waiting` forever. SEAMS.md → S7.
  const roleHolders = optionalCapability<{ resolve(key: string): Promise<string[]> }>(
    ctx,
    'conductorRoles',
    log,
  );
  if (!roleHolders) {
    log(
      '[dev-platform] no `conductorRoles@1` capability — repos configured with an approver ROLE cannot ' +
        'have their gates approved (fail-closed). Configure a user approver until core publishes it (SEAMS.md S7).',
    );
  }

  {
    // ── 3. Migrations ──────────────────────────────────────────────────────
    // Nine files, slots 0022-0030, filenames preserved, under an advisory lock
    // on the plugin's own ledger. C11 seeds that ledger from core's donor rows
    // BY FILENAME with per-file schema witnesses, so an installation that
    // already has these tables reports them `skipped` rather than re-running
    // them — and all nine are idempotent even if it does.
    // C11 — adopt what core already applied, on proof rather than on trust.
    // Guarded: `seedLedger` is optional on the contract, so a core older than
    // plugin-api 1.3.0 falls through to the (idempotent) apply loop instead of
    // failing to activate.
    if (ctx.sql.seedLedger) {
      const handoff = await ctx.sql.seedLedger({ entries: SEED_LEDGER_ENTRIES });
      log(
        `[dev-platform] ledger handoff: ${String(handoff.seeded.length)} adopted from ` +
          `'${handoff.donorLedger}', ${String(handoff.alreadySeeded.length)} already in ` +
          `'${handoff.ledger}', ${String(handoff.applied.length)} left to apply` +
          (handoff.seeded.length > 0 ? ` — adopted: ${handoff.seeded.join(', ')}` : ''),
      );
      if (handoff.skippedNoWitness.length > 0) {
        // The alarm. Core's ledger says these ran; the live catalog says their
        // schema objects are not there. That is a restore, a rolled-back
        // deploy, or a manual drop — and the naive handoff would have adopted
        // them and left every request against those tables 500ing. The apply
        // loop below is the repair, so this is a WARNING and not a refusal.
        log(
          `[dev-platform] WARNING — core's ledger records ${String(handoff.skippedNoWitness.length)} migration(s) ` +
            `whose schema is NOT present: ${handoff.skippedNoWitness.join(', ')}. ` +
            'This database was most likely restored from a snapshot older than those migrations, or the ' +
            'objects were dropped. They are being re-applied now (all nine are idempotent). If that is a ' +
            'surprise, stop and confirm this is the database you think it is.',
        );
      }
    } else {
      log(
        '[dev-platform] this core predates `ctx.sql.seedLedger` (plugin-api 1.3.0) — ' +
          'the nine migrations will be re-applied instead of adopted. They are idempotent, so this is ' +
          'slower on an existing installation, not unsafe.',
      );
    }

    const report = await ctx.sql.runMigrations();
    log(
      `[dev-platform] migrations: ${String(report.applied.length)} applied, ` +
        `${String(report.skipped.length)} already in ledger '${report.ledger}' (${String(report.durationMs)}ms)` +
        (report.applied.length > 0 ? ` — applied: ${report.applied.join(', ')}` : ''),
    );

    // ── 4. The assembly ────────────────────────────────────────────────────
    const wired = assembleDevPlatform({
      pool,
      vault,
      config,
      shimEntry: resolveShimEntry(),
      ...(roleHolders ? { resolveRoleHolders: (key: string) => roleHolders.resolve(key) } : {}),
      log,
    });

    // ── 5. Routes ──────────────────────────────────────────────────────────
    // The mount shapes core hand-wrote, expressed as declarations.
    //
    //   admin   → `auth: 'session'`. Core wrapped these in `requireAuth`; the
    //             kernel now composes the same gate INSIDE the deactivation
    //             guard, so a deactivated plugin's prefix stops existing before
    //             any authentication runs.
    //   runner  → `auth: 'custom'`. Its ONLY authentication is the per-job
    //             bearer token verified inside the router. A session guard here
    //             would lock out the runner entirely; `'public'` would be a lie
    //             about a surface that does authenticate. `body: 'none'` because
    //             the router mounts its own per-route JSON parsers with
    //             per-endpoint limits (4mb events, 16kb heartbeat, 256kb result)
    //             and proxies the LLM stream — exactly as it did under core's
    //             global parser.
    //   webhook → `auth: 'custom', body: 'raw'`. G3 exists for this: the bytes
    //             an HMAC is computed over must be the bytes that arrived, so
    //             the kernel captures them AHEAD of its global JSON parser.
    //             Never re-serialise `req.body` to verify the signature.
    const register = (
      prefix: string,
      router: unknown,
      options?: { auth?: 'session' | 'public' | 'custom'; body?: 'json' | 'raw' | 'none' },
    ): void => {
      disposers.push(ctx.routes.register(prefix, router, options));
    };

    register(WIRE_PATHS.admin, wired.adminRouter, { auth: 'session' });
    register(WIRE_PATHS.admin, wired.gatesRouter, { auth: 'session' });
    register(WIRE_PATHS.runner, wired.runnerRouter, { auth: 'custom', body: 'none' });

    const githubAppStore = new DevGithubAppStore(pool, vault);
    const githubAppRouter = createDevPlatformGithubAppRouter({
      flowStore: new ManifestFlowStore(),
      appStore: githubAppStore,
      bindRepoCredential: async (repoId, binding): Promise<void> => {
        const bound = await wired.repoStore.updateRepo(repoId, {
          credentialKind: 'github_app',
          credentialRef: `github_app:${binding.appRowId}:${binding.installationId}`,
        });
        if (!bound) {
          throw new Error(`dev-platform repo not found while binding GitHub App credential: ${repoId}`);
        }
      },
      getRepo: async (repoId): Promise<{ owner: string; name: string } | null> => {
        const repo = await wired.repoStore.getRepo(repoId);
        return repo ? { owner: repo.owner, name: repo.name } : null;
      },
      publicBaseUrl: config.fly?.publicBaseUrl ?? config.baseUrl,
      log,
    });
    register(WIRE_PATHS.admin, githubAppRouter.admin, { auth: 'session' });
    register(WIRE_PATHS.githubAppPublic, githubAppRouter.public, { auth: 'custom' });

    if (config.webhooks.enabled) {
      register(WIRE_PATHS.webhooks, buildWebhooksRouter(pool, vault, config, log), {
        auth: 'custom',
        body: 'raw',
      });
      log(`[dev-platform] GitHub webhook router registered at ${WIRE_PATHS.webhooks} (raw body, HMAC auth)`);
    } else {
      log('[dev-platform] webhooks disabled by operator config — no webhook route registered');
    }

    // ── 6. Chat orchestrator tools ─────────────────────────────────────────
    // ONE global registration; the caller is resolved PER CALL from the turn
    // context (the human driving the turn). No `userId` ⇒ fail closed. That
    // resolution is the whole authorization envelope, so its absence is not a
    // degraded mode — it is a refusal to register.
    const turnContext = optionalCapability<{ current(): { userId?: string } | undefined }>(
      ctx,
      'turnContext',
      log,
    );
    if (turnContext) {
      const chatTools = createChatDevJobOrchestratorTools({
        repoStore: wired.repoStore,
        jobStore: wired.jobStore,
        isPermittedLauncher,
        defaultBackend: config.backend,
        getCallerUserId: () => turnContext.current()?.userId,
      });
      for (const reg of chatTools.registrations) {
        // ONE call, not two. `register` and `registerHandler` are ALTERNATIVE
        // doors into the same name-keyed map in the kernel's NativeToolRegistry
        // (harness-orchestrator/src/nativeToolRegistry.ts:148 and :198) and both
        // THROW on a name already present — they do not compose. Calling both
        // for one name registered the handler, then threw
        // `duplicate native-tool name 'dev_job_start'` on the very first tool,
        // which failed activate() and rolled the whole plugin back.
        //
        // `register(spec, handler, options)` is the full path and already
        // carries the handler; `registerHandler(name, handler)` exists only for
        // tools whose spec the KERNEL emits (e.g. `memory_20250818`), which is
        // not these. The old second call also passed no handler at all
        // (`register(reg.spec)` — arity 1 against a 3-arg signature), so even
        // without the throw the tool would have dispatched to `undefined`.
        disposers.push(
          ctx.tools.register(reg.spec, reg.handler, {
            ...(reg.promptDoc ? { promptDoc: reg.promptDoc } : {}),
          }),
        );
      }
      log(
        '[dev-platform] chat orchestrator tools registered (dev_job_start / dev_job_status / dev_job_list)',
      );
    } else {
      // Registering them anyway would publish three tools that refuse every
      // call — worse than not offering them, because the model would keep
      // trying and the operator would read the refusals as a bug.
      log(
        '[dev-platform] no `turnContext@1` capability — chat dev-job tools NOT registered. They authorize ' +
          'per call against the human driving the turn, and there is no envelope without it (SEAMS.md S8).',
      );
    }

    // ── 7. Nav ─────────────────────────────────────────────────────────────
    // PR #536 registered this from `index.ts` behind `DEV_PLATFORM_ENABLED`,
    // deliberately temporary, to prove the loop before any code moved. This is
    // the call it was always going to become; nothing about the shell changes.
    //
    // THE HREF MOVED IN P2, and leaving it at the old path would be the
    // quietest possible way to break this plugin. `/admin/dev-platform` was a
    // page COMPILED INTO web-ui. P2 ports those pages out of core into
    // `packages/ui`, so core deletes that route — and a nav entry still aimed
    // at it renders a sidebar link to the shell's 404, with nothing in any
    // build to say so. `/plugin-ui/<id>` is the generic host page core added
    // in C8: it validates the id and iframes
    // `/p/<id>/ui/index.html?theme=&palette=&locale=`, which is where the
    // `ui/` directory in this package's ZIP is served from.
    //
    // `encodeURIComponent` is load-bearing, not defensive. This plugin's id is
    // SCOPED — `@omadia/dev-platform`, per `manifest.yaml` and per the charset
    // `manifestLoader.ts:182` blesses — so it contains a `/`. Interpolated raw
    // it would emit `/plugin-ui/@omadia/dev-platform`: two path segments, which
    // neither the Next dynamic segment nor Express's `:pluginId` can match.
    disposers.push(
      ctx.uiRoutes.registerNav({
        navId: 'devPlatform',
        href: `/plugin-ui/${encodeURIComponent(DEV_PLATFORM_PLUGIN_ID)}`,
        cluster: 'adminCluster',
        order: 50,
        label: { en: 'Dev Platform', de: 'Dev-Plattform' },
      }),
    );

    // ── 8. Background loops ────────────────────────────────────────────────
    // `start()` re-adopts the docker containers that outlived the last process
    // BEFORE the claim loop runs. A worker that starts before rehydration sees a
    // daemon full of jobs it believes it does not own, and `reap()` would leave
    // every one of them running until its lease expires.
    await wired.start();
    disposers.push(() => wired.stop());

    const retention = new DevRetentionRunner(pool, {
      eventRetentionDays: config.retention.eventRetentionDays,
      auditRetentionDays: config.retention.auditRetentionDays,
    });
    disposers.push(
      ctx.jobs.register(
        { name: 'dev-retention', schedule: { cron: RETENTION_CRON }, overlap: 'skip' },
        async () => {
          const r = await retention.run();
          log(
            `[dev-platform] dev-retention swept: ${String(r.lowValueEventsDeleted)} low-value + ` +
              `${String(r.expiredEventsDeleted)} expired events pruned`,
          );
        },
      ),
    );
    log(`[dev-platform] dev-retention cron registered (${RETENTION_CRON})`);

    // Tracker polling ships DORMANT — `dormant-capabilities.md` §3's
    // DEFER-AND-HARDEN verdict. It has never executed in production, and six
    // hardening fixes gate switching it on (cold-start budget ceiling,
    // `requireGate:false` with no sender allowlist, firing on any ticket update
    // rather than on label application, cross-source dedupe, `source_ref`
    // namespacing, and the frozen `Ticket` contract). The flag exists so the
    // capability travels with its tree rather than being rebuilt later; it does
    // NOT mean the capability is ready.
    if (isTrackerPollingEnabled(ctx.config)) {
      log(
        '[dev-platform] WARNING: tracker_polling_enabled is on, but the poller is NOT wired in this ' +
          'release. Six hardening fixes gate switch-on (SEAMS.md D3) — the flag is recorded, nothing polls.',
      );
    }

    ctx.status.report('ok');
    log(
      `[dev-platform] activated — worker running (max ${String(config.maxConcurrentJobs)} concurrent, ` +
        `${String(wired.backends.length)} backend(s))`,
    );

    return {
      wired,
      async close(): Promise<void> {
        log('[dev-platform] deactivating');
        await undo();
        const dropped = droppedUsageRows();
        if (dropped > 0) {
          log(`[dev-platform] ${String(dropped)} LLM usage rows never reached a host ledger (SEAMS.md S6)`);
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * Resolve an OPTIONAL host capability.
 *
 * `ctx.services.get` throws `ServiceNotDeclaredError` when the manifest does not
 * declare the name — a manifest bug, not a missing provider — and the two must
 * not be reported the same way. Catching here keeps a declaration mistake from
 * reading as "this core is too old", while still surfacing it in the log.
 */
function optionalCapability<T>(
  ctx: DevPlatformPluginContext,
  name: string,
  log: (msg: string) => void,
): T | undefined {
  try {
    return ctx.services.get<T>(name);
  } catch (err) {
    log(`[dev-platform] capability '${name}' not resolvable: ${errText(err)}`);
    return undefined;
  }
}

/**
 * The webhook trigger surface. Built from pool + vault only — the stores are
 * stateless — exactly as `index.ts:2537` did, and deliberately NOT from the
 * assembly's instances: core built these BEFORE the full assembly so the mount
 * order (raw body ahead of the global JSON parser) stayed correct, and the
 * worker claims the created jobs from the database rather than in memory.
 */
function buildWebhooksRouter(
  pool: Pool,
  vault: ReturnType<typeof secretVaultFromContext>,
  config: ReturnType<typeof buildDevPlatformConfig>,
  log: (msg: string) => void,
): unknown {
  const appStore = new DevGithubAppStore(pool, vault);
  const repoStore = new DevRepoStore(pool);
  const jobStore = new DevJobStore(pool);
  const gateStore = new DevJobGateStore(pool);
  const deliveries = new WebhookDeliveryStore(pool);

  let cachedSecrets: readonly string[] | null = null;
  let cachedAt = 0;
  const listWebhookSecrets = async (): Promise<readonly string[]> => {
    const nowMs = Date.now();
    if (cachedSecrets && nowMs - cachedAt < WEBHOOK_SECRETS_TTL_MS) return cachedSecrets;
    const secrets: string[] = [];
    for (const app of await appStore.listApps()) {
      const s = await appStore.getSecrets(app.appId);
      if (s?.webhookSecret) secrets.push(s.webhookSecret);
    }
    cachedSecrets = secrets;
    cachedAt = nowMs;
    return secrets;
  };

  // Webhook jobs run on the non-local default backend: Fly when a runner app is
  // configured, else the docker shipping path. `local` is structurally refused
  // by the trigger job service, so it can never be selected here.
  const webhookBackend = config.fly?.runnerApp ? ('fly' as const) : ('docker' as const);

  const deps: DevWebhooksRouterDeps = {
    listWebhookSecrets,
    repos: {
      getByFullName: async (fullName) =>
        (await repoStore.listRepos()).find((r) => `${r.owner}/${r.name}` === fullName) ?? null,
    },
    deliveries,
    hasActiveWebhookJob: (repoId, sourceRef) =>
      hasActiveTriggerJob(pool, repoId, sourceRef, 'webhook'),
    createTriggerJob: (input) => createTriggerJob({ jobStore, gateStore, log }, input),
    mintRunnerToken: () => mintRunnerToken(),
    webhookBackend,
    webhooksEnabled: config.webhooks.enabled,
    maxJobsPerRepoHour: config.webhooks.maxJobsPerRepoHour,
    maxJobsPerSenderHour: config.webhooks.maxJobsPerSenderHour,
    log,
  };
  return createDevWebhooksRouter(deps);
}

/**
 * Absolute path to the built runner shim entry.
 *
 * The shim is P4 cargo — it does not ship in this release. The ONLY consumer is
 * `LocalProcessBackend`, which the assembly builds solely when `unsafe_local` is
 * on, and that mode already demands an explicit uid acknowledgment. So a path
 * that does not exist yet costs nothing in every supported configuration, and
 * pointing it at the package-relative location it WILL occupy means P4 changes
 * the payload, not the wiring.
 */
function resolveShimEntry(): string {
  return new URL('../shim/dist/src/index.js', import.meta.url).pathname;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
