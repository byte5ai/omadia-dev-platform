/**
 * SEAM — was the `@omadia/usage-telemetry` workspace package.
 *
 * Three units reach for it: `llmProxy.ts` (`recordUsage`),
 * `llmProxyAccounting.ts` (`computeCostUsd`, `recordUsage`, `UsageTokens`) and
 * the assembly (`priceForModel`, for the unpriced-model boot warning). It is a
 * PRIVATE core workspace package on no registry, so a plugin cannot depend on it.
 *
 * It splits cleanly into two halves, and the halves get different treatment.
 *
 * ## The pricing half — copied verbatim
 *
 * `pricing.ts` is a pure price table plus arithmetic. No pool, no config, no core
 * state. It is reproduced below UNCHANGED from
 * `middleware/packages/harness-usage-telemetry/src/pricing.ts` so the per-job
 * budget enforcement computes the same dollars it did in core;
 * `test/pricingParity.test.ts` diffs this copy against the original whenever a
 * core checkout is reachable, so drift is a test failure rather than a surprise
 * in a bill.
 *
 * ## The ledger half — degraded, deliberately, and it costs nothing that enforces
 *
 * `recordUsage` appends to core's `usage_events` table — core's ledger, feeding
 * core's cost dashboard. A plugin has no business writing there, and there is no
 * `usageTelemetry` capability to reach it through.
 *
 * What matters is that the ledger is NOT the enforcement path. The per-job budget
 * is metered from `dev_jobs.cost_usd` / `dev_job_usage` — the plugin's OWN
 * tables, migrated by the plugin — through `llmProxyAccounting`. Dropping the
 * ledger write loses one row in an operator dashboard; it does not loosen a
 * single budget, cap or refusal. Both call sites already took the recorder as an
 * INJECTED seam with a default, so this file supplies the default:
 * `installUsageRecorder()` when core ever publishes the capability, and a
 * counting no-op until then.
 *
 * See SEAMS.md → S6.
 */


export interface ModelPrice {
  /** USD per 1M input tokens (uncached). */
  readonly inputPerMTok: number;
  /** USD per 1M output tokens. */
  readonly outputPerMTok: number;
  /** USD per 1M cached-input tokens (absolute). When set, overrides the
   *  CACHE_READ_MULTIPLIER fallback. Used by providers (OpenAI) that publish a
   *  distinct cached rate rather than a fixed fraction of the input rate. */
  readonly cachedInputPerMTok?: number;
  /** True when the provider's reported input-token count INCLUDES the cached
   *  reads (OpenAI). The cached tokens are then subtracted from full-rate input
   *  before being billed at the cached rate, preventing double-counting.
   *  Anthropic excludes cached reads from input, so this stays false/undefined. */
  readonly cacheIncludedInInput?: boolean;
}

/** Cache-read tokens bill at this fraction of the base input rate when a model
 *  has no explicit `cachedInputPerMTok` (Anthropic convention). */
