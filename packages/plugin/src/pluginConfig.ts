/**
 * Build the dev platform's `DevPlatformConfig` from the two sources a plugin
 * actually has: the operator's answers to `setup.fields`, and the deployment's
 * environment.
 *
 * ## Config is not 41 setup.fields (plan.md §6)
 *
 * Core read 43 `DEV_*` env keys. They are four different things and only one of
 * them is a question worth putting in an install dialog:
 *
 *   1. **Platform-injected env** — `FLY_APP_NAME` is a probe, not a question.
 *      Asking an operator to type it in would let them get it wrong, and its
 *      PRESENCE is what selects the on-/off-Fly endpoints.
 *   2. **Deployment facts** — the daemon URL and token, the runner image, the
 *      dedicated Fly app. These belong to the compose overlay that G5 already
 *      leaves to the operator; they are set where the sidecars are set, and a
 *      second copy in a web form is a second thing to keep in sync.
 *   3. **Cross-field safety interlocks** — `SUBSCRIPTION_MODE` without `_ACK`,
 *      `UNSAFE_LOCAL` without `LOCAL_UID`. A flat field list CANNOT express
 *      these, and shipping them as two independent optional booleans would
 *      SILENTLY DELETE a boot-time safety refusal. They are declared as fields
 *      (the operator must be able to turn them on) and enforced in `activate()`.
 *   4. **Operator-policy knobs** — budget, retention, concurrency, allowed
 *      models, wall clock, commit identity. Fifteen of them. THESE are the
 *      `setup.fields`.
 *
 * ## Why the refusals moved rather than vanished
 *
 * In core these were `loadConfig()` throws: one misconfigured dev-platform key
 * took the whole host offline. As activation refusals they are strictly better —
 * the same configuration is still refused, but the blast radius is one plugin.
 */

import type {
  DevPlatformConfig,
  DevPlatformFlyConfig,
  DevPlatformLlmConfig,
} from './config.js';

/** The slice of `PluginContext['config']` this module needs. */
export interface PluginConfigReader {
  get<T = unknown>(key: string): T | undefined;
}

/** Environment slice — injected so the resolution is testable without mutating
 *  `process.env`, which is shared with every other plugin in the host. */
export type EnvReader = Readonly<Record<string, string | undefined>>;

/** Setup-field keys, in one place so the manifest and the code cannot drift.
 *  `test/setupFields.test.ts` asserts this list equals `manifest.yaml`'s. */
export const SETUP_FIELD_KEYS = [
  'runner_base_url',
  'commit_author',
  'max_concurrent_jobs',
  'job_wall_clock_ms',
  'heartbeat_timeout_ms',
  'llm_allowed_models',
  'llm_default_budget_usd',
  'llm_max_output_tokens',
  'event_retention_days',
  'audit_retention_days',
  'max_events_per_job',
  'artifact_max_bytes',
  'webhooks_enabled',
  'webhook_max_jobs_per_repo_hour',
  'webhook_max_jobs_per_sender_hour',
  'egress_base_allowlist',
  'subscription_mode',
  'subscription_ack',
  'unsafe_local',
  'unsafe_local_uid',
  'tracker_polling_enabled',
] as const;

export type SetupFieldKey = (typeof SETUP_FIELD_KEYS)[number];

/** Defaults, mirroring core's zod schema so an operator who answers nothing gets
 *  the behaviour core shipped. */
const DEFAULTS = {
  cliBin: 'claude',
  commitAuthor: 'omadia dev platform <dev-platform@omadia.ai>',
  maxConcurrentJobs: 2,
  wallClockMs: 45 * 60 * 1000,
  heartbeatTimeoutMs: 5 * 60 * 1000,
  workspaceDir: '/tmp/omadia-dev-platform',
  defaultBudgetCostUsd: 5,
  maxOutputTokens: 8192,
  eventRetentionDays: 30,
  auditRetentionDays: 365,
  maxEventsPerJob: 5000,
  artifactMaxBytes: 1_048_576,
  webhookMaxJobsPerRepoHour: 10,
  webhookMaxJobsPerSenderHour: 5,
} as const;

