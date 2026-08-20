/**
 * `@omadia/dev-platform-plugin-api` — the public `DevJob*` type contract.
 *
 * ## Where these came from
 *
 * These types used to sit on the published `@omadia/plugin-api` surface,
 * because they were the wire shape of `ctx.devJobs`. They are NOT there any
 * more. Epic #470 (`specs/470-dev-platform-plugin/dormant-capabilities.md` §2)
 * found that nothing ever provided the backing `'devJobs'` host service — the
 * accessor threw on every invocation and no manifest in any byte5 repo ever
 * declared `permissions.devJobs` — so `ctx.devJobs` and two of its six types
 * were deleted outright. The tombstone is still readable at
 * `middleware/packages/plugin-api/src/pluginContext.ts:1407-1426`.
 *
 * What survived that deletion lives at `middleware/src/devplatform/devJobTypes.ts`
 * (descriptor + event record) and `middleware/src/devplatform/types.ts`
 * (the `DevJobKind` / `DevJobStatus` vocabulary). This file is a verbatim copy
 * of that surviving surface, with the doc comments intact.
 *
 * ## Two types are deliberately NOT here
 *
 * `DevJobCreateRequest` and `DevJobsAccessor` were the write half of the
 * deleted accessor. Resurrecting them into a brand-new published package would
 * re-create exactly the speculative generality that #470 removed: an interface
 * with zero providers and zero consumers, frozen into a contract. They come
 * back only when something actually calls them.
 *
 * ## A contradiction the maintainer should settle
 *
 * `devJobTypes.ts`'s own header states these types should stay CORE-LOCAL and
 * travel with the dev-platform tree — "deliberately NOT a new published
 * package". The #470 phase table (`implementation.md`, row P0–P1) says the
 * opposite: publish `@omadia/dev-platform-plugin-api`. This package exists
 * because P0 asked for it; if the core-local reading wins, delete this package
 * and fold the types into `packages/plugin/src/` before anything publishes.
 * See README.md → "Open questions".
 *
 * ## Types only
 *
 * The `as const` arrays (`DEV_JOB_STATUSES`, `DEV_JOB_KINDS`) and their
 * `isDevJob*` runtime guards stay with the dev-platform tree and arrive in P3.
 * This package emits no runtime values — only `.d.ts`.
 */

/** Job kind. Mirrors the `dev_jobs.kind` CHECK. `file_issues` was cut (phantom). */
export type DevJobKind = 'analyze' | 'fix_issue' | 'implement';

/** Job lifecycle. Mirrors the `dev_jobs.status` CHECK in 0022. */
export type DevJobStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'waiting'
  | 'applying'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'stalled'
  | 'budget_exceeded';

/** Read-only projection of a dev job. Deliberately omits the creator, runner
 *  token, cost, and raw diff artifacts — the forge PR page is the review
 *  surface (epic non-goal). */
export interface DevJobDescriptor {
  readonly id: string;
  readonly repoId: string;
  readonly kind: DevJobKind;
  readonly status: DevJobStatus;
  readonly phase: string;
  readonly branch?: string;
  readonly prUrl?: string;
  readonly createdAt: string;
}

/** One entry of the append-only job event log, projected for a reader. */
export interface DevJobEventRecord {
  readonly id: number;
  /** Server-assigned ordering key (event timestamp, ISO 8601). */
  readonly at: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}
