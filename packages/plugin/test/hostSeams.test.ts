/**
 * The reimplemented core seams. Each is a copy of something that stayed in core,
 * and a copy is only safe while it BEHAVES the same — so each gets the
 * behaviour pinned rather than the shape.
 *
 * See SEAMS.md for why each one is a copy rather than a capability.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parseIsoDurationMs } from '../src/host/isoDuration.js';
import { isInternalHost, isInternalIp } from '../src/host/ssrfGuard.js';
import {
  DEV_PLATFORM_VAULT_NAMESPACE,
  InMemorySecretVault,
  secretVaultFromContext,
} from '../src/host/vault.js';
import {
  __resetUsageRecorderForTests,
  computeCostUsd,
  droppedUsageRows,
  installUsageRecorder,
  priceForModel,
  recordUsage,
} from '../src/host/usageTelemetry.js';
import { DeviceFlowStore } from '../src/host/deviceFlow.js';

void describe('S4 — parseIsoDurationMs', () => {
  void it('parses the restricted grammar the gate deadline uses', () => {
    assert.equal(parseIsoDurationMs('PT30M'), 30 * 60_000);
    assert.equal(parseIsoDurationMs('P1DT2H'), (86400 + 7200) * 1000);
    assert.equal(parseIsoDurationMs(' PT1S '), 1000);
  });
  void it('returns null for absent, unparseable, or non-positive input', () => {
    // A deadline of zero is not a deadline — returning 0 would expire every gate
    // on its first sweep.
    assert.equal(parseIsoDurationMs(undefined), null);
    assert.equal(parseIsoDurationMs(''), null);
    assert.equal(parseIsoDurationMs('30 minutes'), null);
    assert.equal(parseIsoDurationMs('PT0S'), null);
    assert.equal(parseIsoDurationMs('P'), null);
  });
});

void describe('S3 — the SSRF predicates', () => {
  void it('rejects every private and link-local IPv4 range', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      assert.equal(isInternalIp(ip), true, ip);
    }
  });
  void it('accepts public IPv4', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '100.128.0.1']) {
      assert.equal(isInternalIp(ip), false, ip);
    }
  });
  void it('cannot be walked around by changing the notation', () => {
    // A guard defeated by brackets, a zone index, or IPv4-mapped IPv6 is not a
    // guard — 169.254.169.254 is the cloud metadata endpoint in every form.
    assert.equal(isInternalIp('[::1]'), true);
    assert.equal(isInternalIp('::ffff:169.254.169.254'), true);
    assert.equal(isInternalIp('fe80::1%eth0'), true);
    assert.equal(isInternalIp('fd00::1'), true);
    assert.equal(isInternalIp('2606:4700::1'), false);
  });
  void it('treats deployment-internal hostnames as internal, including the FQDN root form', () => {
    assert.equal(isInternalHost('localhost'), true);
    assert.equal(isInternalHost('localhost.'), true);
    assert.equal(isInternalHost('omadia.internal'), true);
    assert.equal(isInternalHost('metadata.google.internal'), true);
    assert.equal(isInternalHost('api.github.com'), false);
  });
});

void describe('S1 — the vault adapter', () => {
  void it('round-trips through the plugin’s own, already-scoped secret store', async () => {
    const store = new Map<string, string>();
    const vault = secretVaultFromContext({
      get: async (k) => store.get(k),
      keys: async () => [...store.keys()],
      set: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
    });
    await vault.set(DEV_PLATFORM_VAULT_NAMESPACE, 'repo/1/token', 'abc');
    assert.equal(await vault.get(DEV_PLATFORM_VAULT_NAMESPACE, 'repo/1/token'), 'abc');
    await vault.setMany(DEV_PLATFORM_VAULT_NAMESPACE, { a: '1', b: '2' });
    assert.deepEqual((await vault.listKeys(DEV_PLATFORM_VAULT_NAMESPACE)).sort(), ['a', 'b', 'repo/1/token']);
    await vault.deleteKey(DEV_PLATFORM_VAULT_NAMESPACE, 'a');
    assert.equal(await vault.get(DEV_PLATFORM_VAULT_NAMESPACE, 'a'), undefined);
  });

  void it('THROWS on a foreign namespace rather than silently writing into its own', async () => {
    // Under core the namespace argument selected a subsystem. Here it cannot,
    // and an adapter that ignored a non-dev-platform namespace would hide a real
    // mistake behind a write that looked successful.
    const vault = secretVaultFromContext({
      get: async () => undefined,
      keys: async () => [],
      set: async () => undefined,
    });
    await assert.rejects(() => vault.set('core:something-else', 'k', 'v'), /vault_namespace/);
  });

  void it('THROWS when the write capability was not granted', async () => {
    const vault = secretVaultFromContext({ get: async () => undefined, keys: async () => [] });
    await assert.rejects(() => vault.set(DEV_PLATFORM_VAULT_NAMESPACE, 'k', 'v'), /vault_readonly/);
  });

  void it('the in-memory double keeps namespaces disjoint', async () => {
    const v = new InMemorySecretVault();
    await v.set('a', 'k', '1');
    await v.set('b', 'k', '2');
    assert.equal(await v.get('a', 'k'), '1');
    assert.equal(await v.get('b', 'k'), '2');
  });
});

void describe('S6 — usage telemetry', () => {
  void it('prices and costs a call the same way core does', () => {
    const price = priceForModel('claude-opus-4-8');
    assert.ok(price.inputPerMTok > 0, 'a model with no price silently gets a $0 budget that never fires');
    const cost = computeCostUsd('claude-opus-4-8', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    assert.equal(cost, price.inputPerMTok);
  });

  void it('drops ledger rows loudly-once when no host capability is installed', () => {
    __resetUsageRecorderForTests();
    const row = { source: 'dev-platform', model: 'claude-opus-4-8', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
    recordUsage(row);
    recordUsage(row);
    assert.equal(droppedUsageRows(), 2, 'the count is what makes the gap visible in operations');
  });

  void it('forwards to the host capability once installed, and restores on dispose', () => {
    __resetUsageRecorderForTests();
    const seen: unknown[] = [];
    const undo = installUsageRecorder({ recordUsage: (r) => seen.push(r) });
    const row = { source: 'dev-platform', model: 'claude-opus-4-8', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
    recordUsage(row);
    assert.equal(seen.length, 1);
    assert.equal(droppedUsageRows(), 0);
    // deactivate() must not leave a reference to a torn-down host module.
    undo();
    recordUsage(row);
    assert.equal(seen.length, 1);
    assert.equal(droppedUsageRows(), 1);
    __resetUsageRecorderForTests();
  });
});

void describe('S5 — the device-flow store', () => {
  void it('keeps core’s 0.8 slack on the poll interval', () => {
    // An exact comparison rejects a well-behaved client whose timer fires a
    // millisecond early, which reads to the operator as a broken flow.
    let now = 1_000_000;
    const store = new DeviceFlowStore({ now: () => now });
    store.start('sub', 'dc', 10, 900);
    store.markPolled('sub');
    now += 7_900;
    assert.equal(store.isTooSoon('sub'), true);
    now += 200; // 8.1s of a 10s interval — inside the slack
    assert.equal(store.isTooSoon('sub'), false);
  });

  void it('expires lazily on read, so no timer is needed', () => {
    let now = 0;
    const store = new DeviceFlowStore({ now: () => now });
    store.start('sub', 'dc', 5, 10);
    assert.ok(store.get('sub'));
    now = 11_000;
    assert.equal(store.get('sub'), undefined);
    assert.equal(store.size(), 0, 'the expired entry is dropped, not merely hidden');
  });
});

void describe('C7 — the pool the kernel lends is BORROWED', () => {
  void it('nothing in the ported tree ends the pool or escapes to the real one', () => {
    // Since C7 `ctx.services.get('graphPool')` hands back a `borrowedPool`
    // wrapper: no `.end()`, and `connect()` does not expose `.pool`. Core could
    // do both because core OWNED the pool; a plugin that ended it would take the
    // whole host's database down on deactivate.
    //
    // Asserted over the emitted JS rather than by grepping source, so a call
    // introduced through a re-export or a helper still trips it.
    const distDir = resolve(process.cwd(), 'dist');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.js')) {
          const src = readFileSync(p, 'utf8');
          // `res.end()` is Express and unrelated; the pool call is what matters.
          if (/\bpool\.end\s*\(/.test(src) || /\.connect\(\)\.pool\b/.test(src)) offenders.push(p);
        }
      }
    };
    walk(distDir);
    assert.deepEqual(offenders, [], 'the kernel lends this pool — ending it would close the host’s database');
  });
});
