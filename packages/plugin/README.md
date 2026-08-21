# @omadia/dev-platform

The Omadia Dev Platform as an installable plugin. `kind: extension`.

This README ships **inside the plugin ZIP**, so it is written for whoever
installs the artifact rather than for whoever builds it. Build and contribution
instructions live in the [repository README](../../README.md); the full runbook
is [`docs/OPERATOR-GUIDE.md`](../../docs/OPERATOR-GUIDE.md).

## What this release does

Runs autonomous coding jobs against your GitHub repositories. An agent clones a
repo into an isolated runner, works the job through an analyze → plan →
implement → review pipeline, and opens a pull request. Human approval gates, a
diff policy, a per-job cost budget and a default-deny egress proxy bound what it
can do.

It contributes an operator SPA, HTTP routes, three chat tools, background
workers, and **nine database tables it migrates itself**.

## Before you install

- **omadia core ≥ 1.5** (`@omadia/plugin-api` 1.5.0) — the newest extension
  point used here is `ctx.sql.seedLedger`, the migration handoff.
- **A Postgres-backed knowledge graph.** The job, repo, gate and artifact tables
  live in `graphPool`. With an in-memory graph the plugin **refuses to
  activate** rather than pretending to work.
- **A runner backend** — Fly Machines or local Docker.

`graphPool@1` is the only hard capability requirement. Without a declared
provider, install is refused with `install.missing_capability` (HTTP 409).

## Two operator grants are required

The manifest asks; a human has to agree. Neither is implied by installing, and
without them the plugin does not work.

1. **`permissions.sql`** — the plugin owns nine tables and migrates them itself
   into the ledger `plg_omadia_dev_platform_migrations`. It cannot reach
   omadia's tables or another plugin's.
2. **`permissions.public_paths`** — three prefixes served without a kernel
   session (each still authenticated: a per-job bearer token, a webhook HMAC,
   and a signed state token).

**Both are answered in the admin UI.** The install wizard shows a
**Permissions** step after configuration; **Grant & activate** records the
consent and activates in the same request, and **Skip** grants nothing without
losing the install. Afterwards, the plugin page has a **Permissions** panel
(`#grants`) with a toggle per grant. Applying either re-activates the plugin in
process — **no middleware restart**.

Skipping the SQL grant leaves the plugin `errored`, because it reaches for the
database in `activate()`. That is recoverable from the panel at any time; it
does not need a reinstall.

For automation, one route carries both:
`PUT /api/v1/admin/runtime/installed/@omadia%2Fdev-platform/grants` with
`{"sql":true,"public_paths":[…]}`. The older `…/public-paths` route still works
unchanged.

Exact steps, refusal codes, and the hand-INSERT procedure for cores older than
[byte5ai/omadia#824](https://github.com/byte5ai/omadia/pull/824):
[Operator Guide §4](../../docs/OPERATOR-GUIDE.md#4-the-two-operator-grants).

## Optional capabilities

Four capabilities are declared `optional_requires`: the plugin installs and runs
without them, and each absence is logged rather than silent. **The registry does
not carry optional capabilities**, so this is the only place it is written down
before install.

| Absent | You lose |
|---|---|
| `turnContext@1` | The three chat tools are not registered at all. Use the operator UI. |
| `githubAppJwt@1` | Falls back to a local RS256 signer. Functionally equivalent. |
| `usageTelemetry@1` | No cost-dashboard rows. **Per-job budgets keep enforcing.** |
| `conductorRoles@1` | Role-approver gates become unapprovable (fail-closed). Use named approvers. |

## Credentials — you enter these yourself

Nothing is migrated for you. The plugin stores GitHub App signing material,
webhook secrets and per-repo clone tokens in its **own** vault namespace, so
after installing — and after any reinstall — you connect each repository by hand
under **Dev Platform → Repositories**.

That is a deliberate choice over a one-time migration hook: the right moment to
see credentials move into a plugin's namespace is while it is happening. A
GitHub App is the recommended credential — the runner then receives a freshly
minted, single-repo, read-only token that is revoked when the job ends. See
[`docs/SECRETS.md`](../../docs/SECRETS.md).

## Upgrading from the Dev Platform inside core

If you ran this subsystem inside core, migration slots 0022–0030 are already
applied and recorded in **core's** ledger. `handoff-plan.json` ships in this ZIP
so you can dry-run the adoption against your real database before installing:

```bash
cd /path/to/omadia/middleware && npm run build
DATABASE_URL=… node scripts/plugin-ledger-handoff.mjs --plan <this-zip>/handoff-plan.json
```

Dry run is the default; `--apply` is the only way to write. Each of the nine
files is adopted only where a **witness** proves the schema object it creates is
actually present — the case that matters is rows present, tables absent.
[Operator Guide §7](../../docs/OPERATOR-GUIDE.md#7-migration-handoff).

## Uninstall

**Uninstall never drops a table.** Routes, tools, nav entries and background
loops are disposed; the nine `dev_*` tables and all rows survive, so a reinstall
is lossless. To actually destroy the data there is an explicit, type-to-confirm
purge route — see
[Operator Guide §10](../../docs/OPERATOR-GUIDE.md#10-uninstall-and-purge).

**The grants do not survive.** Uninstall purges both grant tables, so a
reinstall starts un-granted and asks again rather than inheriting the previous
package's database access. (On cores older than #824 the rows stay behind
instead — orphaned, not honoured.)

## License

MIT © 2026 byte5 GmbH