export const CACHE_READ_MULTIPLIER = 0.1;
/** 5-minute cache-write tokens bill at this multiple of the base input rate. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Exact-id price table. Falls through to family matching for anything else. */
const EXACT_PRICES: Readonly<Record<string, ModelPrice>> = {
  // --- Anthropic (input_tokens excludes cached; multiplier-based cache) ------
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  // --- OpenAI (current GPT-5.x; prompt_tokens includes cached, ~0.1x cached) -
  'gpt-5.5': { inputPerMTok: 5, outputPerMTok: 30, cachedInputPerMTok: 0.5, cacheIncludedInInput: true },
  'gpt-5.4': { inputPerMTok: 2.5, outputPerMTok: 15, cachedInputPerMTok: 0.25, cacheIncludedInInput: true },
  'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5, cachedInputPerMTok: 0.075, cacheIncludedInInput: true },
  'gpt-5.4-nano': { inputPerMTok: 0.2, outputPerMTok: 1.25, cachedInputPerMTok: 0.02, cacheIncludedInInput: true },
  // --- Mistral (OpenAI-compatible API; per the live mistral.ai/pricing page,
  //     reviewed 2026-06-14). `-latest` maps large→Large 3, medium→Medium 3.5,
  //     small→Small 4. `usage` reports prompt/completion tokens with no
  //     separate cached-read billing, so no cachedInputPerMTok /
  //     cacheIncludedInInput (cached reads resolve to 0). Note Mistral prices
  //     Medium 3.5 ABOVE Large 3 — not a typo. -----------------------------
  'mistral-large-latest': { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'mistral-medium-latest': { inputPerMTok: 1.5, outputPerMTok: 7.5 },
  'mistral-small-latest': { inputPerMTok: 0.2, outputPerMTok: 0.6 },
};

/** Family-keyword fallback for dated snapshots / future point releases.
 *  Ordered most-specific-first (substring match): nano/mini before base. */
const FAMILY_PRICES: ReadonlyArray<readonly [keyword: string, price: ModelPrice]> = [
  ['opus', { inputPerMTok: 5, outputPerMTok: 25 }],
  ['sonnet', { inputPerMTok: 3, outputPerMTok: 15 }],
  ['haiku', { inputPerMTok: 1, outputPerMTok: 5 }],
  ['gpt-5.4-nano', { inputPerMTok: 0.2, outputPerMTok: 1.25, cachedInputPerMTok: 0.02, cacheIncludedInInput: true }],
  ['gpt-5.4-mini', { inputPerMTok: 0.75, outputPerMTok: 4.5, cachedInputPerMTok: 0.075, cacheIncludedInInput: true }],
  ['gpt-5.4', { inputPerMTok: 2.5, outputPerMTok: 15, cachedInputPerMTok: 0.25, cacheIncludedInInput: true }],
  ['gpt-5.5', { inputPerMTok: 5, outputPerMTok: 30, cachedInputPerMTok: 0.5, cacheIncludedInInput: true }],
  // Mistral dated snapshots / non-`-latest` variants (e.g. mistral-large-3-25-12).
  ['mistral-large', { inputPerMTok: 0.5, outputPerMTok: 1.5 }],
  ['mistral-medium', { inputPerMTok: 1.5, outputPerMTok: 7.5 }],
  ['mistral-small', { inputPerMTok: 0.2, outputPerMTok: 0.6 }],
];

const UNKNOWN_PRICE: ModelPrice = { inputPerMTok: 0, outputPerMTok: 0 };

const warnedUnknownModels = new Set<string>();

/**
 * Resolves the price for a model id. Exact match wins; otherwise the first
 * matching family keyword. Unknown models return a zero price (logged once).
 */
export function priceForModel(model: string): ModelPrice {
  const id = model.trim().toLowerCase();
  const exact = EXACT_PRICES[id];
  if (exact) return exact;

  for (const [keyword, price] of FAMILY_PRICES) {
    if (id.includes(keyword)) return price;
  }

  if (!warnedUnknownModels.has(id)) {
    warnedUnknownModels.add(id);
    console.warn(
      `[usage-telemetry] no price for model "${model}" — recording at $0. Add it to EXACT_PRICES.`,
    );
  }
  return UNKNOWN_PRICE;
}

/** The four token counters cost is computed from. Fed either by the neutral
 *  `LlmUsage` shape (via withProviderUsageTracking, both providers) or by
 *  {@link normalizeUsage} for the raw Anthropic `message.usage` path. Note the
 *  cross-provider semantics of `inputTokens` re: cached reads — see the cost
 *  conventions in this module's header. */
export interface UsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/**
 * Computes the USD cost of a single call from its model + token usage.
 * Rounds to 8 decimals (sub-micro-cent) so summing many rows stays exact.
 */
export function computeCostUsd(model: string, usage: UsageTokens): number {
  const price = priceForModel(model);
  const inRate = price.inputPerMTok / 1_000_000;
  const outRate = price.outputPerMTok / 1_000_000;
  // Cached reads bill at the model's absolute cached rate when published
  // (OpenAI), else at the multiplier fraction of the input rate (Anthropic).
  const cacheReadRate =
    price.cachedInputPerMTok !== undefined
      ? price.cachedInputPerMTok / 1_000_000
      : inRate * CACHE_READ_MULTIPLIER;
  // When the provider's input count includes the cached portion (OpenAI),
  // bill only the non-cached remainder at the full input rate — the cached
  // tokens are billed separately below. Anthropic excludes them already.
  const fullRateInput = price.cacheIncludedInInput
    ? Math.max(0, usage.inputTokens - usage.cacheReadTokens)
    : usage.inputTokens;
  const cost =
    fullRateInput * inRate +
    usage.outputTokens * outRate +
    usage.cacheReadTokens * cacheReadRate +
    usage.cacheCreationTokens * inRate * CACHE_WRITE_MULTIPLIER;
  return Math.round(cost * 1e8) / 1e8;
}

/**
 * Normalises a raw Anthropic `message.usage` object (snake_case, nullable
 * fields) into the {@link UsageTokens} shape. Missing fields default to 0.
 */
export function normalizeUsage(usage: unknown): UsageTokens {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    inputTokens: num(u['input_tokens']),
    outputTokens: num(u['output_tokens']),
    cacheReadTokens: num(u['cache_read_input_tokens']),
    cacheCreationTokens: num(u['cache_creation_input_tokens']),
  };
}


