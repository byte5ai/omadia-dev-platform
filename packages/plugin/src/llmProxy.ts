/**
 * Epic #470 W1 — the middleware LLM proxy (spec §6b), the security keystone.
 *
 * An Anthropic-Messages-compatible reverse proxy mounted on the phone-home
 * router at `/llm` (so the full prefix is `/api/v1/dev-runner/llm/*`). It is the
 * ONE thing that keeps provider API keys out of job containers: the Claude CLI
 * inside a job is handed `ANTHROPIC_BASE_URL` → here and a per-job bearer as its
 * `ANTHROPIC_AUTH_TOKEN`; this proxy validates that bearer as a job token,
 * applies the job's policy and forwards. No provider key ever exists in a job
 * container's env or filesystem.
 *
 * Spec 2042 §5.10 — the dev platform is a system module and holds NO provider
 * key either. The forward goes through the kernel's model gateway: each dev
 * job's calls run inside one kernel operator job (`operatorJobs@1`, see
 * `llmOperatorJobs.ts`), and `modelPassthrough@1` adds the instance's
 * Anthropic credentials and admits the call. There is no direct provider call
 * in this plugin; without the two services the proxy answers 503.
 *
 * Contract confirmed by the option-D spike (issue #470 comment 4929394900): the
 * CLI probes `GET <base>/` once (must be 2xx), then `POST <base>/v1/messages?beta=true`
 * with `Authorization: Bearer <token>`. Both are served here.
 *
 * Wiring (out of this unit's scope — see the DockerBackend/wire units) builds a
 * router via `createLlmProxyRouter` with real store/gateway/usage seams and
 * passes it to `createDevRunnerRouter({ llmProxyRouter })`, which mounts it at
 * `/llm`.
 *
 * Failure semantics (spec §6b step 5):
 *   - a gateway refusal (call budget, deadline, cancel, kill switch, no
 *     credentials) → a JSON 4xx/503 naming it, never retried (`modelGateway.ts`).
 *   - upstream 429 → passed through verbatim, incl. `Retry-After`.
 *   - upstream 5xx → retried ONCE — but only before any bytes reach the client.
 *     A streamed request that already emitted tokens is NEVER retried (a retry
 *     would re-bill the client for the tokens already streamed).
 *   - mid-stream disconnect → the partial usage seen so far is still metered and
 *     a `log` note records the truncation.
 */

import { Router, raw as expressRaw } from 'express';
import type { Request, Response } from 'express';

import {
  classifyGatewayError,
  type ModelPassthroughService,
  type OperatorJob,
} from './host/modelGateway.js';
import { recordUsage as defaultRecordUsage } from './host/usageTelemetry.js';
import { DevJobOperatorJobEndedError, terminalOutcome, type DevJobOperatorJobs } from './llmOperatorJobs.js';
import { StreamRedactor, redactCredentials } from './llmProxyRedaction.js';
import { applyUsage, drainSse, newUsage, type UsageAccumulator } from './llmProxyUsage.js';
import { isTerminalDevJobStatus, type DevJobStatus } from './types.js';

// ---------------------------------------------------------------------------
// Injected seams. Each is the narrow slice this proxy needs; the wire unit
// binds the real store/model-gateway/usage-ledger implementations.
// ---------------------------------------------------------------------------

/** The minimal job view the proxy needs, resolved from the bearer token alone
 *  (the CLI never sends a jobId — only `Authorization: Bearer <djr_…>`). */
export interface LlmProxyJob {
  readonly id: string;
  readonly status: DevJobStatus;
  /** `dev_jobs.agent_kind` — drives the model-allowlist lookup. */
  readonly agentKind: string;
  /** `dev_jobs.created_by` — recorded as who started the kernel operator job. */
  readonly createdBy?: string | undefined;
  /** `dev_jobs.started_at` — bounds the operator job by the remaining wall clock. */
  readonly startedAt?: string | null | undefined;
}

/** Effective LLM policy for a job's agent kind (the `ctx.llm` gate's allowlist
 *  semantics, not a second one). */
export interface LlmModelPolicy {
  /** Exact model ids this agent kind may call. A model outside the list → 403. */
  readonly allowedModels: readonly string[];
}

