/**
 * `@omadia/dev-platform` — plugin entry point.
 *
 * ## What this is today
 *
 * A valid, activatable, no-op plugin. It exists so the repository, the build,
 * the ZIP and the install path are proven end to end BEFORE ~49k LOC move into
 * it (epic byte5ai/omadia#470, phase P0). A repo that cannot cut its own
 * artifact is a repo whose releases keep flowing through a tree nobody edits —
 * that failure mode is already on record for the byte5 plugin set, so the empty
 * version ships first and the payload arrives on a pipeline that works.
 *
 * ## What arrives later
 *
 * - **P2** — the SPA (`packages/ui`), 26 files ported to Vite/React.
 * - **P3** — the middleware tree: `src/devplatform/**`, all dev-platform
 *   routers including `devRunnerApi.ts` and `devWebhooks.ts`, the migrations
 *   codegen'd to JS with filenames preserved, and the config. `activate()` then
 *   assembles it and returns real disposers instead of the no-op below.
 * - **P4** — sidecars, the runner shim, and the supply chain.
 *
 * ## The activate/deactivate contract
 *
 * `activate(ctx)` returns a handle whose `close()` the kernel calls on
 * deactivation. Every registration made against `ctx` must be undone there —
 * `ServiceRegistry` owner tracking and `disposeBySource` (fixed under #470 B2)
 * only work if the plugin actually hands its disposers back.
 */

import type { PluginContext } from '@omadia/plugin-api';

/**
 * Re-exported so consumers depend on the DEV PLATFORM's contract rather than on
 * omadia core (#470, G8 — the `DevJob*` types left `@omadia/plugin-api`).
 *
 * This is `export type`, so nothing is emitted into `dist/plugin.js` and the
 * shipped artifact carries no runtime dependency on the API package. It is
 * still load-bearing: it fails `tsc` the moment the workspace link breaks.
 */
export type {
  DevJobDescriptor,
  DevJobEventRecord,
  DevJobKind,
  DevJobStatus,
} from '@omadia/dev-platform-plugin-api';

/**
 * The manifest's `identity.id`. Kept here so drift between the manifest, the
 * package name and the code is a test failure rather than an install-time
 * surprise — see `tests/plugin.test.ts`.
 */
export const DEV_PLATFORM_PLUGIN_ID = '@omadia/dev-platform';

/** What `activate()` hands back to the kernel. */
export interface DevPlatformPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<DevPlatformPluginHandle> {
  ctx.log(
    `[dev-platform] ${DEV_PLATFORM_PLUGIN_ID} activated (scaffold — no routes, tools or migrations yet; see epic #470 P2-P4)`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[dev-platform] deactivating');
    },
  };
}
