import { useCallback, useEffect, useState } from 'react';

import { useRouter, useSearchParams } from '@/lib/router';
import { useTranslations } from '@/lib/i18n';

import { Button } from '@/components/ui/Button';
import { ApiError } from '@/lib/apiError';
import { RepoTable } from '@/components/RepoTable';
import { JobTable } from '@/components/JobTable';
import { NewJobDialog } from '@/components/NewJobDialog';
import { GithubAppsPanel } from '@/components/GithubAppsPanel';
import { GateInbox } from '@/components/GateInbox';
import {
  cancelJob,
  checkRepo,
  deleteJob,
  deleteRepo,
  listJobs,
  listRepos,
  type DevJobStatus,
  type DevJobView,
  type DevRepoView,
} from '@/lib/api';

/**
 * Epic #470 W0 — the /admin/dev-platform hub (UI spec §1). Tabbed
 * `repos | jobs`, matching the MCP Control Center page pattern exactly. Tab
 * state is deep-linkable via `?tab=`. The job list live-updates via a 5 s poll
 * (the W0-sanctioned fallback to the SSE feed); rows patch in place, no toasts.
 */

type Tab = 'repos' | 'jobs' | 'apps' | 'gates';

const TABS: readonly Tab[] = ['repos', 'jobs', 'apps', 'gates'];

function tabFromParam(value: string | null | undefined): Tab {
  return value === 'jobs' || value === 'apps' || value === 'gates' ? value : 'repos';
}

export function HubScreen(): React.ReactElement {
  const t = useTranslations('adminDevPlatform');
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = tabFromParam(params?.get('tab'));

  const setTab = useCallback(
    (next: Tab) => {
      const q = new URLSearchParams(params?.toString() ?? '');
      q.set('tab', next);
      router.replace(`/admin/dev-platform?${q.toString()}`);
    },
    [params, router],
  );

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-12 lg:px-8 lg:py-8">
      <h1 className="font-sans text-3xl leading-tight text-fg-strong">
        {t('title')}
      </h1>
      <p className="mt-3 max-w-2xl text-base leading-normal text-fg-muted">{t('intro')}</p>

      <div className="mt-8 flex flex-wrap gap-2">
        {TABS.map((k) => (
          <Button
            key={k}
            size="sm"
            variant={tab === k ? 'secondary' : 'ghost'}
            className={tab === k ? 'lume-tab-active' : undefined}
            onClick={() => setTab(k)}
          >
            {t(`tabs.${k}`)}
          </Button>
        ))}
      </div>

      <div className="mt-6">
        {tab === 'repos' ? <ReposTab /> : tab === 'jobs' ? <JobsTab /> : tab === 'apps' ? <GithubAppsPanel /> : <GateInbox />}
      </div>
    </div>
  );
}

// ── Repos tab ────────────────────────────────────────────────────────────────

type ReposState =
  | { kind: 'loading' }
  | { kind: 'ready'; repos: DevRepoView[] }
  | { kind: 'error'; code: 'unauthorized' | 'generic' };

function ReposTab(): React.ReactElement {
  const t = useTranslations('adminDevPlatform');
  const router = useRouter();
  const [state, setState] = useState<ReposState>({ kind: 'loading' });
  const [recheckingId, setRecheckingId] = useState<string | null>(null);
  const [newJobRepo, setNewJobRepo] = useState<DevRepoView | null>(null);

  const load = useCallback(() => {
    void listRepos().then(
      (res) => setState({ kind: 'ready', repos: res.repos }),
      (err) =>
        setState({
          kind: 'error',
          code: err instanceof ApiError && (err.status === 401 || err.status === 403) ? 'unauthorized' : 'generic',
        }),
    );
  }, []);

  useEffect(load, [load]);

  if (state.kind === 'loading') return <p className="text-sm text-fg-muted">{t('loading')}</p>;
  if (state.kind === 'error') {
    if (state.code === 'unauthorized') return <p className="text-sm text-fg-muted">{t('unauthorized')}</p>;
    return (
      <div className="flex items-center gap-3">
        <span className="text-sm text-danger">{t('loadError')}</span>
        <Button size="sm" variant="secondary" onClick={load}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <>
      <RepoTable
        repos={state.repos}
        recheckingId={recheckingId}
        onNewJob={setNewJobRepo}
        onRemove={(repo) => {
          void deleteRepo(repo.id).then(load, load);
        }}
        onRecheck={(repo) => {
          setRecheckingId(repo.id);
          void checkRepo(repo.id).then(
            () => {
              setRecheckingId(null);
              load();
            },
            () => setRecheckingId(null),
          );
        }}
      />
      {newJobRepo ? (
        <NewJobDialog
          repo={newJobRepo}
          onClose={() => setNewJobRepo(null)}
          onCreated={(jobId) => {
            setNewJobRepo(null);
            router.push(`/admin/dev-platform/jobs/${encodeURIComponent(jobId)}`);
          }}
        />
      ) : null}
    </>
  );
}

// ── Jobs tab ─────────────────────────────────────────────────────────────────

const inputCls =
  'rounded-md border-t border-r border-b border-l border-border bg-transparent px-2 py-1 text-xs focus-visible:outline-none focus:border-accent';

const STATUS_FILTERS: readonly DevJobStatus[] = [
  'queued',
  'provisioning',
  'running',
  'waiting',
  'applying',
  'done',
  'failed',
  'cancelled',
  'stalled',
  'budget_exceeded',
];

function JobsTab(): React.ReactElement {
  const t = useTranslations('adminDevPlatform');
  const tJobs = useTranslations('adminDevPlatform.jobs');
  const [jobs, setJobs] = useState<DevJobView[] | null>(null);
  const [repos, setRepos] = useState<DevRepoView[]>([]);
  const [errored, setErrored] = useState(false);
  const [repoFilter, setRepoFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(() => {
    void listJobs().then(
      (res) => {
        setJobs(res.jobs);
        setErrored(false);
      },
      () => setErrored(true),
    );
  }, []);

  useEffect(() => {
    void listRepos().then((res) => setRepos(res.repos), () => setRepos([]));
  }, []);

  useEffect(() => {
    load();
    // W0 live-update fallback: poll every 5 s, patch rows in place, no toast.
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (jobs === null) return <p className="text-sm text-fg-muted">{t('loading')}</p>;

  const filtered = jobs.filter(
    (j) => (!repoFilter || j.repoId === repoFilter) && (!statusFilter || j.status === statusFilter),
  );

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <select className={inputCls} value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)}>
            <option value="">{tJobs('filters.allRepos')}</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.owner}/{r.name}
              </option>
            ))}
          </select>
          <select className={inputCls} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">{tJobs('filters.allStatuses')}</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <span className="text-xs text-fg-subtle">
          {errored ? tJobs('liveLost') : tJobs('live')}
        </span>
      </div>
      <JobTable
        jobs={filtered}
        repos={repos}
        onCancel={(job) => {
          void cancelJob(job.id).then(load, load);
        }}
        onDelete={(job) => {
          void deleteJob(job.id).then(load, load);
        }}
      />
    </div>
  );
}
