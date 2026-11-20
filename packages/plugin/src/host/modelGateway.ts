/**
 * Spec 2042 §5.10 — the kernel's model gateway, as this plugin sees it.
 *
 * The dev platform is a SYSTEM MODULE. It holds no model-provider key and
 * calls no model API itself: the Claude CLI inside a job container speaks the
 * Anthropic Messages API to this plugin's LLM proxy, and the proxy forwards
 * each request through two kernel-published services:
 *
 *   operatorJobs@1     opens one OPERATOR JOB per dev job (budget of model
 *                      calls, deadline, operator cancel, recorded like every
 *                      operator job);
 *   modelPassthrough@1 forwards one `POST /v1/messages` inside that job; the
 *                      kernel adds the instance's Anthropic credentials and
 *                      admits the call against the job's budget.
 *
 * The types are declared STRUCTURALLY, mirroring `@omadia/plugin-api` 1.76.0
 * `modelPassthrough.ts`, for the same reason `DevPlatformPluginContext` is
 * (test/coreApiSurface.test.ts): CI type-checks against core `main`, and an
 * import of a name that has not landed there would break it.
 *
 * The kernel's refusals are recognised by `name` (and `code`), never by
 * `instanceof`: the error classes live in the host's module graph, which a
 * plugin cannot import from.
 */

export const OPERATOR_JOBS_SERVICE_NAME = 'operatorJobs';
export const MODEL_PASSTHROUGH_SERVICE_NAME = 'modelPassthrough';

/** One operator job, opened by the kernel for this plugin. */
export interface OperatorJob {
  readonly id: string;
  /** Aborted when an operator cancels the job and at its deadline. */
  readonly signal: AbortSignal;
  /** End the job. Idempotent; a job not ended ends at its deadline. */
  end(outcome?: { readonly failed?: boolean; readonly message?: string }): Promise<void>;
}

export interface OperatorJobsService {
  open(input: {
    readonly kind: string;
    readonly startedBy?: string;
    readonly budgetCalls: number;
    readonly deadlineMs: number;
    readonly effects: readonly string[];
  }): Promise<OperatorJob>;
}

export interface ModelPassthroughService {
  forwardAnthropicMessages(input: {
    readonly job: OperatorJob;
    /** The query string of the client's request, e.g. `?beta=true`. */
    readonly query?: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body: Uint8Array | string;
    readonly signal?: AbortSignal;
  }): Promise<Response>;
}

/** What the proxy answers the CLI for an error the gateway raised. */
export interface GatewayRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** `ModelCallRefusedError.code` → HTTP status. A cancelled or expired job is
 *  gone (410); an operator stop or a call outside any context is forbidden
 *  (403). All of them are 4xx, so the CLI stops instead of retrying. */
const REFUSED_STATUS: Readonly<Record<string, number>> = {
  cancelled: 410,
  deadline: 410,
  kill_switch: 403,
  no_context: 403,
  operation_not_allowed: 403,
};

/**
 * Classify an error the gateway threw (from `open` or from a forward). Returns
 * `null` for anything that is NOT a gateway refusal — a network failure of the
 * upstream call, which the proxy may retry once.
 */
export function classifyGatewayError(err: unknown): GatewayRefusal | null {
  if (!(err instanceof Error)) return null;
  const rawCode: unknown = (err as { code?: unknown }).code;
  const code = typeof rawCode === 'string' ? rawCode : undefined;
  switch (err.name) {
    case 'ModelCallNotCoveredError':
      // The operator job's model-call budget is used up. 402, like the job's own
      // cost budget: a fatal answer the runner converges on by exiting.
      return { status: 402, code: 'dev.model_calls_exhausted', message: err.message };
    case 'ModelWorkBudgetError':
      // The instance's daily operator-tools budget is used up; no job can open.
      return { status: 402, code: 'dev.operator_budget_exhausted', message: err.message };
    case 'ModelCallRefusedError':
      return {
        status: (code !== undefined ? REFUSED_STATUS[code] : undefined) ?? 403,
        code: `dev.model_call_refused${code !== undefined ? `.${code}` : ''}`,
        message: err.message,
      };
    case 'ModelPassthroughError':
      // No Anthropic credentials on the instance, a job the kernel does not
      // know, or this plugin not being a system module: configuration, not the
      // job. 503 names it.
      return {
        status: 503,
        code: code ?? 'model_passthrough.error',
        message: err.message,
      };
    default:
      return null;
  }
}
