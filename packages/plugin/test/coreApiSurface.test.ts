/**
 * How much of `@omadia/plugin-api` this package actually depends on — and why
 * keeping that number at two is what lets CI build against core `main` while
 * the epic's contract branches are still open.
 *
 * ## The problem this pins
 *
 * `activate()` is written against C6 (`ctx.routes.register` with `auth`/`body`)
 * and C7 (`ctx.sql.runMigrations`). Neither has landed on core `main`. If the
 * plugin imported `PluginContext` and used those members, it would typecheck on
 * the branches and FAIL on `main` — and CI checks out `main`.
 *
 * It does not, because `src/plugin.ts` declares `DevPlatformPluginContext`
 * STRUCTURALLY. That was chosen for testability (a recording double needs no
 * kernel), and the branch-independence falls out of it for free.
 *
 * "Falls out for free" is exactly the kind of property that quietly stops being
 * true. One `import type { PluginContext }` added by a future contributor and
 * CI breaks against `main` with a message about a missing member, which reads
 * like a core bug rather than an import that reached too far. So the property is
 * asserted rather than assumed.
 *
 * ## When to widen this
 *
 * Once C6 and C7 are on `main`, importing their types is fine and this list
 * should grow deliberately, in the PR that does it — not silently.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const srcDir = resolve(process.cwd(), 'src');

/**
 * Type names this package may import from `@omadia/plugin-api`.
 *
 * Both have been on core `main` since long before epic #470. Nothing here comes
 * from an unmerged branch, which is the whole point.
 */
const ALLOWED_IMPORTS = new Set(['NativeToolHandler', 'NativeToolSpec']);

function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

void describe('@omadia/plugin-api surface', () => {
  void it('imports only names that exist on core main', () => {
    const offenders: string[] = [];
    for (const file of sources(srcDir)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(
        /import\s+type\s*\{([^}]+)\}\s*from\s*['"]@omadia\/plugin-api['"]/g,
      )) {
        for (const raw of (m[1] ?? '').split(',')) {
          const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
          if (name && !ALLOWED_IMPORTS.has(name)) {
            offenders.push(`${relative(srcDir, file)} imports '${name}'`);
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a name outside the main-stable set would build on the #470 branches and break CI against core main. ' +
        'If C6/C7 have landed, widen ALLOWED_IMPORTS in the same PR that uses the new type.',
    );
  });

  void it('imports NOTHING from @omadia/plugin-api as a runtime value', () => {
    // Every import must be `import type`, so it vanishes from the emitted JS and
    // the shipped artifact carries no runtime dependency on core's package
    // (`implementation.md` D1). A value import would still resolve against the
    // host's node_modules, but it would turn a compile-time contract into a
    // load-time one.
    const offenders: string[] = [];
    for (const file of sources(srcDir)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^import\s+(?!type\b)[^;]*from\s*['"]@omadia\/plugin-api['"]/gm)) {
        offenders.push(`${relative(srcDir, file)}: ${(m[0] ?? '').slice(0, 60)}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  void it('the plugin context is declared structurally, not imported', () => {
    // The load-bearing half: `DevPlatformPluginContext` is this package's own
    // declaration of the slice it uses. That is what makes `ctx.sql` (C7) and
    // the route options (C6) describable before either has landed.
    const plugin = readFileSync(join(srcDir, 'plugin.ts'), 'utf8');
    assert.match(plugin, /export interface DevPlatformPluginContext/);
    assert.doesNotMatch(
      plugin,
      /import\s+type\s*\{[^}]*\bPluginContext\b[^}]*\}\s*from\s*['"]@omadia\/plugin-api['"]/,
    );
  });
});
