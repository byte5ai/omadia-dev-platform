/**
 * The unauthenticated-prefix allowlist, for tests that stand up their own
 * `requireAuth` double.
 *
 * Under core these suites called `publicPaths()` — the frozen literal in
 * `middleware/src/auth/publicPaths.ts` — so that a path dropped from
 * production's allowlist failed a test instead of only failing in production.
 *
 * That oracle still exists here, and it got BETTER. The plugin no longer relies
 * on two static exemptions someone else maintains: it DECLARES its
 * unauthenticated prefixes in `permissions.public_paths`, and `PUBLIC_PATHS` in
 * `src/plugin.ts` is the single source that both the manifest
 * (`manifest.test.ts`) and every route registration are checked against. So a
 * prefix dropped from the declaration now fails here, in `manifest.test.ts`, and
 * at `ctx.routes.register` — which throws for an `auth: 'custom'` route outside
 * a declared prefix (epic #470 C6).
 */

import { PUBLIC_PATHS } from '../../src/plugin.js';

/** Prefix matchers over the plugin's declared public paths. Anchored at the
 *  start and followed by `/`, `?` or end-of-string, so `/api/v1/dev-runner`
 *  never accidentally exempts `/api/v1/dev-runner-admin`. */
export function publicPaths(): RegExp[] {
  return PUBLIC_PATHS.map(
    (prefix) => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/?#]|$)`),
  );
}
