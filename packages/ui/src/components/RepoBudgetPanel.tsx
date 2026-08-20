import { useState } from 'react';

import { useTranslations } from '@/lib/i18n';

import { Button } from '@/components/ui/Button';
import { parseBudgetInput } from '@/lib/budget';
import { patchRepo, type DevRepoView } from '@/lib/api';

/**
 * Epic #470 W4 — per-repo cost budget (spec §5). Empty = fall back to the
 * `DEV_JOB_DEFAULT_BUDGET_USD` config default (a cleared budget is a valid
 * state, not an error). Validation is the pure `parseBudgetInput`; the field
 * only accepts a strictly-positive number.
 */

const inputCls =
  'w-40 rounded-md border-t border-r border-b border-l border-border bg-transparent px-3 py-2 text-sm ' +
  'focus-visible:outline-none focus:border-accent';

type ErrorKey = 'cost' | 'save';

export function RepoBudgetPanel({
  repo,
  onSaved,
}: {
  repo: DevRepoView;
  onSaved: (repo: DevRepoView) => void;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.repoDetail.budget');
  const [cost, setCost] = useState(repo.budgetCostUsd == null ? '' : String(repo.budgetCostUsd));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = (): void => {
    const parsedCost = parseBudgetInput(cost);
    if (!parsedCost.ok) {
      setError('cost');
      return;
    }
    setError(null);
    setSaved(false);
    setSaving(true);
    void patchRepo(repo.id, { budgetCostUsd: parsedCost.value }).then(
      (updated) => {
        setSaving(false);
        setSaved(true);
        onSaved(updated);
      },
      () => {
        setSaving(false);
        setError('save');
      },
    );
  };

  return (
    <div className="rounded-lg border-t border-r border-b border-l border-border p-4">
      <h2 className="text-sm font-semibold text-fg-strong">{t('heading')}</h2>
      <p className="mt-1 text-xs text-fg-muted">{t('help')}</p>

      <div className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-fg-muted">{t('costLabel')}</span>
          <input
            className={inputCls}
            inputMode="decimal"
            value={cost}
            onChange={(e) => {
              setCost(e.target.value);
              setSaved(false);
              setError(null);
            }}
            placeholder={t('costPlaceholder')}
            aria-invalid={error === 'cost' || undefined}
          />
          {error === 'cost' ? (
            <span className="text-danger">{t('costError')}</span>
          ) : null}
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" size="sm" busy={saving} busyLabel={t('saving')} onClick={submit}>
          {t('save')}
        </Button>
        {saved ? <span className="text-xs text-success">{t('saved')}</span> : null}
        {error === 'save' ? (
          <span className="text-xs text-danger">{t('saveError')}</span>
        ) : null}
      </div>
    </div>
  );
}
