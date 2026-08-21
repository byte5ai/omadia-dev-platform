# Acceptance run — 2026-08-21b (core `main` with C15)

Re-run of `docs/ACCEPTANCE-RUN-2026-08-21.md` against core `main` **after**
`byte5ai/omadia#815` (epic #470 C15) landed. That run left two things open: 33
rows that only passed on an unmerged C12 branch, and G7 — the C11 ledger handoff
inverted into a no-op. Both are closed here, on plain `origin/main`, with no
patches and no cherry-picks.

## 1. Headline

| Run | Database | PASS | FAIL | BLOCKED | Rows |
|---|---|---|---|---|---|
| **A** | fresh | **71** | **0** | 2 | 73 |
| **B** | pre-seeded (donor rows + 9 tables, plugin ledger dropped) | **71** | **0** | 2 | 73 |

`scripts/acceptance-local.mjs` exits with the FAIL count; both runs exited `0`.

The two BLOCKED rows are the same two as 2026-08-20 and 2026-08-21, both honest,
neither new: core still exposes no tool-registry endpoint to probe chat-tool
registration over HTTP, and `acceptance.md` §3.15 still has not decided what
happens to grant rows on uninstall.

**The 33 rows that needed the C12 branch last time pass on `main` now.** #807
landed; `publicPaths.ts` no longer carries the two dev-platform literals. No
plugin change was required and none was made — the artifact under test is the
same 0.3.1 the repo has been carrying.

## 2. What was run against what

| | |
|---|---|
| Plugin | `omadia-dev-platform` `origin/main` @ `ec4a2b75`, clean tree, **0.3.1** |
| Artifact | `omadia-dev-platform-0.3.1.zip`, 537,065 bytes |
| | sha256 `618d8b60b95aeceae7258ea0fe362605a358728382ed6706526be980e6ed6124` |
| Core | `byte5ai/omadia` `origin/main` @ `8900d7b9` — the squash of #815 |
| `@omadia/plugin-api` | **1.6.0** |
| Node | v22.22.3 (nvm) |
| Postgres | `pgvector/pgvector:pg16` on 55451 (acceptance) / 55452 (suite) |
| Core env | `PORT=4121`, local password auth, no `DEV_*` keys |

Suite: **1,318 tests, 0 fail** — 788 `plugin` + 76 `runner-shim` + 454
`dev-runner-daemon`, plus 5 `ui` vitest files — with the Postgres suites
actually running (`GRAPH_PG_TEST_URL` set, #572). The only skips remain the two
that need a built `dev-runner` image.

## 3. G7 is closed — the handoff runs before the runner

The 2026-08-21 run measured the C11 handoff arriving *after* core's pre-activate
migration runner had already written all nine ledger rows, so it could only ever
report `alreadySeeded` and the `skippedNoWitness` alarm was unreachable. C15
moves the handoff into the kernel, ahead of its own runner, driven by
`permissions.sql.handoff: handoff-plan.json` in the manifest.

### Run A — fresh database

A fresh database is **already** the upgrade shape on this core, because core
still ships `migrations/0022_dev_platform.sql` … `0030_…sql`. After core's own
boot migrations and before the plugin is installed:

```
donor rows in _multi_orchestrator_migrations (0022..0030) : 9
dev_* tables                                              : 9
plg_omadia_dev_platform_migrations                        : ABSENT
```

Install, in log order:

```
[tool-runtime] @omadia/dev-platform: ledger handoff — 9 seeded, 0 already seeded,
  0 left for the migration runner (ledger 'plg_omadia_dev_platform_migrations',
  donor '_multi_orchestrator_migrations', 56ms)          ← core, BEFORE activate()
[@omadia/dev-platform] [dev-platform] migrations: 0 applied,
  9 already in ledger 'plg_omadia_dev_platform_migrations' (2ms)
```

Nine adopted, **zero applied**. Compare the inverted pair the previous run
recorded (`applied 9 migration(s)` first, then `0 seeded, 9 already seeded`).

The plugin's own `ctx.sql.seedLedger` call inside `activate()` now correctly
degrades to `0 seeded, 9 already seeded` — which is what C15 predicted it should
report once the kernel has done the work, and is why the call was left in place
for plugins running against an older core.

### Run B — pre-seeded database

To exercise the restore/rolled-back-deploy shape deliberately, the plugin ledger
was dropped while everything else was left standing, including a live
`dev_repos` row:

```
donor rows : 9      dev_* tables : 9
plugin ledger : ABSENT           dev_repos : 1
```

On the next boot:

```
[tool-runtime] @omadia/dev-platform: ledger handoff — 9 seeded, 0 already seeded,
  0 left for the migration runner (ledger 'plg_omadia_dev_platform_migrations',
  donor '_multi_orchestrator_migrations', 70ms)
[@omadia/dev-platform] [dev-platform] migrations: 0 applied, 9 already in ledger
```

The ledger went `0 → 9` rows by adoption alone, no migration was applied, and
`dev_repos` still held its row. `§3.16 reinstall is lossless` reports
`ledger=9 (0 re-applied), dev_repos=1`.

### The alarm fires — negative control

The one output C11 existed to produce, and the one the previous run could not
reach. The ledger was dropped **and** a single witnessed schema object with it
(`dev_job_events_truncated_once_idx`, the witness for `0030`):

```
[tool-runtime] @omadia/dev-platform: ledger handoff — 8 seeded, 0 already seeded,
  1 left for the migration runner (…)
[tool-runtime] WARN @omadia/dev-platform: ledger handoff — the donor ledger records
  1 file(s) whose witness says the schema object is ABSENT; the migration runner
  will apply them, which is the repair — confirm this is the database you think it
  is: 0030_dev_job_events_truncated_marker.js
[tool-runtime] @omadia/dev-platform: applied 1 migration(s) to ledger
  'plg_omadia_dev_platform_migrations' in 8ms (0030_dev_job_events_truncated_marker.js)
```

Eight adopted, the one unwitnessed file named and applied, the index recreated,
the ledger back to 9 and `dev_repos` untouched. The alarm distinguishes "already
done" from "the database is not the one you think it is", which is the whole
point of the feature and was indistinguishable before C15.

## 4. Row-level results (both runs identical)

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Boots with no `DEV_*` config | PASS | `listening on [127.0.0.1]:4121` |
| 2 | dev-platform endpoints 404 before install | PASS | jobs/repos/gates/dev-runner/webhooks all 404 |
| 3 | No nav entry, no admin card | PASS | `/api/v1/ui/navigation` has no `devPlatform` |
| 4 | No `dev_*` table required to boot | PASS | core boots on its own migrations |
| 6 | Setup fields render from manifest | PASS | 23 fields, `state=awaiting_config` |
| 7 | Own migrations, 9 tables | PASS | ledger 9 rows; 9 `dev_*` tables |
| 8 | Public-path grant consented (C4/H1) | PASS | granted 3 — **now on plain `main`** |
| 8b | SQL grant (C7) | PASS\* | `INSERT INTO plugin_sql_grants` — still no HTTP endpoint |
| 9 | Nav entry appears | PASS | `navId devPlatform`, no local patch |
| 10 | Every §2 row passes | PASS | 39 probes, 0 FAIL |
| 11 | Routers stop on uninstall | PASS | `GET /jobs` → 404 |
| 12 | Nav entry disappears | PASS | no `devPlatform` |
| 13 | Background loops stop | PASS | worker + gate-deadline disposed with the handle |
| 14 | Public-path grant revoked | PASS | 200 → 404 |
| 15 | Data lifecycle | PASS / **BLOCKED** | tables + rows remain (D3); grant rows orphaned — §3.15 undecided |
| 16 | Reinstall lossless | PASS | `ledger=9 (0 re-applied), dev_repos=1` |

The §2.6 row (`3 chat tools registered`) stays BLOCKED because core exposes no
tool-registry endpoint over HTTP. The activation log does show it —
`chat orchestrator tools registered (dev_job_start / dev_job_status / dev_job_list)`
— so the capability is evidenced; only the *probe* is missing.

## 5. Reproducing

```bash
# 1. Postgres
docker run -d --name acc-0821b-pg \
  -e POSTGRES_DB=omadia -e POSTGRES_USER=omadia -e POSTGRES_PASSWORD=omadia-ci \
  -p 55451:5432 pgvector/pgvector:pg16

# 2. Core — plain origin/main, no patches
git -C ../odoo-bot worktree add /tmp/odoo-bot-accept origin/main
cd /tmp/odoo-bot-accept/middleware && npm install && npm run build
node -p "require('./packages/plugin-api/package.json').version"   # 1.6.0

# 3. Boot
DATABASE_URL='postgres://omadia:omadia-ci@127.0.0.1:55451/omadia' PORT=4121 \
  HOST=127.0.0.1 PUBLIC_BASE_URL=http://127.0.0.1:4121 AUTH_PROVIDERS=local \
  ADMIN_BOOTSTRAP_EMAIL=admin@byte5.de ADMIN_BOOTSTRAP_PASSWORD=omadia-local-dev-1 \
  PLATFORM_DATA_DIR=/tmp/acc/data node dist/index.js

# 4. Plugin, built against that core
cd ~/sources/omadia-dev-platform
npm ci && OMADIA_CORE_DIR=/tmp/odoo-bot-accept npm run link:core
npm run build && npm run package -w packages/plugin

# 5. The run — idempotent, re-runnable, exit code == FAIL count
BASE_URL=http://127.0.0.1:4121 \
  DATABASE_URL='postgres://omadia:omadia-ci@127.0.0.1:55451/omadia' \
  node scripts/acceptance-local.mjs
```

Run B, on the database run A left behind:

```bash
psql "$DATABASE_URL" -c 'DROP TABLE plg_omadia_dev_platform_migrations;'
# restart core; the kernel handoff adopts all nine on activation
```

Full suite with the Postgres suites live (#572):

```bash
docker run -d --name acc-0821b-pgtest -p 55452:5432 \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
  pgvector/pgvector:pg16
GRAPH_PG_TEST_URL=postgres://test:test@127.0.0.1:55452/test \
OMADIA_CORE_DIR=/tmp/odoo-bot-accept npm test
```

## 6. Notes for whoever picks this up

- **`npm run package` does not gate on `npm run build`.** A `tsc` failure still
  produced a ZIP — 142,081 bytes against the 537,065 of a good build, because the
  UI bundle was missing. It looked like a plugin package. Never publish an
  artifact from a run whose build exit code you did not read.
- **Deleting `dist/` without `*.tsbuildinfo` makes an incremental `tsc` emit
  nothing**, and the failure surfaces one package later as
  `Cannot find module '@omadia/dev-platform-plugin-api'`. The repo's own `clean`
  script removes both; a hand-rolled clean must too.
- **A fresh database is not a "no donor rows" case on this core**, because core
  still ships `0022`–`0030`. There is currently no way to reach the handoff with
  an empty donor ledger short of a core that has dropped those files — which is
  deliberate: those rows are the rollback path while core still ships them.
- §3.15 (grant rows on uninstall) is still undecided in `acceptance.md`, and is
  now the only spec-level question left in the install/uninstall section.