/**
 * The cross-field interlocks, unchanged in meaning from core's
 * `devPlatformBootRefusals()`. Pure + exported so `activate()` and its test
 * drive the same function.
 */
export function devPlatformActivationRefusals(cfg: {
  subscriptionMode: boolean;
  subscriptionAck: string | undefined;
  unsafeLocal: boolean;
  localUid: number | undefined;
}): string[] {
  const refusals: string[] = [];
  if (cfg.subscriptionMode && !cfg.subscriptionAck) {
    refusals.push(
      'subscription_mode is on but subscription_ack is empty ' +
        '(the operator must acknowledge that subscription jobs run the CLI credential inside the runner)',
    );
  }
  if (cfg.unsafeLocal && cfg.localUid === undefined) {
    refusals.push(
      'unsafe_local is on but unsafe_local_uid is unset ' +
        '(the jailed shim must run as a dedicated unprivileged uid, never root)',
    );
  }
  return refusals;
}

/** Thrown by `activate()` when an interlock is violated. Named so the kernel's
 *  activation-failure surface reads as a policy refusal, not a crash. */
export class DevPlatformActivationRefused extends Error {
  public readonly refusals: readonly string[];
  constructor(refusals: readonly string[]) {
    super(
      `@omadia/dev-platform refuses to activate:\n${refusals.map((r) => `  - ${r}`).join('\n')}`,
    );
    this.name = 'DevPlatformActivationRefused';
    this.refusals = refusals;
  }
}

/** Build the namespace the assembly takes. Throws `DevPlatformActivationRefused`
 *  when an interlock is violated — BEFORE anything is registered or migrated. */
