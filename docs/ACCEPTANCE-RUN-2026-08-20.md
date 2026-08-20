# Acceptance run — 2026-08-20

Epic [byte5ai/omadia#470](https://github.com/byte5ai/omadia/issues/470) **P5**, local proof gate.
No hub publish, no staging Fly. Artifact under test: `@omadia/dev-platform` **0.2.0**.

**Result: 71 PASS / 0 FAIL / 2 BLOCKED (73 rows).**

Reproduce with `node scripts/acceptance-local.mjs` (§7). Everything below is
evidence from an actual run, not a reading of the source.

---

## 1. Headline

The plugin installs, activates, serves all 38 handlers, registers its three chat
tools and three background loops, survives uninstall with its data intact, and
reinstalls losslessly — **but only against a core carrying five local patches**.

Four of those patches are core defects this run found. One is the C12 work the
epic already knows about. **None of them is optional**: without all five, a
stock `origin/main` + C6 + C7 core either does not boot, or refuses to install
the plugin, or installs it and serves nothing.

Two plugin defects were found and fixed here, both with mutation-checked tests.

The honest summary: **the plugin side is ready; the core side is not.** §6 lists
what still blocks a staging install.

---

## 2. What was run against what

| | |
|---|---|
| Plugin | `omadia-dev-platform` @ `feat/p5-acceptance-run`, artifact `omadia-dev-platform-0.2.0.zip` |
| Core | `byte5ai/omadia` `origin/main` @ `42e91c8d` + `feat/470-c6-session-auth-raw-body` + C7 (4 commits cherry-picked) |
| Node | v22.22.3 (nvm) |
| Postgres | `pgvector/pgvector:pg16`, container `p5-acceptance-pg`, port 55439 |
| Core env | `DEV_PLATFORM_ENABLED=false`, `PORT=4100`, local password auth |

C7 could not be merged: its branch still carries the **pre-squash C2b commits**
that `main` already has as squash `dd417557`, so a merge conflicts in 10 files.
The four C7-unique commits cherry-pick cleanly instead (one union conflict in
`manifestLoader.ts`, where C4's `public_paths` and C7's `sql` add to the same
lists).

---

## 3. Core gaps found

Each was hit by the run, not inferred. Each is followed by the local patch that
unblocked it — all in a throwaway worktree, none pushed.

### G1 — C7's SQL gate stops core booting (**P0**)

`@omadia/memory-postgres` declares `requires: ["graphPool@^1"]` correctly, so
C2b's services gate passes it. It declares no `permissions.sql`, so **C7's new
gate refuses it** — and its absence is a fatal startup error:

```
[tool-runtime] activate FAILED for @omadia/memory-postgres: plugin
  '@omadia/memory-postgres' reached for the database capability 'graphPool' but
  its manifest does not declare `permissions.sql`
[middleware] fatal startup error: Error: [middleware] MemoryStore service missing
  after tool-plugin activation — @omadia/memory must be built-in and active
```

The root cause is that **C7 reuses an allowlist built for a different question.**
`LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20`
(`middleware/src/platform/pluginServiceGrants.ts:88`) keys on *"did not declare
the SERVICE"*; C7 gates on *"did not declare `permissions.sql`"*
(`middleware/src/platform/pluginSqlGrants.ts:253-264`). For a compliant plugin
those sets are **disjoint** — doing the C2b work correctly is precisely what
keeps you out of the ramp that C7 needs you in.

Scanned all 21 built-in manifests: exactly one plugin resolves `graphPool` with
neither `permissions.sql` nor allowlist cover — `@omadia/memory-postgres` — and
it is the one whose absence is fatal.

*Local patch:* add `'@omadia/memory-postgres': ['graphPool']` to the allowlist.

### G2 — `requires:` has no optionality, and two gates enforce it (**blocks install**)

The manifest documents four capabilities as optional, with the degradation
spelled out per capability. Core refuses all four:

```
HTTP 409 {"code":"install.missing_capability",
 "message":"plugin requires capabilities not yet provided:
   conductorRoles@1, githubAppJwt@1, turnContext@1, usageTelemetry@1",
 "details":{"available_providers":[{"capability":"turnContext@1","providers":[]}, …]}}
```

This is a **contract contradiction**, not a missing feature:

- C2b makes `ctx.services.get(name)` throw for a name in neither `requires:`
  nor `provides:` — so a plugin **must list** anything it might resolve.
- The installer treats every `requires:` entry as a hard prerequisite
  (`middleware/src/plugins/installService.ts:149-156`).
- The boot loop enforces it a **second** time and drops the plugin
  (`middleware/src/plugins/toolPluginRuntime.ts:225-243`).

A plugin with degradable dependencies is therefore unrepresentable: declaring
them blocks install, omitting them makes resolution throw. There is no
`optional` field anywhere in `requires:` parsing (`manifestLoader.ts:360`,
`extractCapabilityList` at `:489-499`).

Sharpest detail: `turnContext` **exists at runtime** — `@omadia/knowledge-graph-neon`
resolves it during this very boot. It is invisible to the installer only because
the resolver reads manifest `provides:` lists while `services.get` reads the live
service registry. `available_providers: []` is not "nobody provides this"; it is
"nobody *declares* providing this".

*Local patch:* downgrade both gates to warnings.

### G3 — the core migration ledger is a side effect of an LLM key (**P0**)

`middleware/migrations/` — 47 files, including **`0045_plugin_sql_grants.sql`
(C7)** and **`0046_plugin_public_path_grants.sql` (C4)** — is applied only by
`runMultiOrchestratorMigrations`, called from
`middleware/packages/harness-orchestrator/src/plugin.ts:1098`.

That line is unreachable without an LLM provider key. `activate()` returns early
at `plugin.ts:481-490`:

```
[harness-orchestrator] no API key for provider 'anthropic' — chatAgent@1 capability NOT published
```

So on a deployment with no Anthropic key, **neither grant table exists**, and
both C4 public-path consent and C7 SQL grants are structurally impossible. The
symptom is silent: the tables are simply absent, `_multi_orchestrator_migrations`
is never created, and nothing logs a migration failure — because no migration was
ever attempted.

Verified: `_graph_migrations` (30 rows, the KG plugin's own dir) existed while
`_multi_orchestrator_migrations` did not exist at all.

*Local patch:* apply the 47 files by hand (`/tmp/p5-apply-core-migrations.sh`,
reproduced in §7). All 47 applied cleanly — the migrations are fine; only their
trigger is wrong.

### G4 — a failed activation reports `status: "active"` (**silent, worst-in-class**)

`installService.ts:274-306` writes `status: 'active'` to the registry **before**
running the `onInstalled` hook, then catches and logs the hook's error without
touching the status:

```
[install] onInstalled hook failed for @omadia/dev-platform:
  NativeToolRegistry: duplicate native-tool name 'dev_job_start'
```

Observable end state: `GET /api/v1/admin/runtime/installed/@omadia%2Fdev-platform`
answers `{"id":"@omadia/dev-platform","status":"active"}` while **every route
404s and the nav entry is absent** — the plugin's own `undo()` rolled everything
back. A green status over a dead plugin.

The boot path gets this right — `toolPluginRuntime.ts:230` calls
`markActivationFailed`. The install path is the asymmetric one.

*No local patch needed* (the underlying trigger was plugin defect P1, §4).
**This is the one prepared as a core PR** — see §5.

### G5 — no scoped plugin can express a nav href (**blocks nav**)

```
UiRouteCatalog.registerNav(@omadia/dev-platform/devPlatform): href segment
  '%40omadia%2Fdev-platform' has characters outside [A-Za-z0-9-._~] —
  query strings, fragments, percent-encoding and backslashes are not accepted
```

Two core rules that cannot both be satisfied:

- The SPA route is `/p/:pluginId/ui/` (`middleware/src/routes/pluginUiStatic.ts:119`).
  Express yields `@omadia/dev-platform` only from the **encoded**
  `%40omadia%2Fdev-platform`. Measured: encoded → **200**, raw → **404** (the raw
  form splits into two path segments).
- `HREF_SEGMENT = /^[A-Za-z0-9\-._~]+$/` (`middleware/src/platform/uiRouteCatalog.ts:34`)
  rejects `%`, `@` and `/` alike.

Encoded is the only URL that works and the only one the validator forbids. Every
`@scope/name` plugin id hits this.

*Local patch:* allow percent-octets — `/^(?:[A-Za-z0-9\-._~]|%[0-9A-Fa-f]{2})+$/`.

### G6 — the C12 blocker, exactly as the epic predicted

```
tool-runtime: @omadia/dev-platform cannot activate — public-path declaration
  '/api/v1/dev-runner' from plugin '@omadia/dev-platform' is already a static
  core public path (/^\/api\/v1\/dev-runner(?:\/|$|\?)/) — remove the core
  exemption first, or drop the declaration
```

`middleware/src/auth/publicPaths.ts:41` and `:44` still carry the two
dev-platform exemptions from before extraction. C4's exclusive-ownership check
refuses a declaration for a prefix that is also a static core exemption. The
README says these leave in **C12, not C4** — so this is known, scheduled, and
currently the last hard blocker.

*Local patch:* comment out both literals. Everything passed immediately after.

---

## 4. Plugin defects found and fixed

### P1 — `activate()` double-registered every chat tool (**broke the whole plugin**)

`ctx.tools.register` and `ctx.tools.registerHandler` are **alternative** doors
into one name-keyed map in `NativeToolRegistry`, and both throw on a duplicate
(`harness-orchestrator/src/nativeToolRegistry.ts:148`, `:198`). `activate()`
called both per tool, so the very first one threw
`duplicate native-tool name 'dev_job_start'`, activation rolled back, and the
plugin served nothing — presenting as G4's phantom `active`.

The true cause was a **type** defect. The plugin's hand-narrowed context type
declared:

```ts
register(spec: unknown, options?: { promptDoc?: string }): () => void;
```

— **no `handler` parameter**, against core's real
`register(spec, handler, options)`. With nowhere to pass a handler, reaching for
`registerHandler` was the only writable option. The second call also passed no
handler at all (`register(reg.spec)`, arity 1 against a 3-arg signature), so even
without the throw the tool would have dispatched to `undefined`.

A structural type narrower than the real contract did not merely under-describe
it — it made the correct call unwritable.

**Fixed:** corrected the type, then one call:
`ctx.tools.register(reg.spec, reg.handler, { promptDoc })`.

**Tested:** the existing stub accepted anything and returned a disposer, which is
why it stayed green over a plugin that died on contact with a real core. The stub
now models the kernel's shared name map and throws on duplicate. Two assertions —
`registers each chat tool EXACTLY once, with a handler and a promptDoc`, plus the
existing count check. **Mutation-checked:** restoring the double-registration
fails 3 tests with the production error string verbatim.

### P2 — the ZIP shipped 145 sourcemaps (1,736,840 bytes)

`ui/assets/index-*.js.map` alone was 1,196,047 bytes against a 292,797-byte
bundle — 80% of the uncompressed payload. Archive **965,433 → 517,009 bytes**.

Nothing downstream catches it: `.map` **is** in core's ZIP extension allowlist
(`middleware/src/plugins/zipExtractor.ts:28`), so ingest accepts it silently —
unlike `.css`, whose *absence* from that allowlist is what makes the existing
stylesheet guard self-enforcing. A `.js.map` also carries the full original
TypeScript, so shipping one republishes the plugin's source into every
installation that unzips it.

**Fixed:** prune `*.map` from the stage (not at zip time — `createFlatZip` has
three backends and only `zip` honours `-x`). **Tested + mutation-checked**, with
an inverse guard so deleting `ui/` cannot make the assertion vacuous.

---

## 5. Core PR opened

**One** gap was small enough and clearly enough inside core's plugin runtime to
fix rather than only report: **G4**.

`fix/470-p5-install-status-truthful` — on a failed `onInstalled` hook, mark the
registry entry `errored` with the hook's message instead of leaving the
`status: 'active'` written moments earlier. It makes the install path agree with
the boot path, which already calls `markActivationFailed`.

Opened READY, **not merged**, per instruction.

G1/G2/G3/G5/G6 are reported as issues, not PRs: each needs a design decision
(which ramp, what optionality syntax, who owns the core ledger, what a plugin
href should look like, when C12 lands) rather than a patch.

---

## 6. What still blocks a staging install

In dependency order. **None is plugin-side.**

1. **G6 / C12** — the two static `publicPaths.ts` literals must go. Until then
   activation *cannot* complete on an unpatched core. Hardest blocker; also the
   most scheduled.
2. **G2** — `requires:` optionality. The plugin cannot be installed at all
   against a core that provides none of the four optional capabilities, which is
   every core today.
3. **G3** — without an Anthropic key, staging has no `plugin_sql_grants` and no
   `plugin_public_path_grants` table, so neither consent can be recorded.
4. **G1** — a staging core carrying C7 will not boot.
5. **G5** — nav entry will not register; the plugin is reachable only by URL.
6. **Open by design (acceptance.md §3.15):** grant rows are **not** revoked on
   uninstall — measured `plugin_sql_grants=1`, `plugin_public_path_grants=3`
   after a clean uninstall. The runtime *does* stop honouring them (the public
   path went 200 → 404), so this is orphaned rows, not a live hole. The lifecycle
   decision the doc leaves open is still open.

### Does the SPA load data in a real browser?

**Only through web-ui's origin.** Verified by measurement, not assumption:

- The bundle calls `/bot-api/v1/admin/dev-platform/...` (`packages/ui/src/lib/api.ts:21`).
- Core answers **404** on `/bot-api/*` and **200** on `/api/v1/...`.
- The document's CSP is `connect-src 'self'`, so the SPA can never reach another origin.
- web-ui carries proxy route handlers for **both** `/bot-api/*` and `/p/*`
  (`web-ui/app/bot-api/[[...path]]/route.ts`, `web-ui/app/p/[[...path]]/route.ts`,
  resolving `MIDDLEWARE_URL` per request).

So the intended path — shell at web-ui, nav → `/plugin-ui/<id>`, iframe →
`/p/<id>/ui/` on the **web-ui** origin, API → `/bot-api/*` on that same origin —
is coherent: one origin, cookie flows, CSP satisfied. Served **directly from
core**, as in this run, the SPA renders but every API call 404s.

This run had no web-ui, so that row is verified by construction, not by browser.
Cookie/CORS itself is fine: a same-origin `fetch` with the session cookie and an
`Origin` header returned **200**.

---

## 7. Reproducing

```bash
# 1. Postgres
export DOCKER_HOST=unix:///Users/marcelwege/.orbstack/run/docker.sock
docker run -d --name p5-acceptance-pg \
  -e POSTGRES_DB=omadia -e POSTGRES_USER=omadia -e POSTGRES_PASSWORD=omadia-ci \
  -p 55439:5432 pgvector/pgvector:pg16

# 2. Core = main + C6 + C7 (C7 is CHERRY-PICKED; it will not merge)
git worktree add --detach /tmp/odoo-bot-p5 origin/main && cd /tmp/odoo-bot-p5
git merge --no-edit origin/feat/470-c6-session-auth-raw-body
git cherry-pick cf0fbfb3 53e0ea15 64d7c048 7bc6a0e4   # union-resolve manifestLoader.ts
# then apply the five local patches from §3 (G1, G2 x2, G5, G6)
cd middleware && npm install && npm run build

# 3. Core's own migrations — G3 means nothing else applies them
for f in middleware/migrations/*.sql; do
  docker exec -i p5-acceptance-pg psql -v ON_ERROR_STOP=1 -U omadia -d omadia -1 -f - < "$f"
done

# 4. Boot with the plugin disabled
DATABASE_URL='postgres://omadia:omadia-ci@127.0.0.1:55439/omadia' PORT=4100 \
  HOST=127.0.0.1 PUBLIC_BASE_URL=http://127.0.0.1:4100 AUTH_PROVIDERS=local \
  ADMIN_BOOTSTRAP_EMAIL=admin@byte5.de ADMIN_BOOTSTRAP_PASSWORD=omadia-local-dev-1 \
  DEV_PLATFORM_ENABLED=false PLATFORM_DATA_DIR=/tmp/p5-data \
  node dist/index.js

# 5. Plugin
cd ~/sources/omadia-dev-platform
npm ci && npm run build && npm test && npm run package -w packages/plugin

# 6. The run itself — idempotent, re-runnable
DATABASE_URL='postgres://omadia:omadia-ci@127.0.0.1:55439/omadia' \
  node scripts/acceptance-local.mjs
```

Plugin suite with the pg suites actually running (16 of them skip without a DB —
**670 tests / 16 suites skipped → 769 tests / 0 skipped**):

```bash
GRAPH_PG_TEST_URL='postgres://omadia:omadia-ci@127.0.0.1:55439/plugintests' \
OMADIA_CORE_DIR=/tmp/odoo-bot-p5 npm run test -w packages/plugin
```

---

## 8. Row-level results

### Install / uninstall (acceptance.md §3)

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Boots with no `DEV_*` config | PASS | `[middleware] listening on [127.0.0.1]:4100` |
| 2 | dev-platform endpoints 404 | PASS | jobs/repos/gates/dev-runner/webhooks all 404; anon → 401 |
| 3 | No nav entry, no admin card | PASS | `/api/v1/ui/navigation` has no `devPlatform` |
| 4 | No `dev_*` table required to boot | PASS | 0 `dev_*` tables at boot |
| 5 | Decoupling ratchet 0 | BLOCKED→n/a | core-repo check, out of scope here |
| 6 | Setup fields render from manifest | PASS | 23 fields, `state=awaiting_config` |
| 7 | Own migrations, 9 tables | PASS | ledger 9 rows; 9 `dev_*` tables |
| 8 | Public-path grant consented (H1) | PASS | `PUT …/public-paths` 200, 3 granted |
| 8b | SQL grant (C7) | PASS* | `INSERT INTO plugin_sql_grants` — **no HTTP endpoint exists** |
| 9 | Nav entry appears | PASS | after G5 patch |
| 10 | Every §2 row passes | PASS | 39 probes, 0 FAIL |
| 11 | Routers stop on uninstall | PASS | `GET /jobs` → 404 |
| 12 | Nav entry disappears | PASS | no `devPlatform` |
| 13 | Background loops stop | PASS | worker/gate-deadline disposed with the handle |
| 14 | Public-path grant revoked | PASS | `/api/v1/dev-runner/llm/` 200 → 404 |
| 15 | Data lifecycle | **BLOCKED** | tables+rows correctly remain (D3); grant rows orphaned — doc leaves this open |
| 16 | Reinstall with jobs in flight | PASS | ledger 9 (0 re-applied), `dev_repos` 1 → 1, routes 200 |

### Capability matrix (acceptance.md §2)

All 39 probes PASS. Full table in `/tmp/p5-acc.txt`; shape:

- **2.1 jobs** (12) — list/filter 200; unknown ids 404 **from the plugin** (JSON `code`), never from core; purge refuses without type-to-confirm (400).
- **2.2 repos & credentials** (12) — CRUD 200/404; device flow 503 `devplatform.device_flow_unconfigured`; `github-apps` 200.
- **2.3 gates** (2) — inbox 200; resolve 400 on a nil gate.
- **2.4 runner phone-home** (10) — all 401 without a `djr_` token, which is the point; `GET /llm/` **200 unauthenticated** (the CLI's liveness probe); job-policy 503 daemon-unconfigured.
- **2.5 webhook** (1) — 401 on bad HMAC over the raw body.
- **GitHub App public** (2) — 400 without a valid state token.

**Two BLOCKED, both honest:**

- **3 chat tools registered** — core exposes no tool-registry endpoint, so this
  cannot be probed over HTTP. Log evidence:
  `[dev-platform] chat orchestrator tools registered (dev_job_start / dev_job_status / dev_job_list)`.
- **Grant rows after uninstall** — §3.15's open decision, above.

### Background loops

```
[dev-platform] activated — worker running (max 2 concurrent, 0 backend(s))   ← claim worker, 5s
[dev-platform] dev-retention cron registered (17 3 * * *)                    ← kernel cron
[dev-platform] GitHub webhook router registered at /api/webhooks/github (raw body, HMAC auth)
```
Gate-deadline worker starts inside `wired.start()` (60s, `unref`'d). Tracker
polling ships dormant by design and was not probed.

### ZIP

| Check | Result |
|---|---|
| `manifest.identity.version` == `package.json` version | PASS — both `0.2.0` |
| `dist/plugin.js` | PASS |
| `migrations/*.js` == 9 + `checksums.json` | PASS |
| `ui/index.html` + hashed asset | PASS — `ui/assets/index-BnGGkA-G.js` |
| no `.css` | PASS |
| no `node_modules` | PASS |
| **no sourcemaps** | **was FAIL — 145 maps / 1,736,840 bytes; fixed (P2)** |
| upload accepted | PASS — 201, 517,753 bytes, 160 files extracted |

---

## 9. Notes for whoever picks this up

- **`.map` being allowlisted at ingest is worth a second look.** It let a
  1.2 MB sourcemap through silently. The `.css` rule works precisely because
  absence from the allowlist makes it self-enforcing; `.map` has no such
  backstop and now relies on a plugin-side test.
- **`llm_allowed_models` is typed `host_list`.** It holds *model ids*, but
  `host_list` values are unioned into the plugin's outbound egress allowlist
  (`middleware/src/platform/pluginContext.ts:1778-1792`). An operator's model
  choice therefore mutates egress policy. Not fixed here — changing the field
  type is a config-migration decision, not a P5 call — but it is a type error
  with a security edge.
- **`peers_missing: ["@omadia/dev-platform-plugin-api"]`** on upload. Harmless in
  this run (the entry bundles what it needs), but the installer noticed a peer it
  could not resolve and said so only in the upload response.
- **A same-version re-upload serves the OLD code.** After replacing the ZIP at
  the same id+version, the previously-`import()`ed module was reused from Node's
  ESM cache and the fixed build did not take effect until a restart. Cost real
  time here; would cost an operator more.
