# Operator Guide — `@omadia/dev-platform`

Everything needed to install, consent to, credential, run, upgrade and remove
the Dev Platform. The [README](../README.md) is the project overview; this is
the runbook.

- [1. What you are installing](#1-what-you-are-installing)
- [2. Prerequisites](#2-prerequisites)
- [3. Install](#3-install)
- [4. The two operator grants](#4-the-two-operator-grants)
- [5. Credentials — you enter these yourself](#5-credentials--you-enter-these-yourself)
- [6. Choosing a runner backend](#6-choosing-a-runner-backend)
- [7. Migration handoff](#7-migration-handoff)
- [8. Optional capabilities and what you lose](#8-optional-capabilities-and-what-you-lose)
- [9. Supply chain](#9-supply-chain)
- [10. Uninstall and purge](#10-uninstall-and-purge)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Known open issues](#12-known-open-issues)
- [Appendix A — Older cores](#appendix-a--older-cores)

---

## 1. What you are installing

An agent clones one of your repositories into an isolated runner, works a job
through an analyze → plan → implement → review pipeline, and opens a pull
request. Human approval gates, a diff policy, a per-job cost budget and a
default-deny egress proxy bound what it can do.

The plugin contributes nine database tables it migrates itself, three chat
tools, three background workers, an operator SPA, and HTTP routes — three of
which are served without a kernel session and therefore need your explicit
consent (§4).

## 2. Prerequisites

| Requirement | Why |
|---|---|
| **omadia core ≥ 1.5** (`@omadia/plugin-api` 1.5.0) | The floor: `ctx.sql.seedLedger` (the migration handoff) arrived there. Below it the handoff silently does not happen. **1.6.0 is recommended** — it honours `permissions.sql.handoff`, which is what makes the handoff run *before* core's own migration runner (G7, §12). |
| **Postgres-backed knowledge graph** | The job, repo, gate and artifact tables live in `graphPool`. With an in-memory graph the plugin **refuses to activate** rather than pretending to work — set `DATABASE_URL` and install the Neon knowledge-graph plugin first. |
| **A runner backend** | Fly Machines or local Docker. See §6. |
| **An LLM provider key** | The proxy forwards to it. Also required for core's own orchestrator to publish `chatAgent@1`. |

`graphPool@1` is the plugin's only hard capability requirement. If core cannot
provide it, install is refused with HTTP 409 `install.missing_capability`.

## 3. Install

**From the hub.** In your omadia instance, open **Admin → Registries**, add
`https://hub.omadia.ai`, then install **Dev Platform** from
**Admin → Plugins → Store**.

**From a ZIP.** Build it yourself and upload in the admin UI:

```bash
npm ci && npm run build
npm run package -w packages/plugin
# → packages/plugin/out/omadia-dev-platform-<version>.zip
```

The artifact is flat — `manifest.yaml`, `package.json`, `dist/`, `migrations/`,
`ui/`, `handoff-plan.json` and `LICENSE` at the archive root, no wrapping
directory.

> **Never re-upload a changed ZIP under the same version.** The previously
> `import()`ed module is reused from Node's ESM cache, so the old code keeps
> serving until you restart the middleware. Bump the version instead. This cost
> real time during the acceptance run; it will cost an operator more.

## 4. The two operator grants

The manifest *asks*; a human has to *agree*. Neither grant is implied by
installing — but both are now answered in the admin UI, in the install wizard
or on the plugin page, and neither needs a middleware restart.

> **Does your core have this?** The consent surface arrived with core PR
> [byte5ai/omadia#824](https://github.com/byte5ai/omadia/pull/824) (epic #470
> C16). No `@omadia/plugin-api` type changed with it, so the version number
> cannot answer the question — ask the server:
>
> ```bash
> curl -X GET "$BASE/api/v1/admin/runtime/installed/@omadia%2Fdev-platform/grants"
> ```
>
> `200` with a `declared` block means you have it. `404` means you do not — use
> [Appendix A](#appendix-a--older-cores), which is the procedure this section
> documented before #824.

### 4.1 During install — the "Permissions" step

After the setup form is filled in and accepted, the wizard shows a
**Permissions** step. It lists what this manifest asks for and nothing else:

- **Own database tables** — the SQL permission, naming the migration ledger
  `plg_omadia_dev_platform_migrations`. The plugin creates and migrates its own
  nine tables and cannot reach omadia's or another plugin's.
- **One row per public path** — the three prefixes in §4.3, each stating that it
  answers without an omadia session and that declining leaves it behind the
  login.
- **Optional prerequisites** — `turnContext@1`, `githubAppJwt@1`,
  `usageTelemetry@1`, `conductorRoles@1`, listed *without* checkboxes. They are
  not permissions and there is nothing here for you to grant (§8).

The boxes start ticked, because ticked is what the manifest asked for.
**Grant & activate** records the consent and activates the plugin in the same
request, then shows the state the server read back — not an assumption that it
worked.

**Skip** is a real option and does not lose the install. It grants nothing, and
because this plugin reaches for the database in `activate()`, skipping leaves it
`errored` and the wizard says so rather than guessing. Grant it later from the
panel below: no reinstall, no restart.

### 4.2 Afterwards — the Grants panel

**Admin → Plugins → Dev Platform**, section **Permissions** (anchor `#grants`).
It shows what is granted against what the manifest declares, one toggle per
grant, and **Apply** saves and re-activates in place.

This is also where a grant is withdrawn. Turning the SQL permission off and
applying leaves the plugin `errored` — the honest answer, because it cannot run
without its tables — and the panel names the reason.

The panel starts from what is **granted**, not from what is declared, so a grant
you declined reads as declined instead of arriving pre-ticked.

A grant on record for a ledger the manifest no longer declares gets its own
line. That is a different problem from "not granted" and needs a different fix:
tick the box to grant the ledger the plugin now asks for.

### 4.3 What you are agreeing to

**The SQL permission (`permissions.sql`).** Core provisions `ctx.sql` only
against a grant whose ledger matches the manifest character for character; any
difference is not a partial grant, it is no grant. The ledger is taken from the
manifest and the granting identity from your session — neither is anything a
request body can dictate.

The name is not arbitrary: core derives `plg_<sanitized-plugin-id>_` from the id
*it* knows and rejects anything outside it. `plg_` is kernel-reserved so no core
table can live there, and the folded id means one plugin cannot nominate
another's ledger and forge its migration history.

**The public-path grants (`permissions.public_paths`).** Three prefixes are
served without a kernel session, because the caller has none to present. Each is
still authenticated:

| Prefix | Authenticated by |
|---|---|
| `/api/v1/dev-runner` | A per-job bearer token, verified inside the router. |
| `/api/webhooks/github` | HMAC-SHA256 over the raw request body. |
| `/api/v1/dev-platform` | The GitHub App manifest-conversion callback, bound to a kernel-signed, plugin-audience state token. |

Without these grants the runner cannot phone home, webhooks 401, and GitHub App
onboarding cannot complete. An ungranted public path is deliberately **not** an
activation failure: the route falls through to `requireAuth` and answers 401,
which is both the fail-closed direction and what every plugin installed before
this surface existed already depends on.

**Consent can never exceed the declaration.** Core refuses
`runtime.sql_not_declared` and `runtime.public_path_not_declared` for anything
this manifest does not ask for, so the consent surface cannot itself be used to
hand a plugin your database or make an arbitrary URL public.

### 4.4 For automation — the admin API

The UI calls one route, and so can you. Both grants travel together, behind
operator auth:

```bash
# What the manifest asks for, what is granted, the resulting state, and what is
# still missing
curl -X GET "$BASE/api/v1/admin/runtime/installed/@omadia%2Fdev-platform/grants"

# Grant both. Takes effect in-process — no middleware restart.
curl -X PUT "$BASE/api/v1/admin/runtime/installed/@omadia%2Fdev-platform/grants" \
  -H 'Content-Type: application/json' \
  -d '{"sql":true,
       "public_paths":["/api/v1/dev-runner","/api/webhooks/github","/api/v1/dev-platform"]}'
```

An **absent** key leaves that grant alone, which is how the panel's per-grant
toggle sends one at a time. A **present** `public_paths` is the complete set you
consent to — omitting a prefix revokes it. The response is the state read back
from the registry after the re-activation, including `last_activation_error`
when the plugin did not come back up.

Refusals worth knowing: `409 runtime.ledger_already_owned` (another plugin holds
that table), `503` (no database is configured, so nothing was recorded), and the
two `not_declared` codes above.

The older route keeps its exact request and response shape as an alias over the
same core, so existing automation does not need rewriting:

```bash
curl -X PUT "$BASE/api/v1/admin/runtime/installed/@omadia%2Fdev-platform/public-paths" \
  -H 'Content-Type: application/json' \
  -d '{"paths":["/api/v1/dev-runner","/api/webhooks/github","/api/v1/dev-platform"]}'
```

`node scripts/acceptance-local.mjs` drives the unified route when the core under
test ships it and falls back to the pre-#824 pair when it does not, so the
acceptance run exercises whichever path a real operator would be using.

## 5. Credentials — you enter these yourself

**Nothing is migrated for you, and that is deliberate.** The plugin stores
credentials in its own vault namespace, so after installing — and after any
reinstall — you re-connect each repository by hand.

A one-time core migration hook was rejected because it would move credentials
silently. The right moment to notice that a GitHub App private key has entered a
plugin's namespace is *while it is happening*, not during an incident.

What the plugin holds:

| Secret | Written when | Used for |
|---|---|---|
| GitHub App private key (PEM) | You register or bind a GitHub App | Minting short-lived installation tokens |
| GitHub App client secret | App registration | The OAuth leg of App setup |
| GitHub App webhook secret | App registration | HMAC over the raw webhook body |
| Per-repo clone token (PAT) | You connect a repo with a PAT | Read-only clone inside the runner |
| Per-repo device-flow token | You complete the device flow | Same |

**Steps.** Open **Dev Platform → Repositories** and connect a credential per
repo:

- **GitHub App — recommended.** The runner receives a freshly minted,
  single-repository, read-only installation token that is revoked when the job
  ends. No long-lived credential ever reaches the runner.
- **PAT** — scope it to the one repository.
- **Device flow** — currently **dormant**: `activate()` passes no device-flow
  provider, so `POST /repos/:id/connect/device*` answers `503
  devplatform.device_flow_unconfigured`. PAT and App onboarding are unaffected.

Until a repo has a credential, its jobs fail at clone — visibly, at job start.

**Rotation** is the same action as entering one: re-connect the repository, or
re-bind the App. The old value is replaced in place; jobs already running keep
the installation token they were minted, which expires on its own.

Two secrets belong to the deployment rather than the plugin, and live in
`docker-compose.dev-platform.yaml`:

- `DEV_RUNNER_DAEMON_TOKEN` — a **comma-separated list**, for zero-downtime
  rotation. Both ends accept every token in the list and send the first, so the
  procedure is: prepend the new token → restart → drop the old one.
- The LLM provider key the proxy forwards with.

Uninstall and purge never reach into the vault — deleting credentials is the
host's operation on the host's namespace. Remove them through your host's secret
management once the plugin is gone.

## 6. Choosing a runner backend

Backends register only when their prerequisites are configured. Everything is
**off by default** — a missing token means "not registered", never "registered
and insecure".

### Docker / compose (`kind=docker`) — the default

Selected by `DEV_PLATFORM_BACKEND` (default `docker`; only the literal `local`
selects otherwise). Registers when `DEV_RUNNER_DAEMON_URL` **and**
`DEV_RUNNER_DAEMON_TOKEN` are both set.

```bash
docker compose \
  -f /path/to/omadia/docker-compose.yaml \
  -f /path/to/omadia-dev-platform/docker-compose.dev-platform.yaml up -d
```

Four services, and the separation between them is the security model:

- **`dev-runner-daemon`** — the only holder of docker credentials.
- **`dev-dind`** — the nested engine; the only `privileged: true` service in the
  whole stack. Internal networks only, no host port, TLS-only (the daemon
  refuses a plaintext 2375 engine).
- **`dev-egress-proxy`** — default-deny, the only path from a job container to
  the internet. Pinned at `172.28.5.3` because job containers are created by
  dind and never see compose DNS.
- **`middleware`** — gains **no** docker socket, **no** `DOCKER_HOST` and no
  route to `dev-engine`. The compose-topology test asserts that absence; it is
  the single most important property of that file.

Set `DEV_EGRESS_BASE_ALLOWLIST` to include your package registry. Without a
registry route an auto-detected `npm ci` **hangs** against the proxy's
default-deny rather than failing cleanly.

### Fly Machines (`kind=fly`) — the hosted path

One ephemeral Machine per job. Registered only when `DEV_FLY_RUNNER_APP` is set
*and* a runner image is configured; it is additive and orthogonal to
`DEV_PLATFORM_BACKEND`.

```bash
flyctl apps create <runner-app> --org <org>
# then store a Fly deploy token SCOPED TO THAT APP in Vault
```

Two boot-time refusals, both of which log and simply skip registration:

- `DEV_FLY_RUNNER_APP` equal to this app's `FLY_APP_NAME` — refusing to
  provision runners into the middleware's own app.
- `DEV_FLY_RUNNER_APP` set but no runner image.

Missing token → `devplatform.fly_deploy_token_missing`. The token is read from
Vault per API operation, never held on the instance. Endpoint selection is
automatic: on Fly, the internal Machines API; off Fly, `api.machines.dev`.

Sizing: `DEV_FLY_REGION`, `DEV_FLY_GUEST_CPUS` (1), `DEV_FLY_GUEST_MEMORY_MB`
(1024), `DEV_FLY_MAX_CPUS` (4), `DEV_FLY_MAX_MEMORY_MB` (8192).

### Local process (`kind=local`) — development only

`DEV_PLATFORM_BACKEND=local`, plus setup fields `unsafe_local: true` **and**
`unsafe_local_uid`. Agent-written code then runs on the middleware host itself.
A missing uid is a hard activation refusal, not a warning.

## 7. Migration handoff

If you ran the Dev Platform *inside* core, migration slots 0022–0030 are already
applied and recorded in **core's** ledger. This plugin's ledger starts empty, so
without a handoff `runMigrations()` re-applies all nine.

`ctx.sql.seedLedger()` records them as applied instead — but never on core's
word. Each of the nine files carries a **witness** proving the schema object it
creates is actually present.

The case that makes this necessary is *rows present, tables absent*: a restore
from a snapshot older than the migrations, a version-skewed rollback, an
operator who dropped a table during an incident. A handoff that trusted core's
rows would activate green and 500 on every request. With witnesses the seed
declines, the migration runner applies the files, and that is the repair.

### Dry-run it against production first

`handoff-plan.json` ships in the ZIP precisely so you can see the plan against
your real database **before** the plugin is installed and before a single row is
written. Core ships the CLI (`middleware/scripts/plugin-ledger-handoff.mjs`,
epic #470 C11):

```bash
cd /path/to/omadia/middleware
npm run build                      # the CLI imports from dist/

DATABASE_URL=postgres://…/omadia \
node scripts/plugin-ledger-handoff.mjs \
  --plan /path/to/omadia-dev-platform/packages/plugin/handoff-plan.json
```

| Flag | Effect |
|---|---|
| `--plan <file>` | **Required.** `migrationsDir` inside it is resolved relative to the plan file, so a plan copied out of the ZIP works from wherever you put it. |
| *(none)* | **Dry run — the default.** `--apply` is the only way to write. The inverse default would be wrong for a tool whose whole value is being run against production by someone who has not read it. |
| `--apply` | Actually writes the ledger rows. |
| `--database-url <url>` | Overrides `$DATABASE_URL`. |
| `--json` | Machine-readable report. |

Exit codes: **0** plan computed (or applied) · **1** the handoff refused · **2**
usage or plan-file error.

The dry run costs one read-only transaction, and that is literally true rather
than a claim: witnesses execute inside a read-only subtransaction over
PostgreSQL's extended protocol, so a multi-statement witness is refused by the
server before it can escape the dry run, and a writing witness is refused before
it can touch the donor ledger or any bystander table.

The CLI names no plugin and no table — the plan file supplies the id, the
ledger, the migrations directory and the entries. That is core's decoupling
ratchet at work, not tidiness: no core file may name the extracted plugin.

**Reading the report.** `seeded` were adopted on proof · `applied` were left for
the migration runner · `alreadySeeded` were already in this plugin's ledger ·
**`skippedNoWitness` is the alarm** — the donor ledger records them, but their
witness says the schema object is absent. On a healthy installation it is empty
and the CLI prints `✓ no disagreement between the donor ledger and the live
catalog`. When it is not empty the CLI is explicit that this is the handoff
working, not failing: the migration runner will apply those files and that is
the repair. Confirm the database is the one you think it is before continuing.

Running the CLI is optional — installing the plugin performs the same handoff
itself. It exists so the most irreversible-looking step of the epic can be read
before it is taken.

Since 0.3.1 the manifest also declares `permissions.sql.handoff`, so a core with
`@omadia/plugin-api` 1.6.0 or newer runs this plan **before** its own migration
runner and the handoff reports real numbers. **On an older core the key is
ignored** — the pre-activate migration run gets there first, `seedLedger` can
only answer `alreadySeeded`, and `skippedNoWitness` never fires. That is exactly
when running the dry run by hand is worth it: it is the only way to see the
disagreement. See G7 in §12.

## 8. Optional capabilities and what you lose

Four capabilities are declared `optional_requires`. The plugin installs and runs
without them; each absence is logged, none is silent.

**The registry does not carry this.** The hub reads `requires`, `provides` and
`depends_on` and never `optional_requires`, so the storefront cannot show it.

| Capability | Absent means |
|---|---|
| `turnContext@1` | The three chat tools (`dev_job_start`, `dev_job_status`, `dev_job_list`) are **not registered at all**. They authorize per call against the human driving the turn; with no envelope there is nothing to authorize against. Registering tools that refuse every call is worse — the model keeps retrying and the refusals read as a bug. Use the operator UI. |
| `githubAppJwt@1` | Falls back to a local RS256 signer. Functionally equivalent; the cost is a duplicated security primitive. Core publishes no provider today. |
| `usageTelemetry@1` | No rows in the operator cost dashboard. **Per-job budgets keep enforcing** — they meter the plugin's own tables. Drops are counted and reported at deactivate. |
| `conductorRoles@1` | Repositories whose approver is a **role** open gates nobody can approve; the job waits until its deadline expires. Fail-closed, the safe direction. **Workaround: configure a named user approver.** This is the largest functional gap. |

## 9. Supply chain

The runner image is `ghcr.io/byte5ai/omadia-dev-platform-runner`, published by
`.github/workflows/release-runner-image.yml` — automatically, with no manual
step:

| Trigger | Tags |
|---|---|
| push to `main` touching a runner path | `main`, `sha-<short>` |
| push tag `v*` | `<version>`, `v<version>`, `<minor>`, `v<minor>`, `latest`, `sha-<short>` |
| manual dispatch | `edge` + `sha-<short>`, or the version you type (`dry_run` pushes nothing) |

Built for `linux/amd64`. Signing is keyless (Fulcio + Rekor) and always over the
immutable **digest**, never a tag. `sidecars/dev-runner-daemon/src/imageVerify.mjs`
verifies at daemon boot, and a `verify` job in the same workflow re-pulls the
published digest and checks it with the identical regexp — so publisher/consumer
drift fails CI rather than a daemon launch.

> A brand-new GHCR package is **private** until an org owner makes it public
> (`gh api -X PATCH /orgs/byte5ai/packages/container/omadia-dev-platform-runner -f visibility=public`).
> Until then, pulling needs `docker login ghcr.io`.

Verification accepts exactly one signer, from the two refs this workflow
publishes from. The transition pattern that also accepted core's
`publish-images.yml` was **narrowed away in 0.3.4** (see docs/SUPPLY_CHAIN.md):

```
^https://github\.com/byte5ai/omadia-dev-platform/\.github/workflows/release-runner-image\.yml@refs/(?:heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$
```

Three deliberate properties. It is **anchored at both ends** — cosign compiles
with Go RE2 and matches *unanchored*, so without `^…$` a URL like
`https://evil.example/?x=<a valid identity>` would satisfy it. It names **one
exact repo+workflow**, never "anything under `byte5ai`". And it accepts **two
refs, not every ref**: a `workflow_dispatch` from a non-main branch still builds
and pushes, but the image it signs carries `@refs/heads/<branch>` and every
daemon now refuses it — release from `main` or from a `vX.Y.Z` tag.

| Configuration | cosign flag |
|---|---|
| `DEV_IMAGE_COSIGN_IDENTITY_REGEXP` set | `--certificate-identity-regexp <yours>` — validated at boot; unanchored or uncompilable is a refusal naming the variable |
| `DEV_IMAGE_COSIGN_IDENTITY` set | `--certificate-identity <yours>` — passed through exactly; **nothing is widened** since 0.3.4 |
| Neither set | verification **skips**, with a warning |

`DEV_IMAGE_COSIGN_ISSUER` must be set in any enforcing configuration — a regexp
alone is not a pin. `DEV_IMAGE_VERIFY=off` is the only full escape hatch.

> **Upgrading past 0.3.3?** A daemon whose `DEV_IMAGE_COSIGN_IDENTITY` still
> names core's `publish-images.yml` was widened for it automatically in 0.3.2 and
> 0.3.3. From 0.3.4 it is not, and that daemon will **refuse to start** on a
> newly published image. Set `DEV_IMAGE_COSIGN_IDENTITY_REGEXP` to the pattern
> above (it takes precedence over the exact pin) and keep
> `DEV_IMAGE_COSIGN_ISSUER` set.

Verify by hand:

```bash
cosign verify \
  --certificate-identity-regexp '^https://github\.com/byte5ai/omadia-dev-platform/\.github/workflows/release-runner-image\.yml@refs/(?:heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/byte5ai/omadia-dev-platform-runner@sha256:<digest>

cosign verify-attestation --type spdxjson \
  --certificate-identity-regexp '<same>' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/byte5ai/omadia-dev-platform-runner@sha256:<digest>
```

**On Fly there is no pull hook for cosign** — the platform pulls the image
itself at deploy time. The guarantee there is digest pinning in the daemon
config plus the CI-verified signature at release. Boot-time verification still
runs everywhere the daemon can reach the registry.

The plugin ZIP deliberately ships **no runner shim**: a second copy would create
a parallel provenance path verified by nothing, since the hub checks no
signature and the ZIP carries no attestation.

**One release after the first publish from this repository**, narrow the regexp
to this repo alone — the code is written so that is a deletion, not a rewrite.

## 10. Uninstall and purge

**Uninstall never drops a table.** `close()` disposes routes, tools, nav entries
and background loops; it touches no schema, so a reinstall is lossless
(measured: ledger 9 with 0 re-applied, rows intact, routes back to 200).

What stops: routers unmount, the nav entry disappears, background workers stop,
and granted public paths stop being honoured (`/api/v1/dev-runner/...` goes
200 → 404).

What survives: all nine `dev_*` tables and every row, plus the migration ledger.

> **Grants do not survive.** Since core #824 (§4), uninstall purges
> `plugin_sql_grants` and `plugin_public_path_grants` alongside the vault, so a
> reinstall under the same id starts un-granted and **asks you again** — it does
> not inherit the previous package's database access or its unauthenticated
> surface. On a core without #824 the rows stay behind instead: orphaned rather
> than a live hole, because the runtime stops honouring them, but they are worth
> deleting by hand if the plugin is gone for good.

To actually destroy the data, call the purge route — explicit, destructive and
type-to-confirm:

```bash
curl -X POST "$BASE/api/v1/admin/dev-platform/admin/purge" \
  -H 'Content-Type: application/json' \
  -d '{"confirm":"@omadia/dev-platform"}'
```

Without the confirm phrase you get `400 devplatform.purge_not_confirmed` and the
message spelling out what would be destroyed. It drops all nine tables in one
transaction, in dependency order, without `CASCADE` — and the ledger with them,
because tables dropped while the ledger stays populated is the single worst end
state available here.

Purge does not touch the vault (§5).

## 11. Troubleshooting

**A changed ZIP had no effect.** You re-uploaded the same `id@version`. The
module was reused from Node's ESM cache. Restart the middleware, and bump the
version next time.

**`install.missing_capability` (HTTP 409).**

```
plugin requires capabilities not yet provided: <names>
```

A hard `requires:` entry has no *declared* provider. Note the sharp edge:
`details.available_providers: []` means "nobody declares providing this" — the
resolver reads manifest `provides:`, while `services.get` reads the live
registry, so a capability can exist at runtime and still fail this gate. For
this plugin only `graphPool@1` can trigger it; the other four moved to
`optional_requires` in 0.3.0.

**Activation fails naming the ledger.** The ledger must sit inside
`plg_omadia_dev_platform_` and match `permissions.sql.ledger` exactly. A grant
row with a different ledger name is not a partial grant — it is no grant. Since
core #824 the error names the admin route that fixes it, and the Grants panel
(§4.2) shows the mismatch as its own line rather than as a plain "not granted".

**The plugin reads `errored` right after install.** Most likely the Permissions
step was skipped: this plugin reaches for the database in `activate()`, so
without the SQL grant it rolls itself back. Grant it in the Grants panel (§4.2)
— the plugin is re-activated in place, and no reinstall or restart is needed.

**A grant was applied and nothing changed.** Read the response, not the absence
of an error: the route returns the state it read back from the registry after
re-activating, with `last_activation_error` populated when the plugin failed to
come back up. A 503 means no database is configured and nothing was recorded.

**Every route 404s but the plugin reports `status: "active"`.** Known core bug
(G4, §12). The install path writes `status: 'active'` before running the
`onInstalled` hook and never revises it when the hook throws. Check the
middleware log rather than the status field; the boot path is correct.

**Runner starts, then every request inside it fails with 407.** An empty
`DEV_RUNNER_DAEMON_TOKEN` — the daemon authenticates to its own egress proxy as
`Bearer undefined`. Inside a runner this presents as a total network outage. Now
a boot refusal, so check the daemon's startup log.

**`npm ci` inside a job hangs.** The egress proxy is default-deny and your
package registry is not in `DEV_EGRESS_BASE_ALLOWLIST` (default
`registry.npmjs.org`).

**The proxy answers 500 with no policy.** `llm_allowed_models` is empty. From
inside the runner this is indistinguishable from a wiring bug — set it.

**Role-approver gates can never be approved.** `conductorRoles@1` has no
provider. Configure a named user approver (§8).

**Device-flow connect returns 503.** Expected — `devplatform.device_flow_unconfigured`.
Use a GitHub App or a PAT.

## 12. Known open issues

| # | Issue | Status |
|---|---|---|
| **G4** | A failed activation still reports `status: "active"`. The install path writes the status before the `onInstalled` hook and never revises it. Makes every other verdict less trustworthy. | **Partly fixed.** Core #824 made the *re-activation* path truthful — a grant applied from §4's panel records `errored` with the reason instead of swallowing the hook's failure. The **install** path still writes `active` first, so the sharp edge remains on a fresh install. |
| **G6** | Core's `publicPaths.ts` carried two static dev-platform exemptions that collided with this plugin's declarations. This single residue caused all 33 failures of the 2026-08-21 run against `main`. | **Fixed on core `main`** — C12, core PR #807 (`e1e31f62`, 2026-08-21). Use a core at or after that commit. |
| **G7** | Core's pre-activate migration run happened **before** `activate()`, pre-empting the C11 handoff: `seedLedger` found all nine already applied and `skippedNoWitness` — the one alarm the feature exists to raise — never fired. The 2026-08-21 run measured `0 seeded, 9 already seeded` on the exact upgrade the feature was built for, and nothing went red. | **Fixed in 0.3.1** (C15, core issue byte5ai/omadia#814). `permissions.sql.handoff` declares the plan so the **kernel** runs it ahead of its own migration runner. Needs core with `@omadia/plugin-api` **1.6.0**; on anything older the key is ignored and the `activate()` fallback still runs — so on a core below 1.6.0 the gap remains, and the §7 dry run is the way to see it. |

Acceptance runs:

| Run | Against | Outcome |
|---|---|---|
| [`ACCEPTANCE-RUN-2026-08-20.md`](./ACCEPTANCE-RUN-2026-08-20.md) | 0.2.0 vs. a **patched** core | 71 PASS / 0 FAIL / 2 BLOCKED. Found G1–G6. |
| [`ACCEPTANCE-RUN-2026-08-21.md`](./ACCEPTANCE-RUN-2026-08-21.md) | 0.3.0 vs. **plain** `origin/main`, no patches | 38 / 33 / 2 on `main`; **71 / 0 / 2** with C12. All 33 failures traced to G6 alone. 1,316 tests green. |

Both reproduce with `node scripts/acceptance-local.mjs` (exit code equals the
FAIL count), driven by `BASE_URL` and `DATABASE_URL`.

## Appendix A — Older cores

**Only for a core without the consent surface** — one where
`GET /api/v1/admin/runtime/installed/@omadia%2Fdev-platform/grants` answers 404
(§4). This was the whole of §4 before core PR
[byte5ai/omadia#824](https://github.com/byte5ai/omadia/pull/824), and it is kept
because a plugin release outlives the core release it was written against.

**The SQL permission had no surface at all.** Not a UI, not an API route —
`middleware/src/platform/pluginSqlGrants.ts` says so twice in its own source:
*"`plugin_sql_grants` still has no shipped grant surface — nothing in `src/`
calls `grant()`."* The hardcoded ramp there covers four **bundled** core
plugins; `@omadia/dev-platform` is installed, not bundled, so it never was on it
and could not be. The row goes in by hand, from a client with database access:

```sql
INSERT INTO plugin_sql_grants (plugin_id, ledger, granted_by)
VALUES ('@omadia/dev-platform',
        'plg_omadia_dev_platform_migrations',
        'you@example.com');
```

**Then restart the middleware.** `ctx.services.get` is synchronous, so the grant
is read once, before the plugin's context is built — a row written afterwards
reaches a context that has already decided. Insert it *before* installing, or
restart after. This is the step #824 removed, and the reason it was worth
removing: an operator who has to schedule a restart to find out whether a
permission was needed learns to grant everything up front.

The ledger name must match `permissions.sql.ledger` character for character
(§4.3 explains why core constrains the name at all).

**The public-path grants did have a route**, and it still works unchanged on
every core, new and old:

```bash
curl -X GET "$BASE/api/v1/admin/runtime/installed/@omadia%2Fdev-platform/public-paths"

curl -X PUT "$BASE/api/v1/admin/runtime/installed/@omadia%2Fdev-platform/public-paths" \
  -H 'Content-Type: application/json' \
  -d '{"paths":["/api/v1/dev-runner","/api/webhooks/github","/api/v1/dev-platform"]}'
```

`PUT` takes the COMPLETE set — omitting a prefix revokes it.

**Uninstall leaves the grant rows behind** on these cores (§10). Delete them by
hand if the plugin is not coming back.

## See also

- [`SECRETS.md`](./SECRETS.md) — the full credential list and rotation
- [`SUPPLY_CHAIN.md`](./SUPPLY_CHAIN.md) — signing, SBOM, the narrowing step
- [`../packages/plugin/SEAMS.md`](../packages/plugin/SEAMS.md) — every core seam
  and its degradation
- [`iframe-credentials.md`](./iframe-credentials.md)
