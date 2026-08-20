import { useTranslations } from '@/lib/i18n';

import type { DevJobStatus } from '@/lib/api';

/**
 * Epic #470 — the single source of the status → text-token mapping (UI spec §4).
 * State is communicated by text color only, never a filled chip; every colored
 * status also carries a literal word (accessibility §13). `provisioning` adds
 * the sanctioned busy affordance (`.`) — a verb plus stepped dots,
 * not a spinner. Reused by the job list, the job-detail header, and (W3) the
 * chat job card, so the mapping can never drift between surfaces.
 */

/** Tailwind text-color class per status. */
const STATUS_COLOR: Record<DevJobStatus, string> = {
  queued: 'text-fg-muted',
  provisioning: 'text-fg-muted',
  running: 'text-accent',
  waiting: 'text-warning',
  applying: 'text-accent',
  done: 'text-success',
  failed: 'text-danger',
  cancelled: 'text-fg-subtle',
  stalled: 'text-warning',
  budget_exceeded: 'text-danger',
};

/** i18n key per status (`adminDevPlatform.jobs.statuses.*`). */
const STATUS_KEY: Record<DevJobStatus, string> = {
  queued: 'queued',
  provisioning: 'provisioning',
  running: 'running',
  waiting: 'waiting',
  applying: 'applying',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  stalled: 'stalled',
  budget_exceeded: 'budgetExceeded',
};

/** Whether a status shows the busy dots (an in-flight, pre-run wait). */
export function statusHasBusyDots(status: DevJobStatus): boolean {
  return status === 'provisioning';
}

/** The row left-edge class for statuses that flag one (UI spec §4), else null. */
export function statusRowEdge(status: DevJobStatus): string | null {
  if (status === 'waiting') return 'border-l border-l border-warning';
  if (status === 'failed') return 'border-l border-l border-danger';
  return null;
}

export function DevJobStatusText({
  status,
  title,
}: {
  status: DevJobStatus;
  /** Optional hover detail (e.g. last heartbeat for `stalled`, budget for `budget_exceeded`). */
  title?: string;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.jobs.statuses');
  return (
    <span
      className={`text-sm ${STATUS_COLOR[status]}`}
      title={title}
      data-status={status}
    >
      {t(STATUS_KEY[status])}
      {statusHasBusyDots(status) ? <span className="" aria-hidden /> : null}
    </span>
  );
}
