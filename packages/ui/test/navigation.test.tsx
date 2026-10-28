/**
 * Every in-app navigation target must be a route the hash router knows
 * (byte5ai/omadia#1466). The screens were ported from core's
 * `app/admin/dev-platform/…` pages and kept navigating to
 * `/admin/dev-platform…`, which `matchRoute` has never known — every view
 * but the start view ended in "Unknown route".
 *
 * Three layers: the route builders round-trip through `matchRoute`; real
 * clicks on the hub reach their screens; and no source file navigates to a
 * core path again.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { matchRoute, parseHash, routes } from '@/lib/router';
import { job, repo } from './fixtures/data';

describe('routes', () => {
  it('builds paths matchRoute resolves to the intended screen', () => {
    expect(matchRoute(parseHash(routes.hub()).path)).toEqual({ kind: 'hub' });
    expect(matchRoute(parseHash(routes.hubTab('jobs')).path)).toEqual({ kind: 'hub' });
    expect(matchRoute(parseHash(routes.job('job-1')).path)).toEqual({ kind: 'job', id: 'job-1' });
    expect(matchRoute(parseHash(routes.repoNew()).path)).toEqual({ kind: 'repo-new' });
    expect(matchRoute(parseHash(routes.repo('repo-1')).path)).toEqual({ kind: 'repo', id: 'repo-1' });
  });

  it('keeps the query on the hub and job routes', () => {
    expect(parseHash(routes.hubTab('apps')).query.get('tab')).toBe('apps');
    const q = new URLSearchParams({ phase: 'plan' });
    expect(routes.job('job-1', q)).toBe('/jobs/job-1?phase=plan');
    expect(routes.hub(new URLSearchParams({ tab: 'gates' }))).toBe('/?tab=gates');
  });

  it('encodes ids so a slash cannot add a segment', () => {
    expect(matchRoute(parseHash(routes.repo('a/b')).path)).toEqual({ kind: 'repo', id: 'a/b' });
  });
});

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
      if (/\/gates/.test(url)) return body({ gates: [] });
      if (/\/github-apps/.test(url)) return body({ apps: [] });
      throw new Error(`unstubbed fetch: ${url}`);
    }),
  );
}

beforeEach(() => {
  stubFetch();
  window.location.hash = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hub navigation', () => {
  it.each(['Jobs', 'GitHub Apps', 'Approvals'])('the %s tab stays on a known route', async (label) => {
    window.location.hash = '#/';
    render(<App locale="en" />);
    await waitFor(() => expect(screen.getByText(/omadia/)).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: label }));

    expect(window.location.hash.startsWith('#/?tab=')).toBe(true);
    expect(document.body.textContent).not.toContain('Unknown route');
  });

  it('"Add repository" opens the wizard', async () => {
    window.location.hash = '#/';
    render(<App locale="en" />);
    const add = await screen.findByRole('link', { name: 'Add repository' });

    expect(add.getAttribute('href')).toBe('#/repos/new');
    await userEvent.click(add);

    await waitFor(() => expect(window.location.hash).toBe('#/repos/new'));
    expect(document.body.textContent).not.toContain('Unknown route');
  });

  it('the job list links to the job detail route', async () => {
    window.location.hash = '#/?tab=jobs';
    render(<App locale="en" />);
    await waitFor(() => expect(document.body.textContent).toContain('Fix the flaky diagrams'));

    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(`#/jobs/${encodeURIComponent(job.id)}`);
  });
});

describe('source', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  }

  it('never navigates to a core /admin/dev-platform path', () => {
    const src = join(__dirname, '..', 'src');
    const offenders: string[] = [];
    for (const file of walk(src).filter((f) => /\.tsx?$/.test(f))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.replace(/^\s*(\*|\/\/).*$/, '');
          // API calls legitimately live under /bot-api/v1/admin/dev-platform.
          if (/['"`]\/admin\/dev-platform/.test(code)) {
            offenders.push(`${relative(src, file)}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
