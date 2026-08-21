# Acceptance run — 2026-08-21c (core `main` with C16, the unified grant route)

This is the first run against a core that ships **C16** (`byte5ai/omadia#824`,
epic #470). C16 replaced the two-mechanism grant procedure with one route —
`GET|PUT /api/v1/admin/runtime/installed/:id/grants` — plus the install wizard's
Permissions step, the plugin page's Grants panel, in-process re-activation, and
a purge of both grant tables on uninstall (B6).

The previous run (`ACCEPTANCE-RUN-2026-08-21b.md`) was the last one made on a
pre-C16 core, where the SQL grant had no HTTP surface at all and went in as a
hand `INSERT`.

---

## 1. Headline

| Suite | PASS | FAIL | BLOCKED | Rows |
|---|---|---|---|---|
| `scripts/acceptance-local.mjs` | **73** | **0** | 1 | 74 |
| C16 grant-consent "Skip" probe | **15** | **0** | 0 | 15 |

`acceptance-local.mjs` exits with the FAIL count; this run exited `0`.

Against 2026-08-21b (71 PASS / 0 FAIL / 2 BLOCKED, 73 rows) the deltas are all
in the direction C16 promised:

- **§3.15 went BLOCKED → PASS.** Uninstall now clears `plugin_sql_grants` *and*
  `plugin_public_path_grants`. On the pre-C16 core those rows were left behind,
  orphaned, and the harness refused to call that either a pass or a fail.
- **§3.8 collapsed two rows into one and gained a new one.** The C4
  `/public-paths` PUT plus the hand `INSERT` became a single unified PUT, and
  "grant takes effect in-process (no restart)" is a claim that could not be made
  before at all.
- The one remaining BLOCKED is unchanged and honest: §2.6 `3 chat tools
  registered` — core exposes no tool-registry endpoint, so the harness cannot
  reach a verdict and says so rather than passing quietly.

---

## 2. What was run against what

| | |
|---|---|
| Core | `byte5ai/omadia` `main` @ `3df6dde8` (#824, C16) — no patches |
| Core worktree | `/tmp/odoo-bot-c16` |
| `@omadia/plugin-api` | **1.7.0** (was 1.6.0 on the C15 run) |
| Plugin | `byte5ai/omadia-dev-platform` `main` @ `a84d3fc` — clean clone, not the dev checkout |
| Plugin version | `0.3.3` (`package.json` and `manifest.yaml` agree) |
| ZIP | `omadia-dev-platform-0.3.3.zip`, 538 458 bytes |
| ZIP sha256 | `d22022bca7d922abe84894d87b64c2af1fb4be3a1c3631226be25838fc002d13` |
| Core env | `PORT=4131`, local password auth, no `DEV_*` keys |
| Database | `pgvector/pgvector:pg16` on `:55461`, fresh volume |
| Node | v22.23.2 |

### Postgres needs pgvector — `postgres:16-alpine` does not boot this core

Worth writing down because it costs an hour if you meet it cold. With
`DATABASE_URL` set, core bootstrap auto-installs `@omadia/knowledge-graph-neon`,
whose `activate()` runs `CREATE EXTENSION vector`. On a stock `postgres:16`
image that fails with `extension "vector" is not available`, the
`knowledgeGraph` service is never published, and core aborts at

```
[middleware] fatal startup error: Error: [middleware] knowledgeGraph service
missing after tool-plugin activation — @omadia/knowledge-graph must be built-in
and active
```

which names neither Postgres nor pgvector. Use a pgvector image.

---

## 3. The grant path — which one actually ran

This is the point of the run, so it gets its own section. "Granted" over the
unified route and "granted" over the pre-C16 pair are two different claims.

`acceptance-local.mjs` reports the surface it used, and it used the C16 one:

```
## §3.8
  PASS    both grants (C16 unified PUT)              sql=true, 3 public paths, state=active
  PASS    grant takes effect in-process (no restart) state=active straight out of the PUT
```

and again after the reinstall leg (line 130 of the run log). The
`PUT …/installed/%40omadia%2Fdev-platform/grants` answered `200` with

```json
{"sql":true,
 "sql_ledger":"plg_omadia_dev_platform_migrations",
 "public_paths":["/api/v1/dev-runner","/api/webhooks/github","/api/v1/dev-platform"]}
```

and `state: "active"` read back *after* the in-process re-activation.

### What the main harness does NOT prove, and the probe that does

`acceptance-local.mjs` probes for the unified route **before** its clean slate,
when the plugin may not be installed. A missing route and a not-installed plugin
both answer `404`, so the harness deliberately refuses to read a `404` as "no
C16" and keeps the pre-C16 *ordering*: it inserts the SQL grant row before
activation (the `§3.8 SQL grant (permissions.sql)` row at the top of the log,
still labelled `pre-C16 core: no HTTP endpoint`).

The consequence is that the unified PUT in the main run lands on a plugin whose
SQL grant was **already on record**. It proves the route works. It does not
prove the route alone can carry a plugin from "installed but ungranted" to
active — which is exactly what an operator who presses **Skip** does.

So that flow was walked separately (`skip-probe`, 15 rows, 0 FAIL). Verbatim
evidence:

**A — install, then Skip the Permissions step**

```
install-job state=active        ← the JOB completed
GET …/grants -> HTTP 200
  declared: {"sql":{"ledger":"plg_omadia_dev_platform_migrations", …},
             "public_paths":["/api/v1/dev-runner","/api/webhooks/github","/api/v1/dev-platform"]}
  granted:  {"sql":false,"sql_ledger":null,"public_paths":[]}
  missing:  [{"kind":"sql","ledger":"plg_omadia_dev_platform_migrations"},
             {"kind":"public_path","path":"/api/v1/dev-runner"},
             {"kind":"public_path","path":"/api/webhooks/github"},
             {"kind":"public_path","path":"/api/v1/dev-platform"}]
  state:    errored
```

with core logging the reason and the remedy in the same line:

```
[install] onInstalled hook failed for @omadia/dev-platform: plugin
'@omadia/dev-platform' declares `permissions.sql` but the operator has not
granted it — 'graphPool' stays unavailable until the grant is recorded. Grant it
in the admin UI under Plugins → this plugin → Permissions, or with
PUT /api/v1/admin/runtime/installed/%40omadia%2Fdev-platform/grants {"sql":true}
```

**B — grant, no restart**

```
PUT …/grants {"sql":true,"public_paths":[…3…]} -> HTTP 200, state=active
  no restart — same core process        pid 32939 before and after
  GET …/grants: missing[] = []
  GET /api/v1/admin/dev-platform/jobs   -> 200
  GET /api/v1/dev-runner/llm/           -> 200   (public path now exempt)
  plugin_sql_grants=1  plugin_public_path_grants=3
```

**C — uninstall purges both tables (B6)**

```
plugin_sql_grants=0  plugin_public_path_grants=0
```

**D — reinstall asks again**

```
state=errored
missing[] = [sql, /api/v1/dev-runner, /api/webhooks/github, /api/v1/dev-platform]
```

That is the full loop the C16 issue (#817) asked for: Skip is a real state, the
route names what is missing in structured form, granting repairs it in-process,
uninstall forgets, and a reinstall under the same id starts un-granted instead of
inheriting the previous package's database access and unauthenticated surface.

---

## 4. Observations

**The install job says `active` while the plugin is `errored`.** The install
job's `state` tracks the *job* lifecycle — upload, configure, hand off — and
reaches `active` even when `activate()` then failed for a missing grant. The
plugin's runtime state lives on the grants route (`GET …/grants → state`).
Reading the job alone would tell an operator the install worked. The wizard's
Permissions step is what keeps a human out of that gap; anything automating
against the install API should read the grants route, not the job.

**The harness's pre-activation SQL-grant row is now mislabelled.** It prints
`inserted into plugin_sql_grants (pre-C16 core: no HTTP endpoint)` even on a core
that plainly has the endpoint, because the pre-probe could not conclude and the
ordering stayed pre-C16. The row is truthful about *what it did* and wrong about
*why*. Options for a follow-up: re-probe after install (where a 404 is
conclusive) and skip the legacy insert on a C16 core, or reword the row. Left as
found in this run — changing the harness mid-run would have invalidated the
comparison with 2026-08-21b.

---

## 5. Reproducing

```bash
# 1. Postgres — pgvector, NOT stock postgres:16
docker run -d --name acc-c16-pg \
  -e POSTGRES_DB=omadia -e POSTGRES_USER=omadia -e POSTGRES_PASSWORD=omadia-ci \
  -p 55461:5432 pgvector/pgvector:pg16

# 2. Core — plain origin/main, no patches
git -C ../odoo-bot worktree add /tmp/odoo-bot-c16 origin/main
cd /tmp/odoo-bot-c16/middleware && npm install && npm run build
node -p "require('./packages/plugin-api/package.json').version"   # 1.7.0

# 3. Boot
DATABASE_URL='postgres://omadia:omadia-ci@127.0.0.1:55461/omadia' PORT=4131 \
  HOST=127.0.0.1 PUBLIC_BASE_URL=http://127.0.0.1:4131 AUTH_PROVIDERS=local \
  ADMIN_BOOTSTRAP_EMAIL=admin@byte5.de ADMIN_BOOTSTRAP_PASSWORD=omadia-local-dev-1 \
  PLATFORM_DATA_DIR=/tmp/acc-c16-data node dist/index.js

# 4. Plugin — clean clone of main, built against that core
git clone --branch main git@github.com:byte5ai/omadia-dev-platform.git /tmp/omadia-dev-platform-c16
ln -sfn /tmp/odoo-bot-c16 /tmp/odoo-bot      # so `file:../odoo-bot/…` resolves
cd /tmp/omadia-dev-platform-c16
npm ci && OMADIA_CORE_DIR=/tmp/odoo-bot-c16 npm run link:core
npm run build && npm run package -w packages/plugin

# 5. The run — idempotent, re-runnable, exit code == FAIL count
BASE_URL=http://127.0.0.1:4131 \
  DATABASE_URL='postgres://omadia:omadia-ci@127.0.0.1:55461/omadia' \
  node scripts/acceptance-local.mjs
```

The Skip probe in §3 is a throwaway script, not part of the repo. It is
reproducible by hand in six calls: `POST /api/v1/auth/login/local`,
`POST /api/v1/install/packages/upload`, `POST /api/v1/install/plugins/:id`,
`POST /api/v1/install/jobs/:jobId/configure` (grant nothing),
`GET  /api/v1/admin/runtime/installed/:id/grants` (read `missing[]`, `state`),
`PUT  /api/v1/admin/runtime/installed/:id/grants` `{"sql":true,"public_paths":[…]}`.

---

## 6. Notes for whoever picks this up

- **`npm run package` does not gate on `npm run build`** (carried over from
  2026-08-21b, still true). A `tsc` failure still produces a ZIP from the
  previous `dist/`. Run `build` first and check its exit code.
- **A clean plugin clone needs a sibling core.** `package.json` pins
  `@omadia/plugin-api` to `file:../odoo-bot/middleware/packages/plugin-api`, so
  `npm ci` in a clone at some other path fails before `link:core` ever runs.
  Symlink the core to `../odoo-bot`, then `link:core` for the override.
- **Kill the core by port, not by pattern.** The process command line is
  `node dist/index.js`; `pkill -f '/tmp/odoo-bot-c16/middleware/dist/index.js'`
  matches nothing and silently leaves the old core holding the port, which then
  answers the next run against a database you already dropped. `lsof -ti :PORT`.
