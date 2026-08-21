/**
 * The manifest is the only thing the hub reads, and three of its fields are
 * duplicated in code. Every one of those duplications has a failure mode that
 * is silent at build time and expensive at install time, so each is pinned here.
 *
 *   identity.id ↔ package.json name   — diverge, and an upgrade installs a
 *                                       SECOND plugin beside the first instead
 *                                       of replacing it.
 *   identity.version ↔ package.json   — diverge, and the published artifact
 *                                       carries a version the repository does
 *                                       not believe it cut.
 *   public_paths ↔ PUBLIC_PATHS       — diverge, and a route is either
 *                                       unreachable (declared nowhere, so
 *                                       `ctx.routes.register` throws for an
 *                                       `auth:'custom'` prefix) or the manifest
 *                                       asks the operator to open a prefix
 *                                       nothing serves.
 *   setup.fields ↔ SETUP_FIELD_KEYS   — diverge, and an operator answers a
 *                                       question nothing reads, or the code
 *                                       reads a key nobody was asked.
 *
 * Parsed with a deliberately small regex reader rather than a YAML dependency:
 * this package ships no runtime deps, and the four shapes needed here are flat.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEV_PLATFORM_PLUGIN_ID, PUBLIC_PATHS, WIRE_PATHS } from '../src/plugin.js';
import { SETUP_FIELD_KEYS } from '../src/pluginConfig.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = readFileSync(resolve(pkgRoot, 'manifest.yaml'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  peerDependencies?: Record<string, string>;
};

function scalar(indent: number, key: string): string | undefined {
  const re = new RegExp(`^\\s{${String(indent)}}${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm');
  return re.exec(manifest)?.[1];
}

/** Items of a `- "value"` list under `heading:` at `indent`. Stops at the first
 *  line that is neither a list item nor a comment nor blank. */
function list(heading: string): string[] {
  // Anchored to a line start, because the explanatory comments above these keys
  // legitimately contain the word (`A \`requires:\` line is the author's own
  // say-so`) and a bare indexOf would parse the prose instead of the list.
  const anchor = new RegExp(`^${heading}:\\s*$`, 'm').exec(manifest);
  if (!anchor) return [];
  const start = anchor.index;
  const out: string[] = [];
  for (const line of manifest.slice(start).split('\n').slice(1)) {
    if (line.trim().startsWith('#') || line.trim() === '') continue;
    const m = /^\s*-\s*["']?([^"'\n]+?)["']?\s*$/.exec(line);
    if (!m?.[1]) break;
    out.push(m[1]);
  }
  return out;
}

