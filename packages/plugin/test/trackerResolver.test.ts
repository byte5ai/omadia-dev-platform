/**
 * The inverted tracker seam — replaces `trackerRegistry.test.ts`, which is
 * deleted along with the registry it tested (`dormant-capabilities.md` #4).
 *
 * The behaviour that had to survive the inversion is the RESOLUTION ORDER: an
 * explicit `tracker_kind` beats the built-in, and an unbound repo yields null.
 * The behaviour that had to CHANGE is what happens when a declared kind has no
 * provider — the registry silently fell through to GitHub Issues, which polls
 * the wrong tickets for a repo whose operator asked for Jira. That is now a skip
 * with a named log line.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createTrackerResolver,
  trackerCapabilityName,
  type DevTrackerProvider,
} from '../src/triggers/trackerResolver.js';
import type { DevPlatformTracker } from '../src/routes/devPlatformShared.js';
import type { DevRepo } from '../src/types.js';

const tracker = (tag: string): DevPlatformTracker => ({
  getTicket: async () => ({ id: tag, number: 1, title: tag, body: '', labels: [], updatedAt: '' }) as never,
  listOpenTickets: async () => [],
});

function repo(over: Partial<DevRepo> = {}): DevRepo {
  return {
    id: 'r1',
    owner: 'byte5ai',
    name: 'omadia',
    credentialKind: 'pat',
    trackerKind: null,
    trackerConfig: {},
    ...over,
  } as DevRepo;
}

void describe('tracker capability naming', () => {
  void it('carries the KIND, so Jira and Linear are not mutually exclusive', () => {
    // A bare `devTracker@1` would collide twice over: `provide` throws on a
    // duplicate name, and so does the boot provider index.
    assert.equal(trackerCapabilityName('jira'), 'devTracker.jira');
    assert.notEqual(trackerCapabilityName('jira'), trackerCapabilityName('linear'));
  });
});

void describe('createTrackerResolver', () => {
  void it('prefers a plugin provider over the built-in for an explicitly bound repo', async () => {
    const provider: DevTrackerProvider = { forRepo: () => tracker('jira') };
    const resolve = createTrackerResolver({
      resolveCapability: (n) => (n === 'devTracker.jira' ? provider : undefined),
      makeGithubTracker: async () => tracker('github'),
    });
    // github_app credential AND tracker_kind='jira' — the explicit binding wins.
    const t = await resolve(repo({ trackerKind: 'jira', credentialKind: 'github_app' }));
    assert.equal((await t?.getTicket(1) as { id: string }).id, 'jira');
  });

  void it('hands the provider an opaque binding, never the internal DevRepo row', async () => {
    let seen: unknown;
    const provider: DevTrackerProvider = {
      forRepo: (b) => {
        seen = b;
        return tracker('jira');
      },
    };
    await createTrackerResolver({
      resolveCapability: () => provider,
      makeGithubTracker: async () => null,
    })(repo({ trackerKind: 'jira', trackerConfig: { project: 'PROJ' } }));
    assert.deepEqual(seen, { repoId: 'r1', owner: 'byte5ai', name: 'omadia', config: { project: 'PROJ' } });
  });

  void it('SKIPS a repo whose declared kind has no provider, rather than polling GitHub instead', async () => {
    const logs: string[] = [];
    const t = await createTrackerResolver({
      resolveCapability: () => undefined,
      makeGithubTracker: async () => tracker('github'),
      log: (m) => logs.push(m),
    })(repo({ trackerKind: 'jira', credentialKind: 'github_app' }));
    assert.equal(t, null, 'the operator asked for Jira; quietly polling GitHub Issues creates jobs from the wrong tickets');
    assert.ok(logs.some((l) => l.includes('devTracker.jira')));
  });

  void it('falls back to the built-in GitHub tracker for an unbound github_app repo', async () => {
    const t = await createTrackerResolver({
      makeGithubTracker: async () => tracker('github'),
    })(repo({ credentialKind: 'github_app' }));
    assert.equal((await t?.getTicket(1) as { id: string }).id, 'github');
  });

  void it('returns null for a repo with no tracker binding at all', async () => {
    const t = await createTrackerResolver({ makeGithubTracker: async () => tracker('github') })(repo());
    assert.equal(t, null);
  });

  void it('degrades instead of aborting the sweep when the lookup throws', async () => {
    // `ctx.services.get` throws `ServiceNotDeclaredError` for an undeclared
    // name. That is a manifest bug — it must not take the whole poll down.
    const logs: string[] = [];
    const t = await createTrackerResolver({
      resolveCapability: () => {
        throw new Error('not declared in manifest');
      },
      makeGithubTracker: async () => tracker('github'),
      log: (m) => logs.push(m),
    })(repo({ trackerKind: 'jira' }));
    assert.equal(t, null);
    assert.ok(logs.some((l) => l.includes('not declared')));
  });

  void it('ignores a "provider" that does not implement the contract', async () => {
    const t = await createTrackerResolver({
      resolveCapability: () => ({ notForRepo: true }),
      makeGithubTracker: async () => tracker('github'),
    })(repo({ trackerKind: 'jira' }));
    assert.equal(t, null);
  });
});
