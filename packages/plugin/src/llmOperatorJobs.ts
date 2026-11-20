/**
 * Spec 2042 §5.10 — one kernel OPERATOR JOB per dev job.
 *
 * Every model call a dev job's runner makes goes through the kernel inside an
 * operator job (`operatorJobs@1`). The job is opened lazily, on the dev job's
 * first proxied request, cached by dev-job id and reused for every later
 * request, and ended when the dev job reaches a terminal status (the finalize
 * choke point's revoker, and the LLM proxy when it sees a terminal job).
 *
 * Its bounds:
 *   - `budgetCalls`  — a ceiling on model calls (config, default 2000). The
 *     cost budget stays this plugin's own (`llmProxyAccounting.ts`); this is
 *     the kernel's independent count.
 *   - `deadlineMs`   — the dev job's REMAINING wall-clock budget plus a short
 *     grace, so the worker's wall-clock reaper stays the primary terminator.
 *     The kernel caps it at 24 h.
 *
 * Once a dev job was ended as terminal its id is remembered, so a request
 * that raced the finalize cannot open a fresh operator job for a finished dev
 * job.
 */

import type { OperatorJob, OperatorJobsService } from './host/modelGateway.js';

/** The operator-job kind, prefixed by the kernel with the plugin id. */
export const DEV_JOB_OPERATOR_KIND = 'dev_job';
/** What a dev job may cause outside the instance: a pull request. */
const DEV_JOB_EFFECTS: readonly string[] = ['pull_request'];
export const DEFAULT_OPERATOR_JOB_BUDGET_CALLS = 2000;
/** Added to the remaining wall clock, so the worker reaps before the kernel refuses. */
const DEADLINE_GRACE_MS = 60_000;
/** Lower bound for a job whose wall clock is (nearly) used up. */
const MIN_DEADLINE_MS = 60_000;
/** Bound on the remembered ended ids (one short string each). */
const MAX_ENDED_IDS = 10_000;

/** The slice of a dev job the operator job is opened from. */
export interface OperatorJobSubject {
  readonly id: string;
  /** Who requested the dev job (`dev_jobs.created_by`), when known. */
  readonly createdBy?: string | undefined;
  /** When the dev job started (`dev_jobs.started_at`), for the remaining wall clock. */
  readonly startedAt?: string | null | undefined;
}

/** Thrown by `acquire` for a dev job whose operator job was already ended as terminal. */
export class DevJobOperatorJobEndedError extends Error {
  constructor(devJobId: string) {
    super(`the operator job of dev job ${devJobId} has ended`);
    this.name = 'DevJobOperatorJobEndedError';
  }
}

export interface DevJobOperatorJobs {
  /** The operator job covering this dev job: opened on first use, then reused. */
  acquire(job: OperatorJobSubject): Promise<OperatorJob>;
  /** End the dev job's operator job (terminal). Idempotent; never throws. */
  end(devJobId: string, outcome?: { failed?: boolean; message?: string }): Promise<void>;
  /** End every open operator job (plugin deactivation). Never throws. */
  endAll(message: string): Promise<void>;
  /** Number of open (or opening) operator jobs. */
  readonly openCount: number;
}

export interface DevJobOperatorJobsDeps {
  readonly service: OperatorJobsService;
  /** The dev job's wall-clock limit (`job_wall_clock_ms`). */
  readonly wallClockMs: number;
  readonly budgetCalls?: number;
  readonly now?: () => number;
  readonly log?: (msg: string) => void;
}

export function createDevJobOperatorJobs(deps: DevJobOperatorJobsDeps): DevJobOperatorJobs {
  const open = new Map<string, Promise<OperatorJob>>();
  const ended = new Set<string>();
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const budgetCalls = deps.budgetCalls ?? DEFAULT_OPERATOR_JOB_BUDGET_CALLS;

  const deadlineFor = (job: OperatorJobSubject): number => {
    const started = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
    const remaining = Number.isFinite(started) ? deps.wallClockMs - (now() - started) : deps.wallClockMs;
    return Math.max(MIN_DEADLINE_MS, remaining) + DEADLINE_GRACE_MS;
  };

  const remember = (devJobId: string): void => {
    ended.add(devJobId);
    if (ended.size > MAX_ENDED_IDS) {
      const oldest = ended.values().next().value;
      if (oldest !== undefined) ended.delete(oldest);
    }
  };

  const endOne = async (
    devJobId: string,
    pending: Promise<OperatorJob>,
    outcome?: { failed?: boolean; message?: string },
  ): Promise<void> => {
    try {
      const job = await pending;
      await job.end(outcome);
    } catch (err) {
      // An open that failed has nothing to end; an end that failed ends at the
      // deadline. Neither may block a dev job's finalize.
      log(`[dev-llm] ending the operator job of dev job ${devJobId} failed: ${errText(err)}`);
    }
  };

  return {
    acquire(job) {
      if (ended.has(job.id)) return Promise.reject(new DevJobOperatorJobEndedError(job.id));
      const existing = open.get(job.id);
      if (existing) return existing;
      const pending = deps.service.open({
        kind: DEV_JOB_OPERATOR_KIND,
        ...(job.createdBy ? { startedBy: job.createdBy } : {}),
        budgetCalls,
        deadlineMs: deadlineFor(job),
        effects: DEV_JOB_EFFECTS,
      });
      open.set(job.id, pending);
      // A refused open is not cached: the next request asks again.
      pending.catch(() => {
        if (open.get(job.id) === pending) open.delete(job.id);
      });
      return pending;
    },

    async end(devJobId, outcome) {
      remember(devJobId);
      const pending = open.get(devJobId);
      if (!pending) return;
      open.delete(devJobId);
      await endOne(devJobId, pending, outcome);
    },

    async endAll(message) {
      const all = [...open.entries()];
      open.clear();
      await Promise.all(all.map(([id, pending]) => endOne(id, pending, { message })));
    },

    get openCount() {
      return open.size;
    },
  };
}

/** How a dev job's terminal status ends its operator job. */
export function terminalOutcome(status: string): { failed: boolean; message: string } {
  return { failed: status !== 'done', message: `dev job ${status}` };
}

/**
 * The finalize revoker that ends a dev job's operator job. Registered on the
 * `CredentialRevokerRegistry` every terminal path runs (worker stall and wall
 * clock, cancel, reaper, phase engine, budget), so the kernel stops admitting
 * the job's model calls the moment the dev job ends.
 */
export function operatorJobRevoker(
  jobs: DevJobOperatorJobs,
): (job: { readonly id: string; readonly status: string }) => Promise<void> {
  return (job) => jobs.end(job.id, terminalOutcome(job.status));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
