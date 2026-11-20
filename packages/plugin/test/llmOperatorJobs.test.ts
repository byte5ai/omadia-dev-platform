import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { TERMINAL_FINISH_BRAND, type TerminalWriteResult } from '../src/devJobStore.js';
import { CredentialRevokerRegistry, finalizeDevJob, type FinalizeStore } from '../src/finalizeDevJob.js';
import type { OperatorJob, OperatorJobsService } from '../src/host/modelGateway.js';
import {
  DevJobOperatorJobEndedError,
  createDevJobOperatorJobs,
  operatorJobRevoker,
} from '../src/llmOperatorJobs.js';
import type { DevJob, DevJobStatus } from '../src/types.js';

/**
 * Spec 2042 §5.10 — one kernel operator job per dev job: opened lazily, reused,
 * ended on every terminal path (through the finalize revoker registry).
 */

interface Opened {
  input: Parameters<OperatorJobsService['open']>[0];
  ended: Array<{ failed?: boolean; message?: string } | undefined>;
}

function fakeService(opts: { failOpen?: () => Error } = {}) {
  const opened: Opened[] = [];
  const service: OperatorJobsService = {
    open: async (input) => {
      if (opts.failOpen) throw opts.failOpen();
      const entry: Opened = { input, ended: [] };
      opened.push(entry);
      const job: OperatorJob = {
        id: `op-${String(opened.length)}`,
        signal: new AbortController().signal,
        end: async (outcome) => {
          entry.ended.push(outcome);
        },
      };
      return job;
    },
  };
  return { service, opened };
}

const NOW = Date.parse('2026-11-20T12:00:00Z');

describe('devJobOperatorJobs', () => {
  it('opens once per dev job and hands every caller the same job', async () => {
    const { service, opened } = fakeService();
    const jobs = createDevJobOperatorJobs({ service, wallClockMs: 45 * 60_000, now: () => NOW });
    const [a, b] = await Promise.all([jobs.acquire({ id: 'd1' }), jobs.acquire({ id: 'd1' })]);
    const c = await jobs.acquire({ id: 'd1' });
    assert.equal(opened.length, 1);
    assert.equal(a, b);
    assert.equal(a, c);
    assert.equal(jobs.openCount, 1);
  });

  it('bounds the job by the remaining wall clock plus a grace, and by the configured call budget', async () => {
    const { service, opened } = fakeService();
    const jobs = createDevJobOperatorJobs({ service, wallClockMs: 45 * 60_000, budgetCalls: 300, now: () => NOW });
    await jobs.acquire({ id: 'd1', createdBy: 'op@example.com', startedAt: new Date(NOW - 15 * 60_000).toISOString() });
    assert.deepEqual(opened[0]!.input, {
      kind: 'dev_job',
      startedBy: 'op@example.com',
      budgetCalls: 300,
      deadlineMs: 30 * 60_000 + 60_000,
      effects: ['pull_request'],
    });

    // Not started yet ⇒ the whole wall clock; (nearly) used up ⇒ the floor.
    await jobs.acquire({ id: 'd2' });
    assert.equal(opened[1]!.input.deadlineMs, 45 * 60_000 + 60_000);
    assert.equal(opened[1]!.input.startedBy, undefined);
    await jobs.acquire({ id: 'd3', startedAt: new Date(NOW - 50 * 60_000).toISOString() });
    assert.equal(opened[2]!.input.deadlineMs, 60_000 + 60_000);
  });

  it('a refused open is not cached', async () => {
    let refuse = true;
    const { service, opened } = fakeService();
    const wrapped: OperatorJobsService = {
      open: async (input) => {
        if (refuse) throw new Error('daily budget used up');
        return service.open(input);
      },
    };
    const jobs = createDevJobOperatorJobs({ service: wrapped, wallClockMs: 60_000 });
    await assert.rejects(jobs.acquire({ id: 'd1' }), /daily budget/);
    assert.equal(jobs.openCount, 0);
    refuse = false;
    await jobs.acquire({ id: 'd1' });
    assert.equal(opened.length, 1);
  });

  it('end() ends the kernel job once, and the dev job cannot open another', async () => {
    const { service, opened } = fakeService();
    const jobs = createDevJobOperatorJobs({ service, wallClockMs: 60_000 });
    await jobs.acquire({ id: 'd1' });
    await jobs.end('d1', { failed: false, message: 'dev job done' });
    await jobs.end('d1', { failed: false, message: 'dev job done' });
    assert.deepEqual(opened[0]!.ended, [{ failed: false, message: 'dev job done' }]);
    assert.equal(jobs.openCount, 0);
    await assert.rejects(jobs.acquire({ id: 'd1' }), (err: unknown) => err instanceof DevJobOperatorJobEndedError);
    assert.equal(opened.length, 1);
  });

  it('end() of a dev job that never called a model is a no-op that never throws', async () => {
    const { service, opened } = fakeService({ failOpen: () => new Error('x') });
    const jobs = createDevJobOperatorJobs({ service, wallClockMs: 60_000 });
    await jobs.end('never-opened');
    await assert.rejects(jobs.acquire({ id: 'd1' }));
    await jobs.end('d1');
    assert.equal(opened.length, 0);
  });

  it('endAll() ends every open job (plugin deactivation)', async () => {
    const { service, opened } = fakeService();
    const jobs = createDevJobOperatorJobs({ service, wallClockMs: 60_000 });
    await jobs.acquire({ id: 'd1' });
    await jobs.acquire({ id: 'd2' });
    await jobs.endAll('dev platform stopped');
    assert.deepEqual(
      opened.map((o) => o.ended),
      [[{ message: 'dev platform stopped' }], [{ message: 'dev platform stopped' }]],
    );
    assert.equal(jobs.openCount, 0);
  });
});

describe('devJobOperatorJobs — ended on every terminal path (finalize revoker)', () => {
  function job(status: DevJobStatus): DevJob {
    return { id: 'd1', status, runnerHandle: null } as unknown as DevJob;
  }

  function store(initial: DevJob): FinalizeStore {
    let current = initial;
    return {
      getJob: async () => current,
      finishTerminal: async (brand, _id, status): Promise<TerminalWriteResult> => {
        assert.equal(brand, TERMINAL_FINISH_BRAND);
        current = { ...current, status };
        return { job: current, transitioned: true };
      },
      appendHostEvent: async () => null,
    };
  }

  for (const [status, failed] of [
    ['done', false],
    ['failed', true],
    ['cancelled', true],
    ['budget_exceeded', true],
  ] as const) {
    it(`finalize → ${status} ends the operator job (failed: ${String(failed)})`, async () => {
      const { service, opened } = fakeService();
      const jobs = createDevJobOperatorJobs({ service, wallClockMs: 60_000 });
      await jobs.acquire({ id: 'd1' });
      const revokers = new CredentialRevokerRegistry();
      revokers.register(operatorJobRevoker(jobs));

      await finalizeDevJob({ store: store(job('running')), revokers }, 'd1', status);

      assert.deepEqual(opened[0]!.ended, [{ failed, message: `dev job ${status}` }]);
      assert.equal(jobs.openCount, 0);
    });
  }
});
