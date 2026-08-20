import { useState } from 'react';

import { Link } from '@/lib/router';
import { useTranslations } from '@/lib/i18n';

import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { DevRepoCredentialKind, DevRepoView } from '@/lib/api';

/**
 * Epic #470 W0 — the repo list (UI spec §2). One full-width table panel; state
 * is text color + row edges only, never a filled chip. The first-run empty
 * state is a centered panel with the "omadia never merges" framing.
 */

const thCls =
  'px-2 py-1 text-left text-xs font-medium uppercase tracking-wide text-fg-muted';
const tdCls = 'px-2 py-2 text-sm align-top';

function credentialClass(kind: DevRepoCredentialKind): string {
  if (kind === 'github_app') return 'text-success';
  if (kind === 'device_flow') return 'text-warning';
  return 'text-fg-muted';
}

function credentialKey(kind: DevRepoCredentialKind): 'githubApp' | 'deviceFlow' | 'pat' {
  if (kind === 'github_app') return 'githubApp';
  if (kind === 'device_flow') return 'deviceFlow';
  return 'pat';
}

export function RepoTable({
  repos,
  onNewJob,
  onRemove,
  onRecheck,
  recheckingId,
}: {
  repos: DevRepoView[];
  onNewJob: (repo: DevRepoView) => void;
  onRemove: (repo: DevRepoView) => void;
  onRecheck: (repo: DevRepoView) => void;
  recheckingId: string | null;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.repos');
  const [pendingRemove, setPendingRemove] = useState<DevRepoView | null>(null);

  if (repos.length === 0) {
    return (
      <div className="mx-auto max-w-xl rounded-lg border-t border-r border-b border-l border-border bg-surface p-6 text-center">
        <h2 className="text-base font-semibold text-fg-strong">{t('empty.heading')}</h2>
        <p className="mt-2 text-sm text-fg-muted">{t('empty.body')}</p>
        <div className="mt-4 flex justify-center">
          <Link href="/admin/dev-platform/repos/new">
            <Button variant="primary" size="sm">
              {t('empty.cta')}
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm text-fg-muted">{t('count', { count: repos.length })}</span>
        <Link href="/admin/dev-platform/repos/new">
          <Button variant="primary" size="sm">
            {t('add')}
          </Button>
        </Link>
      </div>
      <div className="overflow-x-auto rounded-lg border-t border-r border-b border-l border-border bg-surface">
        <table className="w-full w-auto">
          <thead>
            <tr className="border-b border-border">
              <th className={thCls}>{t('name')}</th>
              <th className={thCls}>{t('forge')}</th>
              <th className={thCls}>{t('credential')}</th>
              <th className={thCls}>{t('branch')}</th>
              <th className={thCls}>{t('protectionCol')}</th>
              <th className={thCls} />
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => {
              const expired = !repo.credential.isSet;
              return (
                <tr
                  key={repo.id}
                  className={`border-b border-border ${
                    expired ? 'border-l border-l border-danger' : ''
                  }`}
                >
                  <td className={tdCls}>
                    <div className="text-fg-strong">
                      {repo.owner}/{repo.name}
                    </div>
                    <div className="font-mono text-xs text-fg-subtle">{repo.cloneUrl}</div>
                    {expired ? (
                      <div className="text-xs text-danger">{t('credentialExpired')}</div>
                    ) : null}
                  </td>
                  <td className={tdCls}>{repo.forgeKind}</td>
                  <td className={tdCls}>
                    <span className={credentialClass(repo.credential.kind)}>
                      {t(`credentialModes.${credentialKey(repo.credential.kind)}`)}
                    </span>
                  </td>
                  <td className={`${tdCls} font-mono text-xs`}>{repo.defaultBranch}</td>
                  <td className={tdCls}>
                    <ProtectionCell repo={repo} onRecheck={onRecheck} rechecking={recheckingId === repo.id} />
                  </td>
                  <td className={tdCls}>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="secondary" onClick={() => onNewJob(repo)}>
                        {t('newJob')}
                      </Button>
                      <Link href={`/admin/dev-platform/repos/${encodeURIComponent(repo.id)}`}>
                        <Button size="sm" variant="ghost">
                          {t('settings')}
                        </Button>
                      </Link>
                      <Button size="sm" variant="danger" onClick={() => setPendingRemove(repo)}>
                        {t('remove.action')}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={pendingRemove !== null}
        tone="danger"
        title={t('remove.title')}
        body={t('remove.body')}
        confirmLabel={t('remove.confirm')}
        cancelLabel={t('remove.cancel')}
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove) onRemove(pendingRemove);
          setPendingRemove(null);
        }}
      />
    </div>
  );
}

function ProtectionCell({
  repo,
  onRecheck,
  rechecking,
}: {
  repo: DevRepoView;
  onRecheck: (repo: DevRepoView) => void;
  rechecking: boolean;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.repos.protection');
  if (repo.branchProtectionOk === true) {
    return <span className="text-success">{t('protected')}</span>;
  }
  if (repo.branchProtectionOk === false) {
    return (
      <span className="text-danger" title={t('warning')}>
        {t('unprotected')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-fg-subtle">{t('unchecked')}</span>
      <Button
        size="sm"
        variant="ghost"
        busy={rechecking}
        busyLabel={t('rechecking')}
        onClick={() => onRecheck(repo)}
      >
        {t('recheck')}
      </Button>
    </span>
  );
}
