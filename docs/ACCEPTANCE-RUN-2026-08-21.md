# Acceptance run — 2026-08-21

Artifact under test: `@omadia/dev-platform` **0.3.0**
(`omadia-dev-platform-0.3.0.zip`, 525,131 bytes, sha256 `832f659cff39…`).
No hub publish, no staging Fly.

Successor to `ACCEPTANCE-RUN-2026-08-20.md`. That run needed a core built from
`main` + an unmerged C6 branch + four cherry-picked C7 commits + **five local
patches**. This one needs none of them: every gap it recorded except one has
landed on core `main`, and the last one is a merged-but-unreleased branch.

---

## 1. Headline

**The plugin was broken against core `main` and is now fixed.** Not "would have
degraded" — `registerNav` threw, the throw propagated out of `activateInner`,
and the plugin did not activate. See §4.

Two runs, same artifact, same script, two cores:

| Core | PASS | FAIL | BLOCKED | Rows |
|---|---|---|---|---|
| `origin/main` @ `9feb3ad3` | 38 | **33** | 2 | 73 |
| `origin/main` + C12 (`feat/470-c13-residue` @ `322afd19`) | **71** | **0** | 2 | 73 |

**All 33 failures on `main` have one cause**, and it is a core residue the epic
already scheduled: the two dev-platform `publicPaths` exemptions C12 deletes.
Removing them turns 33 FAIL into 33 PASS with no change to the artifact. The
verdict on the plugin is the second row.

The two BLOCKED rows are the same two as 2026-08-20, both honest, neither new:
core exposes no tool-registry endpoint to probe chat-tool registration over
HTTP, and `acceptance.md` §3.15 has not decided what happens to grant rows on
uninstall.

---

## 2. What was run against what

| | |
|---|---|
| Plugin | `omadia-dev-platform` @ `chore/verify-against-core-1.5.0`, artifact `omadia-dev-platform-0.3.0.zip` |
| Core (primary) | `byte5ai/omadia` `origin/main` @ `9feb3ad3` — **no patches, no cherry-picks** |
| Core (C12 comparison) | `feat/470-c13-residue` @ `322afd19` (= main + C12 + C13) |
| `@omadia/plugin-api` | **1.5.0** |
| Node | v22.22.3 (nvm) |
| Postgres | `pgvector/pgvector:pg16`, ports 55441 (main) / 55442 (C12) |
| Core env | `PORT=4111` / `4112`, local password auth. **No `DEV_PLATFORM_ENABLED`** — the key no longer exists in core (C10) and core boots fine without it. |

Suite: **1,316 tests, 0 fail, 0 skipped** across four workspaces
(`plugin` 786 / `runner-shim` 76 / `dev-runner-daemon` + `ui` 454), with the
Postgres suites actually running. The only remaining skips are two that need a
built `dev-runner` image.

---

## 3. Plugin defects found and fixed

### P3 — the nav entry could not be registered at all (**the plugin did not activate**)

```
UiRouteCatalog.registerNav(@omadia/dev-platform/devPlatform): href segment
  '%40omadia%2Fdev-platform' has characters outside [A-Za-z0-9-._~]
```

This is gap **G5** of the 2026-08-20 run, and the fix did not go the way that
run assumed. G5's local patch widened `HREF_SEGMENT` to admit percent-octets.
Core went the other way: **#798 deliberately kept the rule strict**, because the
shell decides "core destinations win" by comparing hrefs for string equality and
percent-encoding breaks that comparison — widening it would weaken every literal
href to fix the one path core can spell for itself.

So the patch this repo was implicitly waiting for was never going to land, and
the hand-built href stayed unregisterable. C9 closed it from the other side:
the plugin declares `pluginUi: true` and the **kernel** renders
`pluginUiHref(id)` from the id it already holds. Byte-identical URL, and no
plugin ever spells a percent-encoded href again.

