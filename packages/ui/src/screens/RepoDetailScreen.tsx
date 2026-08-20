import { useCallback, useEffect, useState } from 'react';

import { Link } from '@/lib/router';
import { useTranslations } from '@/lib/i18n';

import { Button } from '@/components/ui/Button';
import { ProtectionCheckList } from '@/components/ProtectionCheckList';
import { BindGithubAppPanel } from '@/components/BindGithubAppPanel';
import { RepoBudgetPanel } from '@/components/RepoBudgetPanel';
import { RepoWebhookPanel } from '@/components/RepoWebhookPanel';
import { checkRepo, getRepo, type DevRepoView } from '@/lib/api';

/**
 * Epic #470 W0 — repo detail / settings (UI spec §1 route). Minimal in W0: the
 * onboarded facts plus an on-demand branch-protection re-check (spec §2 "the
 * check runs on demand from the repo row" — here from the detail page too).
 */

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; repo: DevRepoView }
  | { kind: 'error' };

/** The repo id arrives as a prop — see the note in `JobDetailScreen`. */
export function RepoDetailScreen({ repoId }: { repoId: string }): React.ReactElement {
  const t = useTranslations('adminDevPlatform.repoDetail');
  const id = repoId;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [rechecking, setRechecking] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    void getRepo(id).then(
      (repo) => setState({ kind: 'ready', repo }),
      () => setState({ kind: 'error' }),
    );
  }, [id]);

  useEffect(load, [load]);

  if (state.kind === 'loading') {
    return <Shell><p className="text-sm text-fg-muted">{t('loading')}</p></Shell>;
  }
  if (state.kind === 'error') {
    return <Shell><p className="text-sm text-danger">{t('loadError')}</p></Shell>;
  }

  const { repo } = state;
  const onSaved = (updated: DevRepoView): void => setState({ kind: 'ready', repo: updated });
  return (
    <Shell>
      <h1 className="font-sans text-2xl leading-tight text-fg-strong">
        {repo.owner}/{repo.name}
      </h1>
      <p className="mt-1 font-mono text-xs text-fg-subtle">{repo.cloneUrl}</p>

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <dt className="text-fg-subtle">{t('forge')}</dt>
        <dd>{repo.forgeKind}</dd>
        <dt className="text-fg-subtle">{t('branch')}</dt>
        <dd className="font-mono">{repo.defaultBranch}</dd>
        <dt className="text-fg-subtle">{t('credential')}</dt>
        <dd>{repo.credential.kind}{repo.credential.login ? ` (${repo.credential.login})` : ''}</dd>
        <dt className="text-fg-subtle">{t('runsTests')}</dt>
        <dd>{repo.runsTests ? t('yes') : t('no')}</dd>
      </dl>

      <div className="mt-6 rounded-lg border-t border-r border-b border-l border-border p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg-strong">{t('protectionHeading')}</h2>
          <Button
            size="sm"
            variant="secondary"
            busy={rechecking}
            busyLabel={t('rechecking')}
            onClick={() => {
              setRechecking(true);
              void checkRepo(repo.id).then(
                () => {
                  setRechecking(false);
                  load();
                },
                () => setRechecking(false),
              );
            }}
          >
            {t('recheck')}
          </Button>
        </div>
        <ProtectionCheckList branch={repo.defaultBranch} ok={repo.branchProtectionOk} />
      </div>

      <div className="mt-6">
        <RepoBudgetPanel repo={repo} onSaved={onSaved} />
      </div>

      <div className="mt-6">
        <RepoWebhookPanel repo={repo} onSaved={onSaved} />
      </div>

      <div className="mt-6 rounded-lg border-t border-r border-b border-l border-border p-4">
        <h2 className="text-sm font-semibold text-fg-strong">{t('credentialHeading')}</h2>
        <p className="mt-1 text-xs text-fg-muted">
          {t('credentialCurrent', { kind: repo.credential.kind })}
        </p>
        <div className="mt-4">
          <BindGithubAppPanel repoId={repo.id} onBound={load} />
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }): React.ReactElement {
  const t = useTranslations('adminDevPlatform.repoDetail');
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12 lg:px-8 lg:py-8">
      <div className="mb-6">
        <Link href="/admin/dev-platform?tab=repos" className="text-sm text-accent underline">
          {t('back')}
        </Link>
      </div>
      {children}
    </div>
  );
}
