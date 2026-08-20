/**
 * The two safety interlocks, and the coercion that stands between a web form
 * and a boolean.
 *
 * ## Why the interlocks get their own suite
 *
 * In core these were `loadConfig()` throws — one misconfigured `DEV_*` key took
 * the entire host offline at boot. `plan.md` §6 is explicit that they CANNOT be
 * expressed as a flat field list, and that shipping them as two independent
 * optional booleans would "silently delete a boot-time safety refusal". So they
 * moved to `activate()`, and the thing that must be proven is that they still
 * FIRE — a refusal that quietly stopped refusing is indistinguishable from a
 * correct configuration until the day it matters.
 *
 * ## Why the coercion gets its own suite
 *
 * The registry stores setup answers as they came out of a form: a `boolean`
 * field can arrive as `true` or as `"true"`, an `integer` as `7` or `"7"`. A
 * coercion that only handled the native shape would read `"true"` as truthy —
 * fine — but would read `"false"` as truthy too, which turns an operator's
 * explicit "no" into a "yes". That is the bug this suite exists for.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DevPlatformActivationRefused,
  SETUP_FIELD_KEYS,
  buildDevPlatformConfig,
  devPlatformActivationRefusals,
  isTrackerPollingEnabled,
} from '../src/pluginConfig.js';

/** A `ctx.config` double over a plain answers object. */
const answers = (o: Record<string, unknown>) => ({ get: <T,>(k: string) => o[k] as T | undefined });

void describe('activation refusals (the interlocks)', () => {
  void it('refuses subscription mode without its acknowledgment', () => {
    const r = devPlatformActivationRefusals({
      subscriptionMode: true,
      subscriptionAck: undefined,
      unsafeLocal: false,
      localUid: undefined,
    });
    assert.equal(r.length, 1);
    assert.match(r[0] ?? '', /subscription_ack/);
  });

  void it('accepts subscription mode WITH its acknowledgment', () => {
    assert.deepEqual(
      devPlatformActivationRefusals({
        subscriptionMode: true,
        subscriptionAck: 'Marcel Wege',
        unsafeLocal: false,
        localUid: undefined,
      }),
      [],
    );
  });

  void it('refuses the unsafe local backend without a uid', () => {
    const r = devPlatformActivationRefusals({
      subscriptionMode: false,
      subscriptionAck: undefined,
      unsafeLocal: true,
      localUid: undefined,
    });
    assert.equal(r.length, 1);
    assert.match(r[0] ?? '', /unsafe_local_uid/);
  });

  void it('accepts uid 0 as SET — the "never root" rule is the backend\'s, not the interlock\'s', () => {
    // Core's refusal asked only "is it set?". `LocalProcessBackend`'s own
    // constructor enforces non-root. Duplicating that rule here would put the
    // same policy in two places, where they can disagree.
    assert.deepEqual(
      devPlatformActivationRefusals({
        subscriptionMode: false,
        subscriptionAck: undefined,
        unsafeLocal: true,
        localUid: 0,
      }),
      [],
    );
  });

  void it('reports BOTH violations at once rather than one per restart', () => {
    const r = devPlatformActivationRefusals({
      subscriptionMode: true,
      subscriptionAck: undefined,
      unsafeLocal: true,
      localUid: undefined,
    });
    assert.equal(r.length, 2);
  });

  void it('buildDevPlatformConfig throws DevPlatformActivationRefused, naming every refusal', () => {
    assert.throws(
      () => buildDevPlatformConfig(answers({ subscription_mode: true, unsafe_local: true }), {}),
      (err: unknown) => {
        assert.ok(err instanceof DevPlatformActivationRefused);
        assert.equal(err.refusals.length, 2);
        assert.match(err.message, /subscription_ack/);
        assert.match(err.message, /unsafe_local_uid/);
        return true;
      },
    );
  });
});

