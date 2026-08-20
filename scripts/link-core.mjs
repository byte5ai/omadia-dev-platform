#!/usr/bin/env node
/**
 * link-core.mjs — point `@omadia/plugin-api` at a core checkout, WITHOUT
 * editing the committed default.
 *
 *     npm run link:core                                  # ../odoo-bot
 *     OMADIA_CORE_DIR=/tmp/odoo-bot-470-api npm run link:core
 *
 * ## The problem this solves
 *
 * `@omadia/plugin-api` is a PRIVATE workspace package inside `byte5ai/omadia`.
 * It lives on no registry, the Omadia host supplies it at runtime, and this repo
 * declares it as a peer resolved from a sibling checkout — the pattern
 * `omadia-byte5-plugins` has run in production for six plugins
 * (`implementation.md` D1). The committed default in `package.json` therefore
 * stays `file:../odoo-bot/middleware/packages/plugin-api`, which is what CI and
 * every normal checkout use.
 *
 * But contract work happens on UNMERGED core branches. Building this package
 * against C6+C7 means pointing at a throwaway worktree, and doing that by
 * editing `package.json` would eventually commit one machine's directory layout
 * into a public repository. So the override is a symlink, made here, never
 * tracked. `node_modules/` is gitignored; nothing this script writes can be
 * committed.
 *
 * Idempotent, and it verifies the target is BUILT — `dist/index.d.ts` is what
 * `tsc` actually resolves, and a source-only checkout produces a wall of
 * "cannot find module" errors that say nothing about the real cause.
 */

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = resolve(repoRoot, process.env.OMADIA_CORE_DIR ?? '../odoo-bot');
const target = join(coreDir, 'middleware', 'packages', 'plugin-api');

if (!existsSync(target)) {
  console.error(
    `core plugin-api not found at ${target}\n` +
      'Clone byte5ai/omadia next to this repo, or set OMADIA_CORE_DIR. See CONTRIBUTING.md.',
  );
  process.exit(1);
}
if (!existsSync(join(target, 'dist', 'index.d.ts'))) {
  console.error(
    `${target} is not built — run \`npm install && npm run build\` in ${join(coreDir, 'middleware')} first.\n` +
      'tsc resolves `@omadia/plugin-api` through its emitted .d.ts; without it every import fails for the wrong reason.',
  );
  process.exit(1);
}

const scope = join(repoRoot, 'node_modules', '@omadia');
mkdirSync(scope, { recursive: true });
const link = join(scope, 'plugin-api');
if (existsSync(link) || isSymlink(link)) rmSync(link, { recursive: true, force: true });
symlinkSync(target, link, 'dir');
console.log(`✓ @omadia/plugin-api → ${target}`);

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
