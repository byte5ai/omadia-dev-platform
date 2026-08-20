import type { ReactElement } from 'react';

import { I18nProvider } from '@/lib/i18n';
import { RouterProvider, matchRoute, useRouter } from '@/lib/router';
import type { Locale } from '@/lib/appearance';
import { HubScreen } from '@/screens/HubScreen';
import { JobDetailScreen } from '@/screens/JobDetailScreen';
import { RepoDetailScreen } from '@/screens/RepoDetailScreen';
import { RepoNewScreen } from '@/screens/RepoNewScreen';

/**
 * The SPA shell: providers plus the four-way route switch.
 *
 * There is no navigation chrome here on purpose. This document is embedded in
 * an iframe by web-ui's `/plugin-ui/<pluginId>` page, which already renders
 * the shell's header, sidebar and page title around it. Drawing a second
 * header inside the frame would give the operator two of everything.
 *
 * The four routes are the four screens the epic's acceptance matrix names
 * (`acceptance.md` §2.7): hub, job detail, repo detail, add-repo wizard.
 */
function Routes(): ReactElement {
  const { path } = useRouter();
  const route = matchRoute(path);

  switch (route.kind) {
    case 'hub':
      return <HubScreen />;
    case 'job':
      return <JobDetailScreen jobId={route.id} />;
    case 'repo-new':
      return <RepoNewScreen />;
    case 'repo':
      return <RepoDetailScreen repoId={route.id} />;
    case 'not-found':
      return <NotFound path={path} />;
  }
}

function NotFound({ path }: { path: string }): ReactElement {
  // No i18n key exists for this: core's Next router answered an unknown
  // dev-platform path with the shell's own 404 page, so the string was never
  // in `adminDevPlatform.*`. Inventing a key here would put a message in the
  // catalogue that core's translators never see. The path is the useful part.
  return (
    <main className="p-6">
      <p className="text-sm text-fg-muted">
        Unknown route: <code className="font-mono">{path}</code>
      </p>
      <p className="mt-2 text-sm">
        <a className="text-accent underline hover:decoration-accent" href="#/">
          ← Dev Platform
        </a>
      </p>
    </main>
  );
}

export function App({ locale }: { locale: Locale }): ReactElement {
  return (
    <I18nProvider locale={locale}>
      <RouterProvider>
        <Routes />
      </RouterProvider>
    </I18nProvider>
  );
}
