import { Link } from '@/lib/router';
import { useTranslations } from '@/lib/i18n';

import { AddRepoWizard } from '@/components/AddRepoWizard';

/**
 * Epic #470 W0 — the add-repo wizard route (UI spec §3). Its own page (not a
 * modal) because the device flow leaves for github.com.
 */
export function RepoNewScreen(): React.ReactElement {
  const t = useTranslations('adminDevPlatform.wizard');
  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-12 lg:px-8 lg:py-8">
      <div className="mb-6">
        <Link href="/admin/dev-platform?tab=repos" className="text-sm text-accent underline">
          {t('backToRepos')}
        </Link>
      </div>
      <h1 className="font-sans text-3xl leading-tight text-fg-strong">
        {t('title')}
      </h1>
      <p className="mt-3 max-w-2xl text-base leading-normal text-fg-muted">{t('intro')}</p>
      <div className="mt-8">
        <AddRepoWizard />
      </div>
    </div>
  );
}
