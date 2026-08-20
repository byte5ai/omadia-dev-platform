/**
 * Smoke test — the BUILT artifact, not the source.
 *
 * `dist/plugin.js` is what the ZIP ships and what the host loads through
 * `lifecycle.entry`. Testing the TypeScript source instead would pass happily
 * while the emitted entry point was missing, misnamed, or exporting nothing —
 * the exact failure the hub cannot see until an install breaks.
 *
 * The import specifier is built at runtime so esbuild cannot statically resolve
 * and inline it; `import()` therefore loads the real file from disk.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const pkgRoot = process.cwd();
const distEntry = resolve(pkgRoot, 'dist/plugin.js');

const manifestText = readFileSync(resolve(pkgRoot, 'manifest.yaml'), 'utf8');
const pkg = JSON.parse(
  readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'),
) as { name: string; version: string };

function manifestField(indent: number, key: string): string | undefined {
  const re = new RegExp(`^\\s{${String(indent)}}${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm');
  return re.exec(manifestText)?.[1];
}

/** Every `kind` the plugin runtimes accept. `toolPluginRuntime.ts:163-168`
 *  activates only tool/extension/integration; `registryClient.ts:34-40` also
 *  admits agent and channel, which never reach that runtime. */
const ACTIVATABLE_KINDS = new Set(['tool', 'extension', 'integration']);

void test('lifecycle.entry points at a file that was actually built', () => {
  assert.equal(manifestField(2, 'entry'), 'dist/plugin.js');
  assert.ok(existsSync(distEntry), `built entry point missing: ${distEntry}`);
});

void test('the built entry exports the activate contract', async () => {
  const mod = (await import(pathToFileURL(distEntry).href)) as Record<
    string,
    unknown
  >;

  assert.equal(typeof mod['activate'], 'function', 'activate must be exported');
  assert.equal(
    (mod['activate'] as (...a: never[]) => unknown).length,
    1,
    'activate takes exactly one argument (the PluginContext)',
  );
  assert.equal(mod['DEV_PLATFORM_PLUGIN_ID'], '@omadia/dev-platform');
});

void test('activate() returns a handle whose close() resolves', async () => {
  const mod = (await import(pathToFileURL(distEntry).href)) as {
    activate: (ctx: unknown) => Promise<{ close: () => Promise<void> }>;
  };

  const logged: string[] = [];
  const handle = await mod.activate({
    log: (m: string) => logged.push(m),
  });

  assert.equal(typeof handle.close, 'function');
  assert.equal(logged.length, 1, 'activate() logs exactly once');
  assert.match(logged[0] ?? '', /dev-platform.*activated/);

  await handle.close();
  assert.equal(logged.length, 2, 'close() logs the deactivation');
});

/**
 * Wiring guard. A manifest field nobody reads passes every other test in the
 * suite — that is a recorded failure in this plugin set, so the manifest is
 * asserted against the package it describes rather than merely parsed.
 */
void test('manifest identity agrees with package.json and the kind is activatable', () => {
  assert.equal(manifestField(2, 'id'), pkg.name, 'identity.id vs package name');
  assert.equal(
    manifestField(2, 'version'),
    pkg.version,
    'identity.version vs package version — the hub reads the manifest',
  );

  const kind = manifestField(2, 'kind');
  assert.ok(
    kind !== undefined && ACTIVATABLE_KINDS.has(kind),
    `identity.kind ${String(kind)} would never activate; expected one of ${[...ACTIVATABLE_KINDS].join(', ')}`,
  );
});

/**
 * `permissions:` must stay commented out until core enforces it. An unknown
 * manifest key is silently IGNORED rather than rejected, so declaring
 * `sql` / `public_paths` early yields a plugin that activates with no grant and
 * no error — a silent security downgrade rather than a loud failure.
 */
void test('permissions block is documented, not declared', () => {
  assert.doesNotMatch(
    manifestText,
    /^permissions:/m,
    'uncomment permissions only in the PR that lands its enforcement',
  );
});

void test('setup.guide carries both locales', () => {
  assert.match(manifestText, /^\s{4}en:\s*\|$/m);
  assert.match(manifestText, /^\s{4}de:\s*\|$/m);
});