void describe('setup-answer coercion', () => {
  void it('reads the string "false" as false, not as a truthy string', () => {
    const cfg = buildDevPlatformConfig(answers({ webhooks_enabled: 'false' }), {});
    assert.equal(cfg.webhooks.enabled, false);
  });

  void it('reads the string "true" as true', () => {
    const cfg = buildDevPlatformConfig(answers({ subscription_mode: 'true', subscription_ack: 'ack' }), {});
    assert.equal(cfg.subscriptionModeEnabled, true);
  });

  void it('reads a string integer', () => {
    const cfg = buildDevPlatformConfig(answers({ max_concurrent_jobs: '7' }), {});
    assert.equal(cfg.maxConcurrentJobs, 7);
  });

  void it('falls back to core’s default when an answer is absent or unparseable', () => {
    assert.equal(buildDevPlatformConfig(answers({}), {}).maxConcurrentJobs, 2);
    assert.equal(buildDevPlatformConfig(answers({ max_concurrent_jobs: 'lots' }), {}).maxConcurrentJobs, 2);
  });

  void it('splits a host_list answer whether it arrives as an array or a CSV string', () => {
    assert.deepEqual(
      [...(buildDevPlatformConfig(answers({ llm_allowed_models: ['a', ' b '] }), {}).llm?.allowedModels ?? [])],
      ['a', 'b'],
    );
    assert.deepEqual(
      [...(buildDevPlatformConfig(answers({ llm_allowed_models: 'a, b ,' }), {}).llm?.allowedModels ?? [])],
      ['a', 'b'],
    );
  });

  void it('an empty model list stays EMPTY rather than becoming undefined', () => {
    // Empty means "the proxy answers 500 with no policy" — a real, documented
    // state. `undefined` would let a downstream `??` substitute a default and
    // quietly authorise a model the operator never listed.
    const cfg = buildDevPlatformConfig(answers({}), {});
    assert.deepEqual([...(cfg.llm?.allowedModels ?? ['NOT-EMPTY'])], []);
  });
});

void describe('deployment facts come from env, not from the install form', () => {
  void it('reads the runner image, daemon and Fly app from the environment', () => {
    const cfg = buildDevPlatformConfig(answers({}), {
      DEV_RUNNER_IMAGE: 'ghcr.io/byte5ai/dev-runner:1',
      DEV_RUNNER_DAEMON_URL: 'http://daemon:9000',
      DEV_RUNNER_DAEMON_TOKEN: 'tok',
      DEV_FLY_RUNNER_APP: 'omadia-runners',
      FLY_APP_NAME: 'omadia-prod',
    });
    assert.equal(cfg.runnerImage, 'ghcr.io/byte5ai/dev-runner:1');
    assert.equal(cfg.daemonUrl, 'http://daemon:9000');
    assert.equal(cfg.fly?.runnerApp, 'omadia-runners');
    // FLY_APP_NAME's PRESENCE is the on-/off-Fly detector and its VALUE is what
    // the dedicated-app refusal compares against — so it is read, never asked.
    assert.equal(cfg.fly?.hostAppName, 'omadia-prod');
    assert.ok(!SETUP_FIELD_KEYS.includes('fly_app_name' as never));
  });

  void it('DEV_RUNNER_IMAGE wins over DEV_RUNNER_DEFAULT_IMAGE', () => {
    const cfg = buildDevPlatformConfig(answers({}), {
      DEV_RUNNER_IMAGE: 'a',
      DEV_RUNNER_DEFAULT_IMAGE: 'b',
    });
    assert.equal(cfg.runnerImage, 'a');
  });
});

void describe('tracker polling', () => {
  void it('is off unless the operator explicitly turns it on', () => {
    assert.equal(isTrackerPollingEnabled(answers({})), false);
    assert.equal(isTrackerPollingEnabled(answers({ tracker_polling_enabled: 'false' })), false);
    assert.equal(isTrackerPollingEnabled(answers({ tracker_polling_enabled: true })), true);
  });
});
