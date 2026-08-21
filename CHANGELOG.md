# Changelog

All notable changes to `@omadia/dev-platform`. The version that matters is
`packages/plugin/manifest.yaml` — the hub reads the manifest, and `npm run
package` aborts if it disagrees with `packages/plugin/package.json`.

## 0.3.0 — 2026-08-21

Verification pass against omadia core `origin/main` (`9feb3ad3`), the first core
that carries the whole C9–C11 contract surface: `optional_requires`,
`ctx.services.getOptional`, `pluginUi` nav entries, core migrations at boot, and
`ctx.sql.seedLedger` with the read-only witness fence. `@omadia/plugin-api` is
**1.5.0**.

### Fixed

- **The plugin could not activate against core `main` at all.** The nav entry
  hand-built a percent-encoded `href` (`/plugin-ui/%40omadia%2Fdev-platform`),
  which is the one spelling core's `HREF_SEGMENT` refuses — and #798
  deliberately kept that rule strict rather than widening it. `registerNav`
  threw, the throw propagated out of `activateInner`, and activation failed.
  The entry now declares `pluginUi: true` and the kernel renders the identical
  URL from the id it already holds (C9, closing gap G5 of the 2026-08-20
  acceptance run). `test/activate.test.ts` pins the shape: `pluginUi === true`
  and no `href`.

### Changed

- **`turnContext@1`, `githubAppJwt@1`, `usageTelemetry@1` and
  `conductorRoles@1` moved from `requires:` to `optional_requires:`.** Core's
  capability resolver and install gate read `requires:` only, so listing a
  survivable capability there made this plugin uninstallable on stock core for
  four capabilities `activate()` is explicitly written to live without — gap G2
  of the acceptance run. Each still logs the degradation it takes. `graphPool@1`
  stays the single hard requirement.
- **Optional capabilities resolve through `ctx.services.getOptional`** (added in
  plugin-api 1.4.0) instead of `ctx.services.get` inside a `try`. The accessor
  is called through an optional-method guard, so a core that predates it still
  activates through the `get()` fallback; a test drives both paths.

### Testing

- The `activate()` double is now faithful on two points it was lenient about:
  `services.get`/`getOptional` throw for a capability the manifest declares in
  neither list, and the declared set is **parsed from `manifest.yaml`** rather
  than restated in the test, so a forgotten manifest entry fails here instead of
  against a real core.
- `test/manifest.test.ts` asserts the exact `requires:` / `optional_requires:`
  sets, not just membership — the regression this guards against arrives one
  promoted line at a time.

### Unchanged, and verified so

- The nine `seedLedger` witnesses in `src/ledgerHandoff.ts` already satisfy the
  C11 fence: each is a single `SELECT` returning one boolean row, built from
  `to_regclass`, `information_schema.columns` or a `pg_constraint` join — no
  casts that throw on a missing relation, no multi-statement strings, no writes.
- `permissions.sql.ledger` is `plg_omadia_dev_platform_migrations`, inside the
  `plg_<sanitized-id>_` namespace the kernel enforces.

## 0.2.0 — 2026-08-20

Extraction of the Dev Platform out of omadia core into this repository (epic
byte5ai/omadia#470, P1–P5 plus C11). See
`docs/ACCEPTANCE-RUN-2026-08-20.md` for the acceptance run that closed it.
