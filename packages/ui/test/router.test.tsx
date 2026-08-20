/**
 * The hash router that replaced next/link + next/navigation.
 *
 * The fragment is not a stylistic choice. `pluginUiStatic.ts` serves exactly
 * two shapes — the bundle root and a real file — so a client route written
 * into the PATH would 404 on reload. Written into the fragment it never
 * reaches the server.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { Link, RouterProvider, matchRoute, parseHash, toHref, useRouter } from '@/lib/router';

describe('parseHash', () => {
  it('splits path from query', () => {
    expect(parseHash('#/jobs/abc?tab=log').path).toBe('/jobs/abc');
    expect(parseHash('#/jobs/abc?tab=log').query.get('tab')).toBe('log');
  });

  it('treats an empty fragment as the hub', () => {
    expect(parseHash('').path).toBe('/');
    expect(parseHash('#').path).toBe('/');
  });
});

describe('toHref', () => {
  it('is idempotent, so a caller may pass either form', () => {
    expect(toHref('/jobs/a')).toBe('#/jobs/a');
    expect(toHref('#/jobs/a')).toBe('#/jobs/a');
  });
});

describe('matchRoute', () => {
  it('maps the four acceptance screens', () => {
    expect(matchRoute('/')).toEqual({ kind: 'hub' });
    expect(matchRoute('/jobs/job-1')).toEqual({ kind: 'job', id: 'job-1' });
    expect(matchRoute('/repos/new')).toEqual({ kind: 'repo-new' });
    expect(matchRoute('/repos/repo-1')).toEqual({ kind: 'repo', id: 'repo-1' });
  });

  // `/repos/new` and `/repos/:id` collide on the same shape; order decides.
  // A repo literally named "new" is unaddressable, which is the right trade —
  // the wizard is a fixed route and repo ids are opaque uuids.
  it('resolves /repos/new to the wizard, not to a repo called "new"', () => {
    expect(matchRoute('/repos/new').kind).toBe('repo-new');
  });

  it('decodes a percent-encoded id', () => {
    expect(matchRoute('/repos/a%2Fb')).toEqual({ kind: 'repo', id: 'a/b' });
  });

  it('reports anything else as not-found instead of guessing', () => {
    expect(matchRoute('/nope').kind).toBe('not-found');
    expect(matchRoute('/jobs/a/b').kind).toBe('not-found');
  });
});

function Where() {
  const { path } = useRouter();
  return <span data-testid="path">{path}</span>;
}

describe('<Link>', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('renders a real anchor so middle-click and copy-link still work', () => {
    render(
      <RouterProvider>
        <Link href="/jobs/job-1">open</Link>
      </RouterProvider>,
    );
    expect(screen.getByRole('link', { name: 'open' })).toHaveProperty('hash', '#/jobs/job-1');
  });

  it('navigates on a plain click', async () => {
    render(
      <RouterProvider>
        <Link href="/jobs/job-1">open</Link>
        <Where />
      </RouterProvider>,
    );
    await userEvent.click(screen.getByRole('link', { name: 'open' }));
    expect(window.location.hash).toBe('#/jobs/job-1');
  });
});