Fixed in `src/plugin.ts` §7. `test/activate.test.ts` now asserts the shape —
`pluginUi === true`, no `href` — because a recording double accepts anything,
which is exactly why this survived a green suite in the first place.

### P4 — four survivable capabilities were declared as hard requirements

Gap **G2** of the previous run, fixed on the plugin side rather than in core.
`turnContext@1`, `githubAppJwt@1`, `usageTelemetry@1` and `conductorRoles@1`
moved from `requires:` to `optional_requires:` (C9 / core #795). Core's
capability resolver and install gate read `requires:` **only**, so listing a
survivable capability there made this plugin uninstallable on stock core for
four capabilities `activate()` is explicitly written to live without — each with
a logged, documented degradation. `graphPool@1` stays the one hard requirement.

Resolution moved to `ctx.services.getOptional` (plugin-api 1.4.0), guarded by an
optional-method check so a core that predates it still activates through the
`get()` fallback. Both paths are driven by tests.

### Verified unchanged

- **The nine `seedLedger` witnesses already satisfy the C11 fence.** Each is a
  single `SELECT` returning one boolean row, built from `to_regclass`,
  `information_schema.columns` or a `pg_constraint` join — no casts that throw
  on a missing relation, no multi-statement strings, no writes. Nothing to fix:
  they ran clean under core's READ ONLY savepoint over the extended protocol.
- **`permissions.sql.ledger`** is `plg_omadia_dev_platform_migrations`, inside
  the `plg_<sanitized-id>_` namespace the kernel enforces.

---

## 4. Core gaps — 2026-08-20 list, re-measured

| Gap | 2026-08-20 | Now |
|---|---|---|
| G1 — C7's SQL gate stops core booting | P0, local patch | **CLOSED** — core boots clean |
| G2 — `requires:` has no optionality | blocks install, local patch | **CLOSED** by C9 `optional_requires` (#795); plugin side fixed here |
| G3 — core ledger is a side effect of an LLM key | P0, migrations applied by hand | **CLOSED** — core ran its own 47 migrations at boot (C9) |
| G4 — failed activation reports `status: "active"` | silent | **OPEN**, see below |
| G5 — no scoped plugin can express a nav href | blocks nav, local patch | **CLOSED** by C9 `pluginUi: true` (#796) |
| G6 — C12 public-path residue | last hard blocker | **merged on the C12 branch, not yet on `main`** |

### G4 is still open, and this run is the proof

`§3.9 activation` reported **PASS — `state=active, no error`** on the `main` run,
in which the plugin had already been torn down:

```
[@omadia/dev-platform] [dev-platform] activated — worker running
[@omadia/dev-platform] [dev-platform] deactivating
[install] onInstalled hook failed for @omadia/dev-platform: … cannot activate —
  public-path declaration '/api/v1/dev-runner' … is already a static core public path
```

`activate()` completed — migrations, tools, routers, worker, cron, nav — and
core then rejected the public-path declaration and unwound it. The plugin record
kept saying `active` while nothing was mounted. Every one of the 33 downstream
`404 — route not mounted` rows is that state seen from outside. A row that reads
PASS while the subsystem is dead is the worst-in-class failure the acceptance
document exists to prevent, and it survived into this run unchanged.

### NEW — G7: core's pre-activate migration run pre-empts the C11 handoff (**C11 is a no-op for the plugin class it was built for**)

Measured on both cores, against a database carrying core's donor rows **and** all
nine `dev_*` tables — precisely the upgrade C11 exists for. Expected: 9 seeded,
runner applies 0. Observed, in this order:

```
[tool-runtime] @omadia/dev-platform: applied 9 migration(s) to ledger
  'plg_omadia_dev_platform_migrations' in 33ms (0022…0030)          ← core, BEFORE activate()
[@omadia/dev-platform] [sql] ledger handoff — 0 seeded, 9 already seeded,
  0 left for the migration runner                                    ← the plugin's seedLedger
```

Inverted. `toolPluginRuntime.ts:374-394` calls `ctx.sql.runMigrations()` itself,
before `activate()`, whenever the manifest declares `permissions.sql.migrations`
— deliberately, so "the tables exist" is an invariant `activate()` can rely on
(C7/G4). But `seedLedger` is documented to be called **inside `activate()`,
before `runMigrations()`** (`plugin-api/src/pluginContext.ts:2071-2087`), and by
then core's runner has already written all nine ledger rows. The handoff can
only ever report `alreadySeeded`.

Consequences, in order of severity:

1. The **`skippedNoWitness` alarm never fires.** That is the one output C11 was
   built to produce: donor rows present, schema objects absent — a restore, a
   rolled-back deploy, a dropped table. The operator is not told.
2. `dryRun` is unreachable in the real flow, so the plan an operator was meant
   to read before a production handoff cannot be produced.
3. The nine files are re-applied on every upgrade — the cost C11 removed.

Not a data-loss bug: the files are idempotent and re-applying them against a
partially-present schema is itself the repair, so the outcome stays safe. What
is lost is the *detection*. A plugin cannot fix this from its side — core calls
the runner before `activate()` and the witnesses are knowledge only the plugin
has. Core needs to either run the handoff ahead of its own pre-activate runner
(which means the manifest naming a handoff module), or skip the pre-activate run
for a plugin that declares one.

- Core: `middleware/src/plugins/toolPluginRuntime.ts:374-394`
- Contract: `middleware/packages/plugin-api/src/pluginContext.ts:2071-2087`
- Plugin call site (correct as written): `packages/plugin/src/plugin.ts` §3

---

## 5. Row-level results

### Install / uninstall (acceptance.md §3) — C12 core

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Boots with no `DEV_*` config | PASS | `listening on [127.0.0.1]:4112`; `DEV_PLATFORM_ENABLED` no longer exists |
| 2 | dev-platform endpoints 404 before install | PASS | jobs/repos/gates/dev-runner/webhooks all 404 |
| 3 | No nav entry, no admin card | PASS | `/api/v1/ui/navigation` has no `devPlatform` |
| 4 | No `dev_*` table required to boot | PASS | core boots with its own 47 migrations |
| 6 | Setup fields render from manifest | PASS | 23 fields, `state=awaiting_config` |
| 7 | Own migrations, 9 tables | PASS | ledger 9 rows; 9 `dev_*` tables |
| 8 | Public-path grant consented (C4/H1) | PASS | granted 3 — **was FAIL on `main`** |
| 8b | SQL grant (C7) | PASS\* | `INSERT INTO plugin_sql_grants` — still no HTTP endpoint |
| 9 | Nav entry appears | PASS | `navId devPlatform` — **no local patch this time** |
| 10 | Every §2 row passes | PASS | 39 probes, 0 FAIL |
| 11 | Routers stop on uninstall | PASS | `GET /jobs` → 404 |
| 12 | Nav entry disappears | PASS | no `devPlatform` |
| 13 | Background loops stop | PASS | worker + gate-deadline disposed with the handle |
| 14 | Public-path grant revoked | PASS | 200 → 404 |
| 15 | Data lifecycle | PASS / **BLOCKED** | tables + rows correctly remain (D3); grant rows orphaned — §3.15 still undecided |
| 16 | Reinstall lossless | PASS | ledger 9 (0 re-applied), routes 200 |

### C12 static exemption

**PASS on the C12 branch, FAIL on `main`.** #807 was not merged when this ran
(`origin/main` @ `9feb3ad3`; `publicPaths.ts:41,:44` still carry both literals).
The row was therefore re-run against `feat/470-c13-residue` @ `322afd19`, which
contains `d55a468f feat(#470): delete the two dev-platform publicPaths
exemptions (C12)` — and it passes, along with the 32 rows that cascade from it.
**Re-run `scripts/acceptance-local.mjs` against `main` once #807 lands; no
plugin change is required and none is expected.**

### SPA and UI (§2.7) — C12 core

| Check | Result |
|---|---|
| SPA at `/p/%40omadia%2Fdev-platform/ui/` | PASS — 200 |
| unencoded id does NOT serve | PASS — 404, encoded is canonical |
| hashed UI asset | PASS — 200 |
| `plugin-ui.css` served by core | PASS — 200 |
| bundle links no stylesheet of its own | PASS |
| 4 UI screens reachable | PASS — all backing endpoints answer |

### ZIP

| Check | Result |
|---|---|
| `manifest.identity.version` == `package.json` | PASS — both `0.3.0` |
| `dist/plugin.js` | PASS |
| `migrations/*.js` == 9 + `checksums.json` | PASS |
| `ui/index.html` + hashed asset | PASS |
| no `.css`, no `node_modules`, no sourcemaps | PASS — 147 maps pruned (1,741,237 bytes) |
| upload accepted | PASS — 525,131 bytes |

---

## 6. Reproducing

```bash
# 1. Postgres
docker run -d --name acc-0821-pg \
  -e POSTGRES_DB=omadia -e POSTGRES_USER=omadia -e POSTGRES_PASSWORD=omadia-ci \
  -p 55441:5432 pgvector/pgvector:pg16

# 2. Core — plain origin/main, no patches and no cherry-picks
git -C ../odoo-bot worktree add /tmp/odoo-bot-final origin/main
(cd /tmp/odoo-bot-final/middleware && npm install && npm run build)

# 3. Boot. Core applies its OWN migrations now (G3 closed) — no psql loop.
#    There is no DEV_PLATFORM_ENABLED any more.
cd /tmp/odoo-bot-final/middleware
DATABASE_URL='postgres://omadia:omadia-ci@127.0.0.1:55441/omadia' PORT=4111 \
  HOST=127.0.0.1 PUBLIC_BASE_URL=http://127.0.0.1:4111 AUTH_PROVIDERS=local \
  ADMIN_BOOTSTRAP_EMAIL=admin@byte5.de ADMIN_BOOTSTRAP_PASSWORD=omadia-local-dev-1 \
  PLATFORM_DATA_DIR=/tmp/acc-0821-data node dist/index.js

# 4. Plugin, built against that core
cd ~/sources/omadia-dev-platform
npm ci && OMADIA_CORE_DIR=/tmp/odoo-bot-final npm run link:core
npm run typecheck && npm run build && npm run package -w packages/plugin

# 5. The run — idempotent, re-runnable, exit code == FAIL count
BASE_URL=http://127.0.0.1:4111 \
  DATABASE_URL='postgres://omadia:omadia-ci@127.0.0.1:55441/omadia' \
  node scripts/acceptance-local.mjs
```

Full suite including the Postgres suites (without a DB they skip loudly, #572):

```bash
docker run -d --name omadia-devplatform-pgtest -p 55438:5432 \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
  pgvector/pgvector:pg16
GRAPH_PG_TEST_URL=postgres://test:test@127.0.0.1:55438/test \
OMADIA_CORE_DIR=/tmp/odoo-bot-final npm test
```

---

## 7. Notes for whoever picks this up

- **The plugin needs nothing further.** Both fixes are in `0.3.0` and both are
  pinned by tests. The remaining work is core's.
- **Re-run the C12 row against `main` when #807 lands.** Expect 71/0/2 with no
  plugin change. If any row still fails, it is a new regression, not this one.
- **G7 is the finding worth acting on.** C11 shipped three weeks of design into
  a code path that cannot execute for the plugin class it was written for, and
  nothing failed — the log line reads `0 seeded, 9 already seeded`, which is
  indistinguishable from a healthy re-run. It needs a core issue.
- **G4 keeps making every other verdict less trustworthy.** It is why `§3.9
  activation` reported PASS above a plugin that had already been torn down. Any
  future run that trusts `state` over the boot log will draw the same wrong
  conclusion.
