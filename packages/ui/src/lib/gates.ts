import type { DevGateView } from './api';

/**
 * The one function `JobDetailScreen` needed from
 * `web-ui/app/_components/devjobs/devJobChatCardState.ts`.
 *
 * That module belongs to `DevJobChatCard`, which is H3 — the card renders
 * INSIDE core's chat transcript, not in this iframe, and `plan.md` §4.3
 * explicitly excludes the chat surface from the compiled-SPA option. Porting
 * the module to get five lines would have pulled an unshippable component into
 * the bundle and implied the chat surface was covered when it is not.
 */
export function findGateForJob(
  gates: readonly DevGateView[],
  jobId: string,
): DevGateView | null {
  return gates.find((g) => g.jobId === jobId) ?? null;
}