// ---------------------------------------------------------------------------
// The ledger half — see the header. Injected, defaulted, and inert by default.
// ---------------------------------------------------------------------------

/** One metered LLM call. Structural copy of core's `UsageRecord`. */
export interface UsageRecord extends UsageTokens {
  /** Logical origin: 'orchestrator', 'sub-agent', 'verifier', 'extras', … */
  readonly source: string;
  /** The model id the request was sent to (e.g. 'claude-opus-4-7'). */
  readonly model: string;
  /** Tenant scope, when known at the call site. */
  readonly tenantId?: string | undefined;
  /** Chat session id, when known. */
  readonly sessionId?: string | undefined;
  /** Turn id, when known. */
  readonly turnId?: string | undefined;
}

/** The host capability this seam prefers. `requires: usageTelemetry@1`. */
export interface UsageRecorder {
  recordUsage(record: UsageRecord): void;
}

let hostRecorder: UsageRecorder | undefined;
let droppedRows = 0;
let warnedDropping = false;

/**
 * Install the host recorder. `activate()` calls this when
 * `ctx.services.get('usageTelemetry')` resolves; the returned handle restores
 * the previous state on deactivate so a torn-down host module is not retained.
 */
export function installUsageRecorder(recorder: UsageRecorder | undefined): () => void {
  const previous = hostRecorder;
  hostRecorder = recorder;
  return () => {
    hostRecorder = previous;
  };
}

/** How many rows the no-op has swallowed. Asserted in tests; surfaced in the
 *  deactivate log line so the gap is visible in operations, not just in a doc. */
export function droppedUsageRows(): number {
  return droppedRows;
}

/**
 * Record one metered call. Forwards to the host capability when installed;
 * otherwise counts the row and warns ONCE.
 *
 * Warning once rather than per call is deliberate: the proxy meters every LLM
 * request a job makes, and a per-call warning would bury the operator's log
 * under a message about a dashboard row.
 */
export function recordUsage(record: UsageRecord): void {
  if (hostRecorder) {
    hostRecorder.recordUsage(record);
    return;
  }
  droppedRows += 1;
  if (!warnedDropping) {
    warnedDropping = true;
    console.warn(
      '[dev-platform] no host usage-telemetry capability — LLM usage rows are not reaching the operator ' +
        'cost dashboard. Per-job budgets are UNAFFECTED (they meter this plugin\'s own dev_jobs tables).',
    );
  }
}

/** Reset the module state. Tests only — `installUsageRecorder`'s dispose handle
 *  is the production path. */
export function __resetUsageRecorderForTests(): void {
  hostRecorder = undefined;
  droppedRows = 0;
  warnedDropping = false;
}
