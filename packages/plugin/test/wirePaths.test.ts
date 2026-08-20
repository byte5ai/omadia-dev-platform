/**
 * The four wire paths are #470 invariants (plan.md §7).
 *
 * Deployed runner images phone home to LITERAL URLs, and the GitHub App an
 * operator registered posts to a literal webhook URL. A rename bricks in-flight
 * jobs with no compile-time signal anywhere — the runner simply gets a 404 and
 * the job sits until its wall clock expires.
 *
 * `RUNNER_PROTOCOL_VERSION` is in the same class: it is the handshake between
 * this middleware and a separately-deployed shim, so bumping it here without
 * shipping a matching image silently rejects every existing runner.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { PUBLIC_PATHS, WIRE_PATHS } from '../src/plugin.js';
import { RUNNER_PROTOCOL_VERSION } from '../src/types.js';

void describe('wire paths (#470 invariant)', () => {
  void it('are exactly the four core served', () => {
    assert.equal(WIRE_PATHS.runner, '/api/v1/dev-runner');
    assert.equal(WIRE_PATHS.admin, '/api/v1/admin/dev-platform');
    assert.equal(WIRE_PATHS.githubAppPublic, '/api/v1/dev-platform');
    assert.equal(WIRE_PATHS.webhooks, '/api/webhooks/github');
  });

  void it('RUNNER_PROTOCOL_VERSION is unchanged by the extraction', () => {
    // The shim ships separately; a bump without a matching image rejects every
    // deployed runner.
    assert.equal(RUNNER_PROTOCOL_VERSION, 1);
  });

  void it('no public path is a prefix of the admin path', () => {
    // Express prefix-mounts, so `/api/v1/dev-platform` exempting
    // `/api/v1/dev-platform-admin` would be an accident nobody notices. The
    // admin surface starts `/api/v1/admin/...` precisely so no public prefix can
    // swallow it — assert that stays true.
    for (const p of PUBLIC_PATHS) {
      assert.ok(
        !WIRE_PATHS.admin.startsWith(p),
        `public path '${p}' is a prefix of the admin surface — that unauthenticates every operator route`,
      );
    }
  });
});
