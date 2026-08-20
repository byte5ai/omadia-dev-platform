import { useState } from 'react';

import { useTranslations } from '@/lib/i18n';

import { Button } from '@/components/ui/Button';
import { patchRepo, type DevRepoView } from '@/lib/api';

/**
 * Epic #470 W4 — webhook trigger kill switch (spec §3). Two independent reasons
 * a repo will not trigger, surfaced together so the operator understands why:
 *   1. `webhookEnabled` false — the per-repo kill switch is off.
 *   2. `webhookSenders` empty — no sender is allow-listed, so even an enabled
 *      webhook refuses every labeled-issue delivery (finding S7).
 * State is text color only (Lume §4/§13); the toggle reuses the Button `busy`
 * recipe — no spinner.
 */
export function RepoWebhookPanel({
  repo,
  onSaved,
}: {
  repo: DevRepoView;
  onSaved: (repo: DevRepoView) => void;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.repoDetail.webhook');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const enabled = repo.webhookEnabled;
  const sendersEmpty = repo.webhookSenders.length === 0;
  const effectivelyOff = !enabled || sendersEmpty;

  const toggle = (): void => {
    setError(false);
    setSaving(true);
    void patchRepo(repo.id, { webhookEnabled: !enabled }).then(
      (updated) => {
        setSaving(false);
        onSaved(updated);
      },
      () => {
        setSaving(false);
        setError(true);
      },
    );
  };

  return (
    <div className="rounded-lg border-t border-r border-b border-l border-border p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg-strong">{t('heading')}</h2>
        <Button
          variant={enabled ? 'danger' : 'secondary'}
          size="sm"
          busy={saving}
          busyLabel={t('saving')}
          onClick={toggle}
        >
          {enabled ? t('disable') : t('enable')}
        </Button>
      </div>
      <p className="mt-1 text-xs text-fg-muted">{t('help')}</p>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <dt className="text-fg-subtle">{t('statusLabel')}</dt>
        <dd className={effectivelyOff ? 'text-warning' : 'text-success'}>
          {enabled ? t('enabledStatus') : t('disabledStatus')}
        </dd>

        <dt className="text-fg-subtle">{t('triggerLabelLabel')}</dt>
        <dd className="font-mono text-xs">{repo.triggerLabel}</dd>

        <dt className="text-fg-subtle">{t('sendersLabel')}</dt>
        <dd>
          {sendersEmpty ? (
            <span className="text-warning">{t('sendersEmpty')}</span>
          ) : (
            <span className="font-mono text-xs">{repo.webhookSenders.join(', ')}</span>
          )}
        </dd>
      </dl>

      {error ? (
        <p className="mt-3 text-xs text-danger">{t('saveError')}</p>
      ) : null}
    </div>
  );
}