export function buildDevPlatformConfig(
  config: PluginConfigReader,
  env: EnvReader,
  publicBaseUrl?: string,
): DevPlatformConfig {
  const subscriptionMode = bool(config.get('subscription_mode'), false);
  const subscriptionAck = str(config.get('subscription_ack'));
  const unsafeLocal = bool(config.get('unsafe_local'), false);
  const localUid = int(config.get('unsafe_local_uid'));

  const refusals = devPlatformActivationRefusals({
    subscriptionMode,
    subscriptionAck,
    unsafeLocal,
    localUid,
  });
  if (refusals.length > 0) throw new DevPlatformActivationRefused(refusals);

  const llm: DevPlatformLlmConfig = {
    provider: env['DEV_PLATFORM_LLM_PROVIDER'],
    upstreamBaseUrl: env['DEV_PLATFORM_LLM_UPSTREAM_BASE_URL'],
    allowedModels: csvList(config.get('llm_allowed_models')),
    defaultBudgetCostUsd: int(config.get('llm_default_budget_usd')) ?? DEFAULTS.defaultBudgetCostUsd,
    maxOutputTokens: int(config.get('llm_max_output_tokens')) ?? DEFAULTS.maxOutputTokens,
  };

  // Deployment facts (group 2) + platform-injected env (group 1). `FLY_APP_NAME`
  // is read, never asked: its presence selects the internal Machines API and the
  // `.internal` phone-home address, and its value is what the dedicated-app
  // refusal compares against.
  const fly: DevPlatformFlyConfig = {
    runnerApp: env['DEV_FLY_RUNNER_APP'],
    hostAppName: env['FLY_APP_NAME'],
    phoneHomeUrl: env['DEV_FLY_PHONE_HOME_URL'],
    publicBaseUrl: publicBaseUrl ?? env['PUBLIC_BASE_URL'],
    maxCpus: intStr(env['DEV_FLY_MAX_CPUS']),
    maxMemoryMb: intStr(env['DEV_FLY_MAX_MEMORY_MB']),
    guestCpus: intStr(env['DEV_FLY_GUEST_CPUS']),
    guestMemoryMb: intStr(env['DEV_FLY_GUEST_MEMORY_MB']),
    region: env['DEV_FLY_REGION'],
  };

  return {
    // `enabled` is now the INSTALL itself: a plugin that is not installed
    // contributes nothing, which is what the flag used to buy. Kept `true` so the
    // ported assembly's own reads behave, and NOT offered as a setup field —
    // "install it, then switch it off" is a worse operator story than uninstall.
    enabled: true,
    baseUrl: str(config.get('runner_base_url')) ?? publicBaseUrl ?? env['PUBLIC_BASE_URL'] ?? 'http://127.0.0.1:8080',
    cliBin: env['DEV_PLATFORM_CLI_BIN'] ?? DEFAULTS.cliBin,
    wallClockMs: int(config.get('job_wall_clock_ms')) ?? DEFAULTS.wallClockMs,
    heartbeatTimeoutMs: int(config.get('heartbeat_timeout_ms')) ?? DEFAULTS.heartbeatTimeoutMs,
    maxConcurrentJobs: int(config.get('max_concurrent_jobs')) ?? DEFAULTS.maxConcurrentJobs,
    commitAuthor: str(config.get('commit_author')) ?? DEFAULTS.commitAuthor,
    subscriptionModeEnabled: subscriptionMode,
    subscriptionAck,
    workspaceDir: env['DEV_PLATFORM_WORKSPACE_DIR'] ?? DEFAULTS.workspaceDir,
    unsafeLocal,
    localUid,
    githubClientId: env['DEV_PLATFORM_GITHUB_CLIENT_ID'] ?? env['GITHUB_OAUTH_CLIENT_ID'],
    daemonToken: env['DEV_RUNNER_DAEMON_TOKEN'],
    daemonUrl: env['DEV_RUNNER_DAEMON_URL'],
    backend: env['DEV_PLATFORM_BACKEND'] === 'local' ? 'local' : 'docker',
    leaseTtlSec: intStr(env['DEV_JOB_LEASE_TTL_SEC']),
    runnerImage: env['DEV_RUNNER_IMAGE'] ?? env['DEV_RUNNER_DEFAULT_IMAGE'],
    egressBaseAllowlist: csvList(config.get('egress_base_allowlist')),
    middlewareHost: env['DEV_PLATFORM_MIDDLEWARE_HOST'],
    llm,
    fly,
    webhooks: {
      enabled: bool(config.get('webhooks_enabled'), true),
      maxJobsPerRepoHour:
        int(config.get('webhook_max_jobs_per_repo_hour')) ?? DEFAULTS.webhookMaxJobsPerRepoHour,
      maxJobsPerSenderHour:
        int(config.get('webhook_max_jobs_per_sender_hour')) ?? DEFAULTS.webhookMaxJobsPerSenderHour,
    },
    retention: {
      eventRetentionDays: int(config.get('event_retention_days')) ?? DEFAULTS.eventRetentionDays,
      auditRetentionDays: int(config.get('audit_retention_days')) ?? DEFAULTS.auditRetentionDays,
      maxEventsPerJob: int(config.get('max_events_per_job')) ?? DEFAULTS.maxEventsPerJob,
      artifactMaxBytes: int(config.get('artifact_max_bytes')) ?? DEFAULTS.artifactMaxBytes,
    },
  };
}

/** Tracker polling stays OFF unless the operator turns it on AND the six
 *  hardening fixes have landed. See SEAMS.md → D3. */
export function isTrackerPollingEnabled(config: PluginConfigReader): boolean {
  return bool(config.get('tracker_polling_enabled'), false);
}

// --- coercion -------------------------------------------------------------
// The registry stores setup answers as they came out of a web form, so a
// `boolean` field can arrive as `true` or as `"true"`, and an `integer` field as
// `7` or `"7"`. Coerce both shapes rather than trusting one.

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
  }
  return fallback;
}

function int(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') return intStr(v);
  return undefined;
}

function intStr(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** A `host_list` field arrives as an array; a legacy string arrives comma-joined.
 *  Empty in either shape means "no entries", never `undefined` masquerading as
 *  an unset allowlist. */
function csvList(v: unknown): readonly string[] {
  const raw = Array.isArray(v)
    ? v.filter((e): e is string => typeof e === 'string')
    : typeof v === 'string'
      ? v.split(',')
      : [];
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}
