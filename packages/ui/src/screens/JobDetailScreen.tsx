import { useCallback, useEffect, useRef, useState } from 'react';

import { Link, useRouter, useSearchParams } from '@/lib/router';
import { useFormatter, useTranslations } from '@/lib/i18n';

import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DevJobStatusText } from '@/components/devjobs/DevJobStatusText';
import {
  DEV_JOB_UI_PHASES,
  DevJobPhaseRail,
  computePhaseStops,
  phaseToUi,
  statusIsLive,
  type DevJobUiPhase,
} from '@/components/devjobs/DevJobPhaseRail';
import { findGateForJob } from '@/lib/gates';
import { useDevJobEvents, type DevJobEventMessage } from '@/lib/useDevJobEvents';
import { GateCard } from '@/components/GateInbox';
import { JobLogPane, type LogConnection } from '@/components/JobLogPane';
import { PhaseArtifactPanel } from '@/components/PhaseArtifactPanel';
import {
  cancelJob,
  deleteJob,
  getJob,
  isTerminalStatus,
  listWaitingGates,
  type DevGateView,
  type DevJobView,
} from '@/lib/api';
import { INITIAL_LOG_STATE, foldDevJobEvent, type LogState } from '@/lib/toolCallLog';

/**
 * Epic #470 W0 — the job-detail signature screen (UI spec §5). Header, the
 * phase rail (keyboard-operable, deep-linkable via `?phase=`), then a two-column
 * body: the log pane (driven by rail selection) and a metadata sidebar. The
 * live log streams over SSE through `useDevJobEvents` and sticks to bottom via
 * `useStickToBottom`. Every non-`gate`/`pr` phase stacks a `PhaseArtifactPanel`
 * (that phase's own recorded plan/questions/bootstrap_report/review_verdict,
 * once it exists) above the same live log pane, filtered to that phase's own
 * events (`toolCallLog.ts` stamps each item with the phase it happened in) —
 * analyze/bootstrap/plan/clarify run real agent sessions too, not just
 * implement. The log pane alone is live-only state, so navigating back to an
 * already-finished phase (or reloading the page) left it permanently empty
 * without the artifact panel as a second, persisted source.
 */

function shortHash(id: string): string {
  return id.replace(/-/g, '').slice(0, 6);
}

/**
 * The job id arrives as a PROP, not from a params hook.
 *
 * In core this was `app/admin/dev-platform/jobs/[id]/page.tsx` and the id came
 * from Next's dynamic segment via `useParams()`. Here `App.tsx` has already
 * matched the fragment (`#/jobs/<id>`) and destructured it, so re-deriving the
 * same value from a hook would give the router two sources of truth for one
 * fact. The prop also makes the screen directly renderable in a test without a
 * router around it.
 */
