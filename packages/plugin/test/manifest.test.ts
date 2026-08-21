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
  files?: string[];
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

  void it('permissions.sql.handoff names a plan the ZIP ships', () => {
    // Epic #470 C15 (core byte5ai/omadia#814). Declaring this is what makes the
    // KERNEL run the handoff before its own migration runner; without it the
    // `activate()` call is structurally too late and `skippedNoWitness` never
    // fires. A declaration pointing at a file the ZIP does not ship is worse
    // than no declaration: the kernel refuses the activation outright.
    const handoff = scalar(4, 'handoff');
    assert.equal(handoff, 'handoff-plan.json');
    assert.ok(
      existsSync(resolve(pkgRoot, handoff ?? '')),
      'the kernel reads this file at activation and refuses to activate without it',
    );
    assert.ok(
      (pkg.files ?? []).includes(handoff ?? ''),
      'declared but not in package.json `files` — present in the repo, absent from the ZIP, ' +
        'so every real installation would refuse to activate while every local test passed',
    );
  });

  void it('the declared plan is one the kernel will accept', () => {
    // The kernel's reader (`platform/pluginHandoffPlan.ts`) is STRICTER than
    // the operator CLI's: it rejects unknown keys, refuses duplicate
    // filenames, and caps the file size. A plan this repo is happy with but
    // the kernel refuses fails at INSTALL time, on the operator's machine,
    // where nobody can fix it. So the kernel's rules are checked here.
    const path = resolve(pkgRoot, 'handoff-plan.json');
    const raw = readFileSync(path, 'utf8');
    assert.ok(
      Buffer.byteLength(raw, 'utf8') <= 128 * 1024,
      'over the kernel\'s 128 KiB plan cap',
    );

    const plan = JSON.parse(raw) as Record<string, unknown> & {
      entries: { filename: string; witnessSql: string }[];
    };

    // `pluginId` / `ledger` / `migrationsDir` are the operator CLI's — it runs
    // with no manifest and has to be told them. The kernel accepts and ignores
    // them so ONE file serves both readers. Everything else is a typo or a key
    // from a core this package was not built against, and the kernel refuses
    // rather than ignoring it. `dir` is the one that earns the strictness:
    // `SeedLedgerOptions` accepts it, so it looks like it should work here.
    const allowed = ['pluginId', 'ledger', 'migrationsDir', 'entries', 'dryRun'];
    for (const key of Object.keys(plan)) {
      assert.ok(allowed.includes(key), `key '${key}' would be refused by the kernel`);
    }

    assert.ok(Array.isArray(plan.entries) && plan.entries.length > 0);
    const seen = new Set<string>();
    for (const entry of plan.entries) {
      assert.ok(
        typeof entry.filename === 'string' && entry.filename.length > 0,
        'every entry needs a filename',
      );
      assert.ok(
        typeof entry.witnessSql === 'string' && entry.witnessSql.trim().length > 0,
        `entry '${entry.filename}' has no witness — a file with no proof is never seeded`,
      );
      assert.ok(!seen.has(entry.filename), `'${entry.filename}' is listed twice`);
      seen.add(entry.filename);
      assert.ok(
        existsSync(resolve(pkgRoot, 'migrations', entry.filename)),
        `'${entry.filename}' is not in the migrations directory the ZIP ships`,
      );
    }

    // A plan whose ledger disagrees with the manifest makes the kernel warn:
    // the operator dry-ran against one table and the kernel writes another.
    assert.equal(
      plan.ledger,
      scalar(4, 'ledger'),
      'the plan and the manifest must name the same ledger, or the dry run an operator trusted described a different table',
    );
    assert.equal(plan.migrationsDir, scalar(4, 'migrations'));
    assert.equal(plan.pluginId, pkg.name);

    // The kernel takes the directory from the manifest and nowhere else, so a
    // plan asking for a dry run would leave the real handoff undone forever.
    assert.notEqual(plan.dryRun, true, 'a shipped plan must not ship a dry run');
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