/** One usage row for the shared `token_usage` ledger writer. */
export interface LlmProxyUsageRecord {
  readonly source: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly sessionId?: string;
}

/** W4 metered usage for a single upstream response, handed to the budget hook. */
export interface LlmProxyMeteredUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/** The budget hook's per-call verdict. */
export interface LlmProxyBudgetDecision {
  /** THIS call's accumulation crossed the cap ⇒ the proxy answers 402 and the
   *  job has already been marked `budget_exceeded` + terminated by the hook. */
  readonly exceeded: boolean;
}

/**
 * W4 budget metering + enforcement hook (implemented by `llmProxyAccounting.ts`).
 * When wired, every billable (2xx) response is routed through `meter` for an
 * atomic accumulate-and-readback with post-hoc enforcement; a job already
 * `budget_exceeded` is pre-gated to 402 by the proxy's auth step. Absent ⇒ the
 * W1 `addJobUsage` + `recordUsage` metering path runs unchanged (no enforcement).
 */
export interface LlmProxyBudgetHook {
  /** Optional ceiling clamped into the forwarded body's `max_tokens`, bounding a
   *  single post-hoc overshoot to one response (spec §5). */
  readonly maxOutputTokens?: number;
  /** Meter one response's usage, enforce the budget, and report whether THIS call
   *  crossed the cap. Never throws into the proxy. */
  meter(input: {
    jobId: string;
    model: string;
    usage: LlmProxyMeteredUsage;
  }): Promise<LlmProxyBudgetDecision>;
}

export interface LlmProxyDeps {
  /** Resolve a job from its phone-home bearer token (sha256-hash match) or null. */
  resolveJobByToken(token: string): Promise<LlmProxyJob | null>;
  /** Resolve the model allowlist for an agent kind. */
  resolvePolicy(agentKind: string): Promise<LlmModelPolicy | null>;
  /** The dev jobs' kernel operator jobs (`operatorJobs@1`). Absent (a kernel
   *  without the model gateway) ⇒ every call answers 503. */
  operatorJobs?: DevJobOperatorJobs | undefined;
  /** The kernel's Anthropic Messages passthrough (`modelPassthrough@1`) — the
   *  ONLY way this proxy reaches a model. Absent ⇒ every call answers 503. */
  modelPassthrough?: ModelPassthroughService | undefined;
  /** Atomic per-job increment: `UPDATE dev_jobs SET tokens_in = tokens_in + $1,
   *  tokens_out = tokens_out + $2 …`. W1 records; W4 enforces budget on the same statement. */
  addJobUsage(jobId: string, tokensIn: number, tokensOut: number): Promise<void>;
  /** Ledger writer. Defaults to the shared `@omadia/usage-telemetry` recorder. */
  recordUsage?: (record: LlmProxyUsageRecord) => void;
  /** W4 budget metering + enforcement (see {@link LlmProxyBudgetHook}). Optional:
   *  absent ⇒ the W1 metering path (`addJobUsage` + `recordUsage`) runs unchanged
   *  with no budget enforcement. */
  budget?: LlmProxyBudgetHook;
  /** Called when the authoritative `addJobUsage` write fails — the accounting
   *  loss is surfaced (and counted) rather than swallowed. Default: no-op (the
   *  error is still logged at error level). */
  onAccountingError?: (err: unknown, ctx: { jobId: string; tokensIn: number; tokensOut: number }) => void;
  /** Structured log sink (e.g. mid-stream truncation notes). */
  log?: (msg: string) => void;
  /** Hard cap on a forwarded request body, in bytes. Default 25 MiB. */
  maxBodyBytes?: number;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;
/** Hard ceiling on the response the ENFORCED (buffered) path holds in memory before
 *  committing it — the OOM backstop that does not depend on the optional max_tokens
 *  clamp being wired (Forge W4 audit #2). A real LLM response is far under this. */
const MAX_ENFORCED_BUFFER_BYTES = 32 * 1024 * 1024;
const USAGE_SOURCE = 'dev-job';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/**
 * The ONLY client request headers forwarded upstream (allowlist, not denylist —
 * the same lesson the W0 shim env learned). Everything else a hostile job
 * container sends — `cookie`, `x-forwarded-*`, `proxy-authorization`, the client
 * `authorization`/`x-api-key`, and every hop-by-hop header — is dropped here,
 * before the kernel sees the request. `content-type` + `anthropic-version` are
 * set here; the KERNEL attaches the credentials (and applies the same
 * allowlist again on its side).
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'content-type',
]);

/** Response headers not copied back: hop-by-hop + encoding/length that Node's
 *  fetch has already decoded away and express will recompute, PLUS auth-like
 *  headers an upstream/intermediary might echo — the instance's provider key
 *  must never be handed back to the container the proxy exists to keep it away
 *  from. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'keep-alive',
  // auth-like echoes (review S-finding).
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'set-cookie',
  'www-authenticate',
  'proxy-authenticate',
]);

function fail(res: Response, status: number, code: string, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ code, message });
}

/** `Bearer <token>`, case-insensitive; else null. */
function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() || null : null;
}

