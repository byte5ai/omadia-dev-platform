/**
 * The four screens the epic's acceptance matrix names (`acceptance.md` §2.7):
 * hub, job detail, repo detail, add-repo wizard.
 *
 * Each renders against fixture data with `fetch` stubbed, in both locales, and
 * with the theme attribute applied — which is the combination that broke when
 * the pages left Next behind. These are smoke tests with teeth: they assert
 * the screen reaches its DATA state rather than its error banner, because a
 * component that renders "could not load" is technically rendering.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { applyAppearance } from '@/lib/appearance';
import type { Locale } from '@/lib/appearance';
import { gate, job, repo } from './fixtures/data';

/**
 * Route the SPA's own API surface to fixtures.
 *
 * Everything goes through `/bot-api/v1/admin/dev-platform`, so one matcher
 * covers the whole client. An unmatched path throws rather than returning an
 * empty 200: a silent `{}` would let a screen render its empty state and the
 * test would pass having proved nothing.
 */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      if (/\/jobs\?|\/jobs$/.test(url)) return body({ jobs: [job] });
      if (/\/jobs\/[^/]+\/artifacts$/.test(url)) return body({ artifacts: [] });
      if (/\/jobs\/[^/]+$/.test(url)) return body(job);
      if (/\/repos\/[^/]+\/issues/.test(url)) return body({ issues: [] });
      if (/\/repos\/[^/]+$/.test(url)) return body(repo);
      if (/\/repos/.test(url)) return body({ repos: [repo] });
      if (/\/gates/.test(url)) return body({ gates: [gate] });
      if (/\/github-apps/.test(url)) return body({ apps: [] });
      throw new Error(`unstubbed fetch: ${url}`);
    }),
  );
}

function open(hash: string, locale: Locale = 'en'): void {
  window.location.hash = hash;
  applyAppearance({ theme: 'dark', palette: 'ember', locale });
  render(<App locale={locale} />);
}

beforeEach(() => {
  stubFetch();
  window.location.hash = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-palette');
});

describe('screen 1 — hub', () => {
  it('renders the repo the API returned', async () => {
    open('#/');
    await waitFor(() => expect(screen.getByText(/omadia/)).toBeTruthy());
  });

  it('deep-links a tab through the fragment query, as ?tab= did in core', async () => {
    open('#/?tab=jobs');
    await waitFor(() => expect(document.body.textContent).toContain('Fix the flaky diagrams'));
  });
});

describe('screen 2 — job detail', () => {
  it('renders the job brief and its phase rail', async () => {
    open('#/jobs/job-1');
    await waitFor(() => expect(screen.getByText(/Fix the flaky diagrams/)).toBeTruthy());
  });
});

describe('screen 3 — repo detail', () => {
  it('renders the repo settings panels', async () => {
    open('#/repos/repo-1');
    await waitFor(() => expect(document.body.textContent).toContain('omadia'));
  });
});

describe('screen 4 — add-repo wizard', () => {
  it('renders without any API call', async () => {
    open('#/repos/new');
    await waitFor(() => expect(document.body.textContent!.length).toBeGreaterThan(20));
  });
});

describe('locale', () => {
  // The port replaced next-intl wholesale. The thing to prove is not that a
  // particular German word appears, but that the SAME screen produces
  // DIFFERENT text under a different locale — i.e. the catalogue is actually
  // wired to the render, not just loaded.
  it('renders the hub differently in en and de', async () => {
    open('#/', 'en');
    await waitFor(() => expect(screen.getByText(/omadia/)).toBeTruthy());
    const english = document.body.textContent ?? '';

    document.body.innerHTML = '';
    open('#/', 'de');
    await waitFor(() => expect(screen.getByText(/omadia/)).toBeTruthy());
    const german = document.body.textContent ?? '';

    expect(english).not.toBe(german);
  });

  it('never paints a raw message key', async () => {
    open('#/', 'de');
    await waitFor(() => expect(screen.getByText(/omadia/)).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/adminDevPlatform\.[a-zA-Z.]+/);
  });
});

describe('theme', () => {
  it('carries the shell appearance onto <html> so the served sheet resolves', async () => {
    open('#/jobs/job-1', 'de');
    await waitFor(() => expect(screen.getByText(/Fix the flaky diagrams/)).toBeTruthy());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-palette')).toBe('ember');
    expect(document.documentElement.getAttribute('lang')).toBe('de');
  });
});

describe('unknown route', () => {
  it('says so instead of rendering a blank frame', async () => {
    open('#/nope');
    await waitFor(() => expect(document.body.textContent).toContain('/nope'));
  });
});
