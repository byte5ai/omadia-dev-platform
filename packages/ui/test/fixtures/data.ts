/**
 * Fixture data for the screen tests.
 *
 * Shapes are copied from `DevRepoView` / `DevJobView` / `DevGateView` in
 * `src/lib/api.ts`, which are themselves mirrors of the router's browser-safe
 * views. Typing them as those interfaces rather than as `any` is the point: a
 * field the backend adds shows up here as a compile error, not as a screen
 * test that keeps passing against a shape the server stopped sending.
 */
import type { DevGateView, DevJobView, DevRepoView } from '@/lib/api';

export const repo: DevRepoView = {
  id: 'repo-1',
  forgeKind: 'github',
  owner: 'byte5ai',
  name: 'omadia',
  cloneUrl: 'https://github.com/byte5ai/omadia.git',
  defaultBranch: 'main',
  trackerKind: 'github_issues',
  trackerConfig: {},
  allowedTriggers: ['manual'],
  allowedLaunchers: ['operator'],
  egressAllowlist: [],
  runsTests: true,
  branchProtectionOk: true,
  branchProtectionCheckedAt: '2026-08-20T09:00:00.000Z',
  budgetCostUsd: 12.5,
  triggerLabel: 'dev-platform',
  webhookEnabled: true,
  webhookSenders: ['mwege'],
  createdBy: 'operator',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-20T09:00:00.000Z',
  credential: { kind: 'github_app', login: 'byte5ai', isSet: true },
};

export const job: DevJobView = {
  id: 'job-1',
  repoId: 'repo-1',
  kind: 'fix_issue',
  brief: 'Fix the flaky diagrams router test',
  source: 'issue',
  sourceRef: '42',
  baseSha: 'abc1234',
  backend: 'docker',
  agentKind: 'claude',
  authMode: 'app',
  provision: 1,
  phase: 'implement',
  status: 'running',
  branch: 'fix/flaky-diagrams',
  prUrl: null,
  result: null,
  error: null,
  usage: { input: 1200, output: 3400, costUsd: 0.42, budgetCostUsd: 12.5, estimated: false },
  createdBy: 'operator',
  createdAt: '2026-08-20T09:00:00.000Z',
  startedAt: '2026-08-20T09:01:00.000Z',
  endedAt: null,
  updatedAt: '2026-08-20T09:05:00.000Z',
};

export const gate: DevGateView = {
  id: 'gate-1',
  jobId: 'job-1',
  questions: [{ id: 'q1', text: 'Should the retry keep the original branch?' }],
  planArtifactId: 'artifact-1',
  planSha256: 'a'.repeat(64),
  deadlineAt: null,
  createdAt: '2026-08-20T09:03:00.000Z',
  resolvedHolders: ['operator'],
};