/** Write a chunk to the client, honoring backpressure so a slow client cannot
 *  make us buffer the whole upstream stream in memory. */
function writeChunk(res: Response, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = res.write(Buffer.from(chunk), (err) => {
      if (err) reject(err);
    });
    if (ok) resolve();
    else res.once('drain', resolve);
  });
}

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------

export function createLlmProxyRouter(deps: LlmProxyDeps): Router {
  const router = Router();
  const {
    resolveJobByToken,
    resolvePolicy,
    operatorJobs,
    modelPassthrough,
    addJobUsage,
    budget,
    recordUsage = defaultRecordUsage,
    onAccountingError = () => {},
    log = () => {},
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  } = deps;

  // --- GET / --------------------------------------------------------------
  // The CLI probes the origin root before its first POST (option-D spike
  // finding 3). Any 2xx satisfies it; this is an unauthenticated liveness ping
  // that leaks nothing (no job, no policy, no key touched).
  router.get('/', (_req, res) => {
    res.status(200).json({ ok: true, service: 'omadia-dev-llm-proxy' });
  });

  // --- POST /v1/messages (and ?beta=true) ---------------------------------
  router.post(
    '/v1/messages',
    expressRaw({ type: () => true, limit: maxBodyBytes }),
    (req, res, next) => {
      void handleMessages(req, res).catch(next);
    },
  );

  async function handleMessages(req: Request, res: Response): Promise<void> {
    // 1. Authenticate the job token; unknown/wrong → 401 (no oracle).
    const token = bearerToken(req);
    if (!token) {
      fail(res, 401, 'devplatform.unauthorized', 'missing or malformed bearer token');
      return;
    }
    const job = await resolveJobByToken(token);
    if (!job) {
      fail(res, 401, 'devplatform.unauthorized', 'invalid job token');
      return;
    }
    // 2. A `budget_exceeded` job answers the runner a fatal 402 (spec §5, W4) so
    //    it converges by exiting; every OTHER terminal answers 410. The store's
    //    `resolveJobByToken` deliberately surfaces `budget_exceeded` (and only it)
    //    among terminals for exactly this signal — see its note.
    //    A terminal job also ends its kernel operator job (the finalize revoker
    //    normally did already; this covers a finalize on another replica).
    if (job.status === 'budget_exceeded') {
      endOperatorJob(job);
      fail(res, 402, 'dev.budget_exceeded', 'job LLM budget exhausted');
      return;
    }
    if (isTerminalDevJobStatus(job.status)) {
      endOperatorJob(job);
      fail(res, 410, 'devplatform.job_terminal', 'job has reached a terminal state');
      return;
    }

    // 3. Parse the request body and CANONICALISE it. `express.raw` yields a
    //    Buffer; we parse it, enforce the model allowlist on the PARSED object,
    //    and forward `JSON.stringify(parsed)` (step 6) — never the raw bytes.
    //    This kills the whole "validate one representation, forward another"
    //    class (duplicate keys, `\u`-escaped keys, whitespace/nesting tricks):
    //    after canonicalisation the forwarded body carries exactly one `model`
    //    field, holding the value that was checked here.
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const rawText = rawBody.length > 0 ? rawBody.toString('utf8') : '';
    let parsed: unknown;
    try {
      parsed = rawText.length > 0 ? JSON.parse(rawText) : {};
    } catch {
      fail(res, 400, 'devplatform.invalid_body', 'request body must be valid JSON');
      return;
    }
    // A non-object top-level body (array, string, number, null) can never be a
    // valid Messages request and must not be forwarded.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail(res, 400, 'devplatform.invalid_body', 'request body must be a JSON object');
      return;
    }
    const parsedObj = parsed as Record<string, unknown>;
    const model = parsedObj['model'];
    if (typeof model !== 'string' || model.length === 0) {
      fail(res, 400, 'devplatform.invalid_body', 'request body must name a model');
      return;
    }

    // 4. Resolve provider + model allowlist (the ctx.llm gate semantics).
    const policy = await resolvePolicy(job.agentKind);
    if (!policy) {
      fail(res, 500, 'devplatform.no_provider', 'no LLM policy configured for this agent kind');
      return;
    }
    if (!policy.allowedModels.includes(model)) {
      fail(res, 403, 'dev.model_not_allowed', 'requested model is not permitted for this repository');
      return;
    }

    // 4b. W4: clamp `max_tokens` to the budget hook's ceiling so a single
    //    post-hoc-metered response can overshoot the cap by at most one bounded
    //    request (spec §5). The proxy canonicalises the body (step 6), so this
    //    clamp is guaranteed to reach upstream.
    if (budget?.maxOutputTokens !== undefined) {
      const ceiling = budget.maxOutputTokens;
      const requested = parsedObj['max_tokens'];
      parsedObj['max_tokens'] =
        typeof requested === 'number' && requested > 0 ? Math.min(requested, ceiling) : ceiling;
    }

    // 5. The kernel's model gateway is the only way to a model. A kernel
    //    without it (older than plugin-api 1.78.0, or this plugin not running
    //    as a system module) gets a named 503 — never a direct provider call.
    if (!operatorJobs || !modelPassthrough) {
      fail(
        res,
        503,
        'devplatform.model_gateway_unavailable',
        "the kernel's model gateway (operatorJobs@1 + modelPassthrough@1) is not available to the dev platform",
      );
      return;
    }

    // 6. The dev job's operator job: opened on its first call, then reused.
    let operatorJob: OperatorJob;
    try {
      operatorJob = await operatorJobs.acquire(job);
    } catch (err) {
      failGateway(res, job, err);
      return;
    }

    // 7. Forward the CANONICAL body (re-serialised from the parsed object).
    //    `?beta=true` (and any other query) is preserved.
    const queryIdx = req.originalUrl.indexOf('?');
    const query = queryIdx === -1 ? '' : req.originalUrl.slice(queryIdx);
    const forwardBody = Buffer.from(JSON.stringify(parsedObj), 'utf8');

    // A runner that hangs up stops the upstream call instead of leaving it
    // streaming (and billing) into a closed socket.
    const clientGone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) clientGone.abort();
    });

    await proxyUpstream({
      res,
      job,
      model,
      forward: () =>
        modelPassthrough.forwardAnthropicMessages({
          job: operatorJob,
          query,
          headers: buildForwardHeaders(req),
          body: forwardBody,
          signal: clientGone.signal,
        }),
      operatorJob,
    });
  }

  /** End a terminal dev job's operator job, without holding up the answer. */
  function endOperatorJob(job: LlmProxyJob): void {
    if (!operatorJobs) return;
    void operatorJobs.end(job.id, terminalOutcome(job.status));
  }

  /** Answer a gateway refusal as a named JSON error; anything else as a 503. */
  function failGateway(res: Response, job: LlmProxyJob, err: unknown): void {
    if (err instanceof DevJobOperatorJobEndedError) {
      fail(res, 410, 'devplatform.job_terminal', 'job has reached a terminal state');
      return;
    }
    const refusal = classifyGatewayError(err);
    log(`[dev-llm] model gateway refused job ${job.id}: ${errText(err)}`);
    if (refusal) {
      fail(res, refusal.status, refusal.code, refusal.message);
      return;
    }
    fail(res, 503, 'devplatform.model_gateway_error', 'the model gateway could not open an operator job for this dev job');
  }

  async function proxyUpstream(args: {
    res: Response;
    job: LlmProxyJob;
    model: string;
    forward: () => Promise<globalThis.Response>;
    operatorJob: OperatorJob;
  }): Promise<void> {
    const { res, job, model, forward, operatorJob } = args;

    // Retry loop: a 5xx or a connect error may be retried ONCE — but only here,
    // BEFORE any byte reaches the client. Once streaming starts, this loop is
    // gone, so a streamed request that emitted tokens can never be retried. A
    // gateway REFUSAL is never retried: it answers at once with what refused.
    let upstream: globalThis.Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        upstream = await forward();
      } catch (err) {
        if (classifyGatewayError(err)) {
          failGateway(res, job, err);
          return;
        }
        if (operatorJob.signal.aborted) {
          // The operator cancelled the job (or its deadline passed) mid-call.
          fail(res, 410, 'dev.model_call_refused.cancelled', 'the operator job of this dev job was cancelled or reached its deadline');
          return;
        }
        if (res.destroyed) return; // the runner hung up; nobody to answer
        if (attempt === 0) continue; // one retry on a connect-level failure
        fail(res, 502, 'devplatform.upstream_unreachable', 'LLM provider is unreachable');
        log(`[dev-llm] upstream unreachable for job ${job.id}: ${errText(err)}`);
        return;
      }
      if (upstream.status >= 500 && attempt === 0) continue; // one retry on 5xx
      break;
    }
    if (!upstream) {
      fail(res, 502, 'devplatform.upstream_unreachable', 'LLM provider is unreachable');
      return;
    }

    // Status + headers pass through verbatim (Retry-After on 429 included). Under
    // W4 budget enforcement a billable (2xx) body is metered BEFORE it is
    // committed, so header/status writes are deferred to `copyStatusHeaders`,
    // called only once the budget decision is known.
    const copyStatusHeaders = (): void => {
      res.status(upstream!.status);
      upstream!.headers.forEach((value, key) => {
        if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
      });
    };

    if (!upstream.body) {
      copyStatusHeaders();
      res.end();
      return;
    }

    const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
    const isSse = contentType.includes('text/event-stream');

    // Non-stream ERROR bodies are buffered and defensively scrubbed of
    // credential-shaped strings before they reach the container: an
    // upstream/intermediary that reflects the request (incl. the key the kernel
    // injected) into an error payload must not hand it to the job. Not metered
    // (no usage), so budget enforcement never engages here. Success bodies
    // stream/deliver through the same redactor (below).
    if (!isSse && upstream.status >= 400) {
      copyStatusHeaders();
      let errBody: Buffer;
      try {
        errBody = redactCredentials(Buffer.from(await upstream.arrayBuffer()));
      } catch (err) {
        log(`[dev-llm] error body unreadable for job ${job.id}: ${errText(err)}`);
        errBody = Buffer.alloc(0);
      }
      res.removeHeader('content-length');
      res.end(errBody);
      return;
    }

    // W4: a billable (2xx) response under an active budget hook is metered and
    // enforced BEFORE delivery, so the call that crosses the cap can itself
    // answer 402 (spec §5). Without a budget hook the W1 stream-through path runs.
    if (budget !== undefined) {
      await proxyMeteredEnforced({
        res,
        job,
        model,
        body: upstream.body as AsyncIterable<Uint8Array>,
        isSse,
        copyStatusHeaders,
      });
      return;
    }

    copyStatusHeaders();
    const acc = newUsage();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let jsonBuffer = '';
    let truncated = false;
    // Redact credential-shaped strings from every byte written downstream (incl.
    // streamed SSE error events an upstream might echo the key into). The
    // redactor holds back a possible credential start, so one cannot be split
    // across two chunks.
    const redactor = new StreamRedactor();

    try {
      for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        // Meter on the RAW upstream bytes (the key never appears in usage JSON),
        // then write the REDACTED bytes to the client.
        const text = decoder.decode(buf, { stream: true });
        if (isSse) sseBuffer = drainSse(acc, sseBuffer + text);
        else jsonBuffer += text;
        const safe = redactor.push(buf);
        if (safe.length > 0) await writeChunk(res, safe);
      }
      const tail = redactor.flush();
      if (tail.length > 0) await writeChunk(res, tail);
    } catch (err) {
      // Mid-stream disconnect: keep whatever usage we accumulated; note the
      // truncation. Best-effort flush of the redactor's retained tail so the
      // client is not shorted the (already redacted) bytes we held back.
      truncated = true;
      log(`[dev-llm] stream truncated for job ${job.id}: ${errText(err)}`);
      try {
        const tail = redactor.flush();
        if (tail.length > 0) await writeChunk(res, tail);
      } catch {
        /* client already gone — nothing to flush to */
      }
    }

    if (!isSse && jsonBuffer.length > 0) {
      try {
        const parsed = JSON.parse(jsonBuffer) as Record<string, unknown>;
        applyUsage(acc, parsed['usage']);
      } catch {
        /* non-JSON / partial body — nothing to meter */
      }
    }

    res.end();
    await meterUsage(job, model, acc, truncated);
  }

  async function meterUsage(
    job: LlmProxyJob,
    model: string,
    acc: UsageAccumulator,
    truncated: boolean,
  ): Promise<void> {
    if (!acc.seen) return;
    const tokensIn = acc.inputTokens + acc.cacheReadTokens + acc.cacheCreationTokens;
    const tokensOut = acc.outputTokens;

    // dev_jobs is the AUTHORITATIVE per-job counter (W4 enforces budget on it),
    // so it is written FIRST. Its failure is NOT swallowed: it is logged at error
    // level, counted via `onAccountingError`, and — crucially — the ledger row is
    // then SKIPPED, so the two stores can never diverge into "billed the ledger
    // but not dev_jobs". (The shared usage-telemetry recorder is a non-blocking,
    // buffered sink that drops in in-memory-KG mode and cannot join a pg
    // transaction, so authoritative-first ordering is the strongest guarantee
    // available here — see the unit's review note.)
    try {
      await addJobUsage(job.id, tokensIn, tokensOut);
    } catch (err) {
      log(`[dev-llm] ERROR addJobUsage failed for job ${job.id} (${String(tokensIn)}/${String(tokensOut)} tok): ${errText(err)}`);
      onAccountingError(err, { jobId: job.id, tokensIn, tokensOut });
      return;
    }

    // Ledger row — source + session id are the dev-platform provenance. Reached
    // only after the authoritative increment committed.
    recordUsage({
      source: USAGE_SOURCE,
      model,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens,
      sessionId: `devjob:${job.id}`,
    });
    if (truncated) log(`[dev-llm] recorded partial usage for truncated job ${job.id}`);
  }

  /**
   * W4 metered + enforced delivery of a billable (2xx) response. The upstream
   * body is fully consumed and redacted into a bounded buffer (the `max_tokens`
   * clamp caps its size), usage is accumulated, then the budget hook meters and
   * enforces BEFORE anything is written to the client:
   *
   *   - crossed  ⇒ the buffered body is discarded and the in-flight call is
   *     answered `402 dev.budget_exceeded`. The hook has already marked the job
   *     `budget_exceeded` (finalize) and terminated the backend. The provider was
   *     still billed for this one request — the accepted single-request overshoot.
   *   - under budget ⇒ the redacted body is delivered verbatim.
   *
   * A mid-stream upstream disconnect meters the partial usage and delivers the
   * partial bytes when not over budget (matching the W1 truncation contract).
   */
  async function proxyMeteredEnforced(args: {
    res: Response;
    job: LlmProxyJob;
    model: string;
    body: AsyncIterable<Uint8Array>;
    isSse: boolean;
    copyStatusHeaders: () => void;
  }): Promise<void> {
    const { res, job, model, body, isSse, copyStatusHeaders } = args;
    const acc = newUsage();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let jsonBuffer = '';
    let truncated = false;
    const redactor = new StreamRedactor();
    const chunks: Buffer[] = [];
    let bytesRead = 0;

    try {
      for await (const chunk of body) {
        const buf = Buffer.from(chunk);
        // Hard independent byte ceiling (Forge W4 audit #2): the enforced path
        // BUFFERS the whole response to meter it before committing, so a hostile job
        // that sets a huge `max_tokens` could OOM the middleware. The `max_tokens`
        // clamp normally bounds this, but it is an OPTIONAL wire dep — this ceiling
        // is the defense-in-depth backstop that does NOT depend on wire discipline.
        bytesRead += buf.length;
        if (bytesRead > MAX_ENFORCED_BUFFER_BYTES) {
          truncated = true;
          log(`[dev-llm] enforced response for job ${job.id} exceeded ${String(MAX_ENFORCED_BUFFER_BYTES)}B; truncating to bound memory`);
          break;
        }
        // Meter on the RAW upstream bytes; buffer the REDACTED bytes for delivery.
        const text = decoder.decode(buf, { stream: true });
        if (isSse) sseBuffer = drainSse(acc, sseBuffer + text);
        else jsonBuffer += text;
        const safe = redactor.push(buf);
        if (safe.length > 0) chunks.push(safe);
      }
      const tail = redactor.flush();
      if (tail.length > 0) chunks.push(tail);
    } catch (err) {
      truncated = true;
      log(`[dev-llm] stream truncated for job ${job.id}: ${errText(err)}`);
      try {
        const tail = redactor.flush();
        if (tail.length > 0) chunks.push(tail);
      } catch {
        /* nothing retained */
      }
    }

    if (!isSse && jsonBuffer.length > 0) {
      try {
        const parsed = JSON.parse(jsonBuffer) as Record<string, unknown>;
        applyUsage(acc, parsed['usage']);
      } catch {
        /* non-JSON / partial body — nothing to meter */
      }
    }

    // Meter + enforce (post-hoc, but BEFORE the response is committed). The hook
    // never throws into the proxy; a metering failure fails OPEN (delivers the
    // response) rather than 402-ing a legitimate call.
    let decision: LlmProxyBudgetDecision = { exceeded: false };
    if (acc.seen) {
      decision = await budget!.meter({
        jobId: job.id,
        model,
        usage: {
          inputTokens: acc.inputTokens,
          outputTokens: acc.outputTokens,
          cacheReadTokens: acc.cacheReadTokens,
          cacheCreationTokens: acc.cacheCreationTokens,
        },
      });
    }

    if (decision.exceeded) {
      fail(res, 402, 'dev.budget_exceeded', 'job LLM budget exhausted');
      return;
    }

    copyStatusHeaders();
    try {
      for (const c of chunks) await writeChunk(res, c);
    } catch (err) {
      // Client vanished mid-delivery — nothing more to do; usage is already metered.
      log(`[dev-llm] client write failed for job ${job.id}: ${errText(err)}`);
    }
    res.end();
    if (truncated) log(`[dev-llm] delivered partial (truncated) metered response for job ${job.id}`);
  }

  return router;
}

