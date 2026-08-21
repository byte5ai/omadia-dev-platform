# Changelog

All notable changes to `@omadia/dev-platform`. The version that matters is
`packages/plugin/manifest.yaml` — the hub reads the manifest, and `npm run
package` aborts if it disagrees with `packages/plugin/package.json`.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This
project versions the ARTIFACT, not the repository: a release is a ZIP an
operator can install, so anything that does not change the ZIP does not get a
version.

## 0.3.3 — 2026-08-21

Documentation only — no plugin code changed. Core PR
[byte5ai/omadia#824](https://github.com/byte5ai/omadia/pull/824) (epic #470 C16)
gave the two operator grants a UI and one API route, so every place this plugin
told an operator to write an `INSERT` by hand and restart the middleware was
saying something that is no longer true. The artifact is re-cut because the
in-ZIP `README.md` and the manifest's `setup.guide` — which an operator reads
*inside* the install wizard, on the step before the one that now asks — are part
of the ZIP.

### Changed

- **The grants are documented as a UI flow, not a database procedure.**
  [Operator Guide §4](./docs/OPERATOR-GUIDE.md#4-the-two-operator-grants) now
  leads with the install wizard's **Permissions** step and the plugin page's
  **Permissions** panel (`#grants`), and states that both take effect in
  process — **no middleware restart**. The unified route
  `GET|PUT /api/v1/admin/runtime/installed/:id/grants` with
  `{ sql?, public_paths? }` is kept as the automation path, alongside the
  older `…/public-paths` route, which #824 preserves unchanged as an alias.

  The same rewrite lands in `README.md`, the in-ZIP
  `packages/plugin/README.md`, and `setup.guide` **en + de** in the manifest.
  The German copy uses the shipped UI labels (*Freigeben & aktivieren*,
  *Überspringen*, *Übernehmen*), so the guide and the buttons next to it agree.

- **Skipping the SQL grant is documented as a supported outcome.** This plugin
  reaches for the database in `activate()`, so declining leaves it `errored` —
  and the wizard says so rather than guessing. That is now written down, with
  the recovery (grant from the panel; no reinstall, no restart), because an
  operator who meets `errored` without having been told to expect it reads it
  as a broken install.

- **Uninstall purges both grant tables** on a core with #824, so a reinstall
  starts un-granted and asks again instead of inheriting the previous package's
  database access and unauthenticated surface. §10 said the opposite, which was
  true when it was written.

- **`scripts/acceptance-local.mjs` drives the real operator path.** It probes
  for the unified route and, when the core under test ships it, grants **after**
  install over that route — the same call the wizard's *Grant & activate*
  makes — and asserts the plugin comes back `active` out of the PUT, which is
  the in-process re-activation actually working. Without the route it falls
  back to the pre-#824 pair (hand INSERT before activation, `…/public-paths`
  after) and the report names which ran. `§3.15` stops being permanently
  undecided: purged grant rows are a PASS, rows left behind are a FAIL on a
  core that promised to clear them and a BLOCKED on one that never did.

  A consequence worth stating: on a #824 core the install now legitimately
  reports `errored` between *configure* and *grant*, so the harness treats that
  as the documented state rather than a failure. Calling it a FAIL would turn
  the run red on the exact flow it exists to prove.

- **`compat.core` is unchanged** at `>=1.5 <2.0`. #824 changed no
  `@omadia/plugin-api` type, so there is no version to name and nothing to
  raise: it changed how an operator *answers* the permissions, not what this
  manifest declares. The manifest comment now records that, next to the C11 and
  C15 entries, so the next person does not have to re-derive it.

### Known

- **Cores older than #824 are unaffected and still documented.** The hand
  `INSERT` plus restart moved to
  [Operator Guide Appendix A](./docs/OPERATOR-GUIDE.md#appendix-a--older-cores)
  rather than being deleted — a plugin release outlives the core release it was
  written against, and the version number cannot distinguish them. §4 gives the
  one-line probe that can: `GET …/grants` answers 200 on a core that has it.

- **G4 is only partly closed.** #824 made the *re-activation* path truthful, so
  a grant applied from the panel records `errored` with its reason instead of
  swallowing the hook's failure. The **install** path still writes `active`
  before running the hook, so the original sharp edge survives on a fresh
  install (§12).

## 0.3.2 — 2026-08-21

The runner image is now published **automatically from this repository**. No
plugin code changed; the artifact is re-cut because the image an operator is
told to pin has a new name.

### Changed

- **The runner image is `ghcr.io/byte5ai/omadia-dev-platform-runner`** (was
  `ghcr.io/byte5ai/omadia-dev-runner`), and it builds on every runner-relevant
  push to `main` (`:main`, `:sha-<short>`) and on every `v*` tag (`:<version>`,
  `:latest`). Previously it built never.

  The old package was created by — and therefore owned by — `byte5ai/omadia`.
  GitHub scopes a container package to its creating repository, so this repo's
  `packages: write` token was necessary and **not sufficient**: the package also
  had to grant this repository write access, an org-level action nobody had
  taken. The workflow was consequently `workflow_dispatch`/tag-only so the gap
  would not become permanently red CI, and the image was never built once.

  Renaming to a package this repository creates on first push makes the
  permission true by construction. Nothing to grant, so nothing to wait for.

  **Operators must repoint `DEV_RUNNER_IMAGE` / `DEV_RUNNER_ALLOWED_IMAGES` at
  the new repository.** The old name will not receive further builds.

- **`verify` job.** The workflow now pulls the digest it just pushed and runs
  `cosign verify` with the identical regexp the daemon ships as its default, so
  a publisher/consumer drift fails a CI job instead of a daemon refusing to boot
  on someone else's deployment. Provenance is attested once, explicitly
  (`cosign attest` + `actions/attest-build-provenance`), rather than twice.

- **`linux/amd64` only.** arm64 would build, under QEMU, at roughly an order of
  magnitude more wall-clock — charged to every merge now that the build is
  automatic, for an architecture no job runs on. If an arm64 consumer appears it
  gets a native `ubuntu-24.04-arm` matrix leg, not an emulated platform.

### Known

- A brand-new GHCR package is **private** regardless of repository visibility.
  The publish job attempts to flip it and prints the exact command when the
  workflow token is not enough; making it public is a one-time org-owner action.

## 0.3.1 — 2026-08-21

Declares the ledger handoff in the manifest so the KERNEL performs it, closing
gap G7 of the 2026-08-21 acceptance run (core issue byte5ai/omadia#814, epic
#470 C15). Requires `@omadia/plugin-api` **1.6.0**; older cores ignore the new
key and keep the previous behaviour.

### Fixed

- **The C11 ledger handoff could never actually seed.** `activate()` calls
  `ctx.sql.seedLedger` before `runMigrations`, exactly as C11 documented — but
  core runs `permissions.sql.migrations` ITSELF, before `activate()`, so by the
  time the plugin got control all nine ledger rows were already written. The
  handoff could only ever report `alreadySeeded`, and `skippedNoWitness` — the
  one alarm the feature exists to raise — never fired. The acceptance run
  measured `0 seeded, 9 already seeded` on the exact upgrade the feature was
  built for, and nothing went red: that line is indistinguishable from a healthy
  re-run.

  This was not fixable from inside the plugin. Core calls the runner before
  handing over control, and the witnesses are knowledge only this plugin has.
  So the plan is now DECLARED and core executes it first.

### Changed

- **`permissions.sql.handoff: handoff-plan.json`.** The kernel reads the plan
  and runs the handoff ahead of its own migration runner. The file is the one
  already in the ZIP — the same one `plugin-ledger-handoff.mjs --plan` reads —
  so an operator can still dry-run the exact plan against production before
  installing anything.
- **The `activate()` `seedLedger` call stays, as the fallback.** On a kernel
  that honours `handoff` it reports `alreadySeeded`, which is correct once the
  work is done; on an older kernel it remains the only thing that performs the
  handoff at all. Removing it would silently drop adoption on every older core.

### Added

- `test/manifest.test.ts` pins the two things the declaration introduces: that
  `handoff` names a file the ZIP actually ships (declaring one the ZIP omits
  makes core refuse the activation outright, while every local test still
  passes), and that the plan satisfies core's STRICTER reader — no unknown keys
  (notably `dir`), no duplicate filenames, under the 128 KiB cap, every
  filename present in `migrations/`, and a `ledger` that agrees with the
  manifest's so core does not warn about a split-brain dry run.

### Documentation

The hub does not store `manifest.yaml`, it PROJECTS it: `parsePublish`
(`omadia-hub/lib/manifest.ts:113-231`) keeps a fixed set of fields and discards
the rest — including `optional_requires` and every comment in the file. So the
four capabilities this plugin is written to survive the absence of, and the
degradation it takes for each, were invisible to anyone deciding whether to
install it.

- **`setup.guide` (en + de)** now carries what the registry cannot: both
  operator grants and how to perform each, the Fly-versus-Docker runner choice,
  the ledger-handoff dry run, and a degradation table for every
  `optional_requires` capability. The German guide had fallen three sections
  behind English and is back at parity.
- **Every `setup.fields` entry carries `label` and `help` as `{ en, de }` maps**
  — the shape core normalises through `manifestLocalized.normalizeLocalized`
  (byte5ai/omadia#602). 21 fields, both locales.
- **`identity.description`** rewritten for the storefront card, and
  `categories` extended with `automation` and `github`; the hub builds its
  category selector from the union of published plugins' categories, so these
  are browse paths rather than tags.
- **A header comment recording the kept/stripped split** with `omadia-hub`
  file:line references, so the next operator-facing block does not get added
  somewhere that is discarded at publish time.
- **`docs/OPERATOR-GUIDE.md`** (new) — install, the two operator grants,
  credentials, runner backends, the migration handoff, uninstall/purge,
  troubleshooting and known issues, in one place.
- **`packages/plugin/README.md`**, which ships INSIDE the ZIP, still described
  0.1.0 ("Nothing yet", "no routes", "Permissions: none declared"). It is the
  first thing an operator reads after unzipping; rewritten for what this
  release actually does.
- **`README.md`** rewritten from "Status: P0 — scaffold" to the current
  release, with an architecture diagram; **`CONTRIBUTING.md`** gains a section
  on keeping the four operator-facing documents in step.

### Changed (documentation pass)

- **`compat.core` `>=1.0 <2.0` → `>=1.5 <2.0`.** `@omadia/plugin-api` 1.5.0 is
  the first core carrying C4, C6, C7, C9 and C11 — the surface this plugin
  cannot activate without. Core never semver-compares `compat_core`
  (`manifestLoader.ts:503`, `registryClient.ts:415` only carry the string
  through to the store view), which is precisely why it has to be honest rather
  than permissive. Note this release's own `permissions.sql.handoff` wants
  **1.6.0** and degrades cleanly below it, so it does not raise the floor.

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

The extraction itself. The Dev Platform moved out of omadia core into this
repository — plugin tree, operator SPA, runner sidecars and the migration
handoff (epic byte5ai/omadia#470, phases P2–P5 plus C11). Core stayed live and
unchanged throughout; this release is the copy that proves the destination
works, not the deletion of the origin. See `docs/ACCEPTANCE-RUN-2026-08-20.md`
for the run that closed it: **71 PASS / 0 FAIL / 2 BLOCKED** against
`main`+C6+C7.

### Added

- **The middleware tree (P3).** 60 of 62 dev-platform source files, 52 of 58
  suites and all nine migrations, ported against the C6 and C7 extension
  points: dev jobs, the analyze/plan/implement/review pipeline, gate and diff
  policy, the LLM budget proxy, HTTP routers, chat tools and background
  workers.
- **The operator SPA (P2).** The 28 files under core's
  `web-ui/app/admin/dev-platform/**` rebuilt as a standalone Vite/React 19
  bundle in `packages/ui`, shipped inside the ZIP as `ui/` and served by core at
  `/p/<pluginId>/ui/`. Four screens: hub, job detail, repo detail, add-repo
  wizard. `next-intl` became a 300-key-per-locale `src/lib/i18n.tsx`;
  `next/navigation` became a hash router, because a path route would 404 on
  reload against a static mount and a fragment never reaches the server.
  `scripts/check-ui-vocabulary.mjs` gates the build against the 690 classes core
  actually serves — all 334 Tailwind arbitrary values are gone, since the ZIP
  allowlist rejects that shape and a class core never saw renders unstyled
  rather than erroring.
- **Runner sidecars and the supply chain (P4).** `sidecars/dev-runner`,
  `sidecars/dev-runner-daemon` (control plane + egress proxy),
  `sidecars/dev-dind`, the protocol shim in `packages/runner-shim`, the compose
  overlay and the operator transcript CLI. Core's other four sidecars
  (pii-detector, privacy-detector-presidio, skillspector, updater) are core's
  and stayed there.
- **Migration handoff (C11).** `ctx.sql.seedLedger()` records core's already-run
  slots 0022–0030 as applied in this plugin's own ledger instead of re-applying
  all nine — but never on core's word alone. Each of the nine files carries a
  WITNESS in `src/ledgerHandoff.ts` proving the schema object it creates is
  actually present. `handoff-plan.json` ships in the ZIP so an operator can
  dry-run the handoff against production **before** installing.
- `scripts/acceptance-local.mjs` — an idempotent acceptance harness, 39 handler
  probes.

### Fixed

- **`activate()` double-registered every chat tool**, via `register` and
  `registerHandler` — two doors into one name-keyed kernel map that both throw
  on a duplicate. The root cause was a hand-narrowed context type missing the
  handler parameter, which made the correct call unwritable.
- **The ZIP shipped 145 sourcemaps** (1,736,840 bytes). Archive 965,433 →
  517,009 bytes.
- **The first ZIP was cut without `migrations/`** — it installed clean and then
  failed at activation with the plugin's nine tables absent. `migrations/` is
  now a required directory in `build-zip.mjs`, alongside `dist` and `ui`.
- **Parallel suites sharing one database claimed each other's jobs**, reporting
  defects that existed in neither. With a database configured the runner now
  switches to `--test-concurrency=1`; the pure run stays parallel.
- Two real defects surfaced by turning on the daemon's never-wired `typecheck`:
  `proxyClient.mjs` passed its abort callback as `withDeadline`'s third
  argument (`label`), so the abort never fired and a hung egress proxy leaked
  its fetch until process exit; and `buildEgressProxyClient` passed `tokens[0]`
  through unchecked, so an empty `DEV_RUNNER_DAEMON_TOKEN` authenticated the
  daemon to its own proxy as `Bearer undefined` — every job then saw 407 on
  every request, which inside a runner looks like a total network outage. Now a
  boot refusal.

### Reported upstream

Six core gaps found by the acceptance run and filed against omadia:
byte5ai/omadia#794, #795, #796, #797, #798, plus C12's static `publicPaths`
literals. None was plugin-side and none blocked staging.

## 0.1.0 — 2026-08-20

Scaffold. A repository that builds, tests and cuts a real, installable — and
deliberately empty — plugin artifact. **No dev-platform code had moved yet.**

That order was the point. A repository that cannot cut its own release artifact
ends up publishing from whatever tree someone last built in, a failure this
plugin set had already lived through when a package kept being released from a
frozen monorepo branch. The pipeline got proven while the payload was empty and
a mistake cost nothing.

### Added

- npm workspaces layout: `packages/plugin-api` (types-only),
  `packages/plugin`, `packages/ui`. Conventions follow
  `omadia-integration-odoo`: ESM, `tsc` build, the `@omadia/plugin-api` sibling
  linked by `file:` with a `"*"` peer, and a `build-zip.mjs` that emits a flat
  `out/<id>-<version>.zip`.
- `identity.kind: "extension"`, decided rather than defaulted.
  `toolPluginRuntime` activates only `tool`/`extension`/`integration`, and the
  agent-builder treats `kind === "integration"` as "an external system an agent
  may read from" — which the Dev Platform is not. There is no `platform` kind.
- Packaging guards, all mutation-checked rather than merely green: version
  drift, identity drift, a non-activatable kind, an uncommented permissions
  block, a missing locale and a missing build artifact each fail the build or
  the suite.
- CI that checks out this repo and `byte5ai/omadia` side by side, builds only
  `middleware/packages/plugin-api` from the sibling, then runs `npm ci`,
  typecheck, build, test and package, and uploads the ZIP.

### Fixed

- The first CI run went red on two traps that are invisible locally.
  `middleware/package.json` is an npm workspace root, so `npm install` run from
  inside `packages/plugin-api` is hijacked to the root and leaves the package's
  own `node_modules` empty — the local clean-room check had missed it by
  copying the package into a bare temp dir where no parent workspace exists.
  And `npx tsc` does not fail when TypeScript is absent: it downloads an
  unrelated abandoned `tsc` package and exits 1 with a misleading message. The
  compiler is now invoked by explicit path, and both notes are carried in
  README and CONTRIBUTING where a contributor hits the same traps.