export function JobDetailScreen({ jobId }: { jobId: string }): React.ReactElement {
  const t = useTranslations('adminDevPlatform.detail');
  const search = useSearchParams();
  const router = useRouter();
  const id = jobId;

  const [job, setJob] = useState<DevJobView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [logState, setLogState] = useState<LogState>(INITIAL_LOG_STATE);
  const [conn, setConn] = useState<LogConnection>('reconnecting');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [agoSec, setAgoSec] = useState<number | null>(null);
  const [closedOnce, setClosedOnce] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const terminalRef = useRef(false);
  useEffect(() => {
    terminalRef.current = job ? isTerminalStatus(job.status) : false;
  }, [job]);

  // Initial load — the header can render from the route param immediately.
  useEffect(() => {
    if (!id) return;
    void getJob(id).then(
      (j) => setJob(j),
      () => setNotFound(true),
    );
  }, [id]);

  const handleEvent = useCallback((ev: DevJobEventMessage) => {
    setLastEventAt(Date.now());
    setLogState((prev) => foldDevJobEvent(prev, ev));
    if (ev.type === 'status' || ev.type === 'phase') {
      // Re-sync the authoritative view on lifecycle transitions.
      void getJob(ev.jobId).then(
        (j) => setJob(j),
        () => {},
      );
    }
  }, []);

  useDevJobEvents(id, handleEvent, {
    enabled: !closedOnce,
    onStatus: (s) => {
      if (s === 'open') setConn('live');
      else if (s === 'closed') {
        setConn('closed');
        setClosedOnce(true);
      } else {
        // transient error — reconnecting, unless the job is already terminal
        // (then the server-side close is expected: stop and mark finished).
        if (terminalRef.current) {
          setConn('closed');
          setClosedOnce(true);
        } else {
          setConn('reconnecting');
        }
      }
    },
  });

  // Tick the "last event Ns ago" counter while live.
  useEffect(() => {
    if (conn !== 'live') return;
    const timer = setInterval(() => {
      setAgoSec(lastEventAt ? Math.round((Date.now() - lastEventAt) / 1000) : 0);
    }, 1000);
    return () => clearInterval(timer);
  }, [conn, lastEventAt]);

  // Fetch the waiting gate for this job whenever it parks at the human gate —
  // shown inline on the GATE stop instead of sending the operator to a
  // separate tab to approve/reject (mirrors DevJobChatCard.tsx's pattern).
  // `gate` is derived from the fetch + the job's live status rather than
  // reset via a synchronous setState in the effect's early return: once the
  // job leaves `waiting` this naturally reads as null without a second write.
  const isWaiting = job?.status === 'waiting';
  const [fetchedGate, setFetchedGate] = useState<DevGateView | null>(null);
  const gate = isWaiting ? fetchedGate : null;

  useEffect(() => {
    if (!isWaiting) return;
    let cancelled = false;
    void listWaitingGates().then(
      (res) => {
        if (!cancelled) setFetchedGate(findGateForJob(res.gates, id));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [isWaiting, id]);

  const onGateResolved = useCallback(() => {
    setFetchedGate(null);
    void getJob(id).then(
      (j) => setJob(j),
      () => {},
    );
  }, [id]);

  // Deep-link: the viewed phase comes from `?phase=`.
  const rawPhase = search?.get('phase') ?? null;
  const selected: DevJobUiPhase | null =
    rawPhase && (DEV_JOB_UI_PHASES as readonly string[]).includes(rawPhase) ? (rawPhase as DevJobUiPhase) : null;

  const selectPhase = useCallback(
    (phase: DevJobUiPhase) => {
      const q = new URLSearchParams(search?.toString() ?? '');
      q.set('phase', phase);
      router.replace(`/admin/dev-platform/jobs/${encodeURIComponent(id)}?${q.toString()}`);
    },
    [id, router, search],
  );

  if (notFound) {
    return (
      <div className="mx-auto w-full max-w-7xl px-6 py-12">
        <p className="text-sm text-danger">{t('notFound')}</p>
      </div>
    );
  }

  const { stops, current } = job ? computePhaseStops(job) : { stops: [], current: 'implement' as DevJobUiPhase };
  const effective: DevJobUiPhase = selected ?? current;
  const live = job ? statusIsLive(job.status) : false;

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-8 lg:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-3 text-sm">
            <span className="font-mono text-fg-strong">{t('jobLabel', { hash: shortHash(id) })}</span>
            {job ? <span className="text-fg-muted">{job.kind}</span> : null}
            {job ? (
              <Link
                href={`/admin/dev-platform?tab=jobs`}
                className="text-accent underline"
              >
                {job.repoId.slice(0, 8)}
              </Link>
            ) : null}
            {job ? <DevJobStatusText status={job.status} /> : null}
          </div>
          <p className="mt-1 max-w-2xl truncate text-sm text-fg-muted" title={job?.brief}>
            {job?.brief ?? t('loading')}
          </p>
        </div>
        {job && !isTerminalStatus(job.status) ? (
          <Button variant="danger" size="sm" onClick={() => setConfirmCancel(true)}>
            {t('cancel.action')}
          </Button>
        ) : null}
        {job && isTerminalStatus(job.status) ? (
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            {t('delete.action')}
          </Button>
        ) : null}
      </div>

      {/* Phase rail */}
      <div className="mt-4">
        <DevJobPhaseRail stops={stops} current={current} selected={selected} onSelect={selectPhase} live={live} />
      </div>

      {/* Body */}
      <div className="mt-4 grid gap-6 lg:grid-cols-3">
        <div>
          {effective === 'gate' && gate ? (
            <div className="rounded-lg border-t border-r border-b border-l border-border bg-surface p-4">
              <GateCard gate={gate} onResolved={onGateResolved} compact />
            </div>
          ) : effective === 'pr' && job?.prUrl ? (
            <div className="rounded-lg border-t border-r border-b border-l border-border p-4 text-sm">
              <a href={job.prUrl} target="_blank" rel="noreferrer" className="text-accent underline">
                {t('openPr')}
              </a>
              {job.result?.summary ? (
                <p className="mt-2 text-fg-muted">{job.result.summary}</p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <PhaseArtifactPanel jobId={id} phase={effective} />
              <JobLogPane
                items={logState.items.filter((item) => phaseToUi(item.phase) === effective)}
                connection={conn}
                lastEventAgoSec={agoSec}
              />
            </div>
          )}
        </div>

        {/* Sidebar */}
        <aside>
          {job ? <Sidebar job={job} /> : null}
        </aside>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        tone="danger"
        title={t('cancel.title')}
        body={t('cancel.body')}
        confirmLabel={t('cancel.confirm')}
        cancelLabel={t('cancel.cancelLabel')}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          void cancelJob(id).then(
            () => getJob(id).then((j) => setJob(j), () => {}),
            () => {},
          );
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        tone="danger"
        title={t('delete.title')}
        body={t('delete.body')}
        confirmLabel={t('delete.confirm')}
        cancelLabel={t('delete.cancelLabel')}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void deleteJob(id).then(
            () => router.push('/admin/dev-platform?tab=jobs'),
            () => {},
          );
        }}
      />
    </div>
  );
}

function Sidebar({ job }: { job: DevJobView }): React.ReactElement {
  const t = useTranslations('adminDevPlatform.detail.sidebar');
  const format = useFormatter();
  const dt = 'text-xs uppercase tracking-wide text-fg-subtle';
  const dd = 'font-mono text-sm tabular-nums text-fg';
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border-t border-r border-b border-l border-border p-4">
      <dt className={dt}>{t('backend')}</dt>
      <dd className={dd}>{job.backend}</dd>
      <dt className={dt}>{t('agent')}</dt>
      <dd className={dd}>{job.agentKind}</dd>
      <dt className={dt}>{t('branch')}</dt>
      <dd className={`${dd} break-all`}>{job.branch ?? '—'}</dd>
      <dt className={dt}>{t('source')}</dt>
      <dd className={dd}>{job.sourceRef ?? job.source}</dd>
      <dt className={dt}>{t('createdBy')}</dt>
      <dd className={dd}>{job.createdBy}</dd>
      <dt className={dt}>{t('tokens')}</dt>
      <dd className={dd}>
        {format.number(job.usage.input)} / {format.number(job.usage.output)}
      </dd>
      <dt className={dt}>{t('cost')}</dt>
      <dd className={dd}>{format.number(job.usage.costUsd, { style: 'currency', currency: 'USD' })}</dd>
    </dl>
  );
}
