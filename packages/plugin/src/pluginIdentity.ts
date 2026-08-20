/**
 * The plugin's own id, in a module with no other contents.
 *
 * It lives here rather than in `plugin.ts` so that a module needing only the id
 * does not pull in the whole activation graph — `plugin.ts` imports the
 * assembly, the routers, the stores and the host seams, and importing all of
 * that to read one string makes cycles easy to create and hard to see.
 */

/** Must equal `manifest.yaml`'s `identity.id` and package.json's `name`.
 *  `test/manifest.test.ts` pins all three together. */
export const DEV_PLATFORM_PLUGIN_ID = '@omadia/dev-platform';