void describe('manifest', () => {
  void it('identity matches package.json (a drift installs a second plugin, not an upgrade)', () => {
    assert.equal(scalar(2, 'id'), pkg.name);
    assert.equal(scalar(2, 'id'), DEV_PLATFORM_PLUGIN_ID);
    assert.equal(scalar(2, 'version'), pkg.version);
  });

  void it('lifecycle.entry points at a file the build actually produced', () => {
    assert.equal(scalar(2, 'entry'), 'dist/plugin.js');
    assert.ok(
      existsSync(resolve(pkgRoot, 'dist/plugin.js')),
      'dist/plugin.js missing — the hub would install an artifact that cannot load',
    );
  });

  void it('kind is one the plugin runtime will actually activate', () => {
    // `toolPluginRuntime.ts:163-168` activates tool/extension/integration only.
    assert.ok(['tool', 'extension', 'integration'].includes(scalar(2, 'kind') ?? ''));
  });

  void it('permissions.sql.ledger is a name THIS plugin may own', () => {
    const ledger = scalar(4, 'ledger');
    // The kernel derives `plg_<sanitized-plugin-id>_` from the id IT knows,
    // never from the manifest, and rejects anything outside it. Two rules ride
    // on that one name: `plg_` is kernel-reserved so no core table can live
    // there, and the folded id means a plugin cannot nominate another's ledger
    // and forge its migration history.
    assert.ok(ledger, 'permissions.sql.ledger is required');
    assert.ok(
      ledger?.startsWith('plg_omadia_dev_platform_'),
      `ledger '${String(ledger)}' is outside this plugin's reserved prefix and is refused at activation`,
    );
    assert.ok(
      (ledger ?? '').length > 'plg_omadia_dev_platform_'.length,
      'a bare namespace with no suffix is not a valid ledger table name',
    );
    // Postgres' NAMEDATALEN, and the charset that cannot terminate an
    // identifier or start a statement.
    assert.match(ledger ?? '', /^[a-z][a-z0-9_]{2,62}$/);
    assert.ok((ledger ?? '').length <= 63);
  });

  void it('permissions.sql.migrations names the directory the ZIP ships', () => {
    assert.equal(scalar(4, 'migrations'), 'migrations');
    assert.ok(existsSync(resolve(pkgRoot, 'migrations')));
  });

  void it('public_paths equals PUBLIC_PATHS exactly', () => {
    assert.deepEqual([...list('  public_paths')].sort(), [...PUBLIC_PATHS].sort());
  });

  void it('every declared public path is a wire path, and the admin surface is NOT one', () => {
    const declared = new Set(PUBLIC_PATHS);
    assert.ok(declared.has(WIRE_PATHS.runner));
    assert.ok(declared.has(WIRE_PATHS.webhooks));
    assert.ok(declared.has(WIRE_PATHS.githubAppPublic));
    // The operator surface must never be exempt. It is the one route whose only
    // authentication IS the session.
    assert.ok(
      !declared.has(WIRE_PATHS.admin),
      'the admin surface must stay session-gated — declaring it public would unauthenticate every operator route',
    );
  });

  void it('setup.fields matches SETUP_FIELD_KEYS', () => {
    const keys = [...manifest.matchAll(/^\s{4}-\s+key:\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.deepEqual(keys, [...SETUP_FIELD_KEYS]);
  });

  void it('both safety interlocks are declared as fields, or the refusal is unreachable', () => {
    for (const key of ['subscription_mode', 'subscription_ack', 'unsafe_local', 'unsafe_local_uid']) {
      assert.ok(SETUP_FIELD_KEYS.includes(key as (typeof SETUP_FIELD_KEYS)[number]), key);
      assert.ok(manifest.includes(`key: "${key}"`), `${key} missing from the manifest`);
    }
  });

  void it('every capability activate() resolves is declared in one of the two lists', () => {
    // `ctx.services.get` THROWS for an undeclared name since C2b, so an omission
    // from BOTH lists is a runtime throw, not a graceful degradation.
    const declared = new Set(
      [...list('requires'), ...list('optional_requires')].map((r) => r.split('@')[0]),
    );
    for (const cap of ['graphPool', 'turnContext', 'githubAppJwt', 'usageTelemetry', 'conductorRoles']) {
      assert.ok(declared.has(cap), `manifest declares neither requires: nor optional_requires: '${cap}@1'`);
    }
  });

  void it('only graphPool is MANDATORY — the other four are optional_requires', () => {
    // The split is load-bearing, and in the direction that is easy to get
    // wrong. `capabilityResolver.ts` and the install gate read `requires:` and
    // nothing else (#795), so a name promoted back into `requires:` makes this
    // plugin uninstallable on a core with no provider for it — for a capability
    // `activate()` is written to survive the absence of. That was gap G2 of the
    // 2026-08-20 acceptance run, and asserting the exact SETS (not just
    // membership) is what stops it coming back one line at a time.
    assert.deepEqual(list('requires'), ['graphPool@1']);
    assert.deepEqual(list('optional_requires'), [
      'turnContext@1',
      'githubAppJwt@1',
      'usageTelemetry@1',
      'conductorRoles@1',
    ]);
  });

  void it('the host-provided runtime deps stay PEERS, never bundled dependencies', () => {
    // `implementation.md` §5: core cannot drop express/pg/zod even after zero
    // dev-platform code paths, because they are this plugin's peers resolved
    // through the host node_modules symlink. A real `dependencies` entry here
    // would ship a second copy and break `instanceof` across the boundary.
    for (const dep of ['express', 'pg', 'zod', '@omadia/plugin-api']) {
      assert.ok(pkg.peerDependencies?.[dep], `${dep} must be a peerDependency`);
    }
  });
});

void describe('C6/C7 registration constraints the kernel enforces', () => {
  void it('every raw-body prefix is at least two segments deep', () => {
    // `pluginRouteRegistry` refuses a shallower claim, and the reason is not
    // stylistic: the raw parser runs in a GLOBAL mount ahead of core's
    // `express.json`, so a one-segment prefix like `/api` would buffer EVERY
    // request in the process pre-auth and hand core's routers a Buffer where
    // they asked for parsed JSON.
    const segments = (p: string) => p.split('/').filter((s) => s.length > 0).length;
    assert.ok(segments(WIRE_PATHS.webhooks) >= 2, `${WIRE_PATHS.webhooks} is too broad for body:'raw'`);
  });

  void it('the raw-body prefix is also a DECLARED public path', () => {
    // Both halves are required since C6: the registry enforces the depth floor,
    // and `pluginContext` additionally requires the prefix to sit inside a
    // `permissions.public_paths` entry. Declaring one without the other is an
    // activation throw, not a warning.
    assert.ok(PUBLIC_PATHS.includes(WIRE_PATHS.webhooks));
  });

  void it('no public path is a bare single segment', () => {
    for (const p of PUBLIC_PATHS) {
      assert.ok(
        p.split('/').filter((s) => s.length > 0).length >= 2,
        `'${p}' is a one-segment public claim — far broader than anything this plugin serves`,
      );
    }
  });
});