/** Build the forwarded request headers from an ALLOWLIST (not a scrub-list). Any
 *  header not explicitly allowed — cookies, `x-forwarded-*`,
 *  `proxy-authorization`, the client's own auth, and all hop-by-hop headers —
 *  never reaches the kernel or upstream. Keys are lower-case, the shape the
 *  passthrough reads. The kernel adds the credentials. */
function buildForwardHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  // Headers named by the `Connection` header are hop-by-hop and MUST be stripped
  // by a proxy (RFC 7230 §6.1). A client that writes `Connection: anthropic-beta`
  // must not have `Anthropic-Beta` forwarded even though it is allowlisted.
  const connectionNamed = new Set<string>();
  const conn = req.headers['connection'];
  const connValues = Array.isArray(conn) ? conn : conn === undefined ? [] : [conn];
  for (const cv of connValues) {
    for (const token of cv.split(',')) {
      const name = token.trim().toLowerCase();
      if (name) connectionNamed.add(name);
    }
  }
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (connectionNamed.has(lower)) continue; // hop-by-hop per the Connection header
    if (!FORWARDED_REQUEST_HEADERS.has(lower)) continue;
    out[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  out['anthropic-version'] ??= DEFAULT_ANTHROPIC_VERSION;
  // The body is the canonical JSON re-serialisation (step 7), whatever the client claimed.
  out['content-type'] = 'application/json';
  return out;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
