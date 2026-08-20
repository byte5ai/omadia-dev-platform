# Seams — everything this package used to get from core

The dev-platform tree reached outside itself in exactly **nine** places. Six were
core modules; three were private core workspace packages. None of them survive as
an import: a plugin has no module graph into its host.

Each seam below states what it was, how it is satisfied now, and — where the
answer is worse than what core had — **what that costs**. The costs are recorded
here rather than discovered later, because a capability that quietly stopped
working is the failure mode this whole extraction has to avoid.

| # | Was | Now | Cost |
|---|---|---|---|
| S1 | `secrets/vault.ts` → `SecretVault` | `secretVaultFromContext(ctx.secrets)` | none |
| S2 | `services/githubAppJwt.ts` → `mintAppJwt` | capability-first, local RS256 fallback | none functionally; a duplicated primitive |
| S3 | `services/ssrfGuard.ts` → 2 predicates | reimplemented locally | none |
| S4 | `conductor/runExecutor.ts` → `parseIsoDurationMs` | reimplemented locally | none |
| S5 | `issues/githubOAuthProvider` + `deviceFlowStore` | store reimplemented, provider left an interface | **device-flow onboarding is dormant** |
| S6 | `@omadia/usage-telemetry` | pricing copied; ledger degraded to a counted no-op | **no cost-dashboard rows**; budgets unaffected |
| S7 | `ConductorRoleStore` (via `index.ts`) | optional `conductorRoles@1`, else fail-closed | **role-principal gates unapprovable** |
| S8 | `turnContext` (via `index.ts`) | `ctx.services.get('turnContext')` | chat tools unregistered without it |
| S9 | `@omadia/orchestrator` → `TaskStore` | **not ported** — see "Deliberate non-moves" | none (zero consumers) |

---

## S1 — the vault

`githubApp/appStore.ts`, `devRepoCredentials.ts` and the assembly take a
`SecretVault` and address it as `vault.<op>(agentId, key, …)`. Core's concrete
vault is not a capability; `ctx.secrets` is, and it is **already scoped to the
calling plugin** — there is no `agentId` argument because there is no way to name
another plugin's namespace.

`host/vault.ts` keeps the interface verbatim so the three units compile
unchanged, and adapts `ctx.secrets` to it. The adapter **throws** on any
namespace other than `core:dev-platform` rather than silently accepting it. Under
core that argument selected a subsystem; here it cannot, and an adapter that
ignored a foreign namespace would hide a real mistake behind a write that looked
successful.

Requires `permissions.secrets.runtime_write` — the plugin persists GitHub App
signing material and per-repo clone tokens as an operator connects repositories.
`activate()` refuses without it rather than degrading to a vault that drops
writes.

## S2 — the GitHub App JWT minter

`implementation.md` §5 is explicit: **`githubAppJwt` must not follow dev-platform
out.** It was moved *into* core to close the one core→devplatform reverse
dependency, and sending it here would recreate that leak across a repo boundary.

The rule §5 protects is about the **direction of the dependency**, and this
package honours it: nothing in core imports from here.

The clean resolution is a capability — `ctx.services.get('githubAppJwt')`. **Core
does not publish one** (verified against the C6+C7 contract surface: no
`provide('githubAppJwt', …)` anywhere in `middleware/src`). So the seam is
written capability-first — `installAppJwtMinter()` takes the host's minter when
one appears, needing no change here — and falls back to a local RS256 signer over
`node:crypto`.

**This is the top item for a core follow-up.** The fallback is ~20 lines of RFC
7519 with no version skew to drift against, but §5's instinct is right: a
security primitive is the last thing to duplicate. Publishing `githubAppJwt@1`
from core deletes the fallback and costs one manifest line here.

## S3 — the SSRF predicates

`deriveJobPolicy.ts` uses `isInternalHost` and `isInternalIp` to stop an
operator's egress allowlist naming a private address a runner could pivot
through. Both are pure predicates over RFC 1918 / link-local / unique-local
literals — no core state, no config, no DNS. `assertPublicHttpsUrl`, which *does*
resolve DNS, is not used here and is deliberately **not** copied.

`test/hostSeams.test.ts` pins the notation-evasion cases (bracketed IPv6, zone
index, IPv4-mapped IPv6): a guard that can be walked around by changing the
notation is not a guard.

## S4 — `parseIsoDurationMs`

`pipeline/gateStore.ts` reached into the Conductor's 900-line run executor for one
pure function: parsing the ISO-8601 duration an operator writes into
`dev_repos.gate_deadline_iso`. The Conductor is not a capability a plugin can
ask for. Reimplemented, including the `null`-for-non-positive rule — a deadline of
zero is not a deadline, and returning `0` would expire every gate on its first
sweep.

## S5 — device-flow onboarding · **DORMANT**

`routes/devPlatformShared.ts` imports `GitHubDeviceFlowProvider` and
`DeviceFlowStore` as **types only**, to describe an optional dependency the dev
platform never constructed — `index.ts` built both and passed them in.

The split here is by coupling, not size. `DeviceFlowStore` has no core coupling at
all and is reimplemented in full (including `isTooSoon`'s 0.8 slack factor, which
the routes depend on). `GitHubDeviceFlowProvider` stays an **interface**: the
concrete one holds core's OAuth client id, and reimplementing it would mean
standing up a second GitHub OAuth client, not porting one.

**Cost:** `activate()` passes no `deviceFlow`, so `POST /repos/:id/connect/device*`
answers "not configured". **PAT onboarding is unaffected**, and `github_app`
onboarding — the recommended path, and the only one that yields scoped, revocable,
single-repo tokens — never used this at all.

**To close it:** implement the provider against GitHub's documented device-flow
endpoints using the `DEV_PLATFORM_GITHUB_CLIENT_ID` the config already resolves.
Roughly 80 lines, no core change.

## S6 — usage telemetry · **LEDGER DEGRADED**

The package splits cleanly and the halves get different treatment.

**Pricing — copied verbatim.** `pricing.ts` is a pure price table plus arithmetic.
It is reproduced unchanged so per-job budget enforcement computes the same dollars
it did in core.

**The ledger — a counted no-op.** `recordUsage` appends to core's `usage_events`,
feeding core's cost dashboard. A plugin has no business writing there and there is
no `usageTelemetry` capability to reach it through.

**What this does NOT cost:** the ledger is not the enforcement path. Per-job
budgets are metered from `dev_jobs` / `dev_job_usage` — this plugin's own tables,
migrated by this plugin — through `llmProxyAccounting`. Dropping the ledger write
loses a row in an operator dashboard; it does not loosen a single budget, cap or
refusal.

Both call sites already took the recorder as an injected seam with a default, so
`installUsageRecorder()` wires a host capability the moment one exists. Until
then the drops are **counted** and surfaced in the deactivate log, so the gap is
visible in operations rather than only in this file.

## S7 — role-principal gate holders · **FAIL-CLOSED**

W2 gates whose approver is a **role** resolve their live holder set against the
Conductor role store. `index.ts` built a `ConductorRoleStore(graphPool)` and
passed `resolve` in. Core publishes `conductorAwaitResolver`,
`conductorChannelBindings` and `conductorEventRouter` — but **no role store**.

`activate()` looks for `conductorRoles@1` and, absent it, leaves the assembly's own
default: an empty holder set.

**Cost, stated plainly:** a repository configured with `approver_role_key` opens
gates **nobody can approve**, and the job waits until its deadline expires. That
is the safe direction — a gate approvable by anyone would be the unsafe one — but
it is a real regression, so `activate()` logs it by name at startup rather than
letting an operator discover it when a job sits in `waiting`.

**Workaround:** configure a **user** approver instead of a role. **To close it:**
publish `conductorRoles@1` from core; this package needs no change beyond the
manifest line it already declares.

Reading the role table directly through the granted pool was considered and
rejected: it would couple this package to a core table's schema across a repo
boundary — precisely the coupling this epic exists to remove.

## S8 — the turn context

The chat dev-job tools authorize **per call** against the human driving the turn
(`turnContext.current()?.userId`); no user id means the tools refuse. That
resolution IS the authorization envelope.

`NativeToolHandler` is `(input) => Promise<string>` — no turn context — but core
publishes `turnContext` as a capability, so `ctx.services.get('turnContext')`
reaches it.

Without the capability the three tools are **not registered at all**. Registering
them would publish three tools that refuse every call, which is worse than not
offering them: the model keeps trying and the operator reads the refusals as a bug.

## S9 — the generic task store · **NOT PORTED**

See "Deliberate non-moves".

---

## Deliberate non-moves

Recorded here so a later reader does not mistake an omission for an oversight.

### `devJobTaskStore.ts` (+ its two suites)

An adapter from `dev_job` onto core's generic long-running-task seam
(`@omadia/orchestrator`'s `TaskStore`). **Verified zero production consumers** —
across `src/`, `packages/` and `test/`, the only files that reference
`DevJobTaskStore` are its own two test files.

Its counterpart contract is a private core workspace package with **no
plugin-facing capability**. Porting it would mean vendoring ~200 lines of core
contract types to serve an adapter nothing calls — exactly the speculative
generality this epic removed elsewhere.

**Re-add when** core publishes a `taskStore@1` capability *and* something
consumes it.

### `triggers/trackerRegistry.ts` (+ its suite)

**DELETED**, per `dormant-capabilities.md` #4, and replaced by
`triggers/trackerResolver.ts`. The seam is inverted: the Jira/Linear plugin
becomes the **provider** (`provides: ["devTracker.jira@1"]`) and dev-platform the
**consumer**, resolving late per repo per sweep. The registry's plugin-map half
became a `services.get` lookup; its GitHub-fallback half folded into the
resolver. Nothing was left to move.

One behaviour deliberately **changed**: a repo declaring `tracker_kind` with no
installed provider is now **skipped with a named log line** instead of silently
falling through to GitHub Issues. The operator asked for Jira; quietly polling
GitHub Issues creates jobs from the wrong tickets.

### P4 cargo — `daemonProtocol`, `goldenFixture`, `composeTopology` suites

Three suites assert against `sidecars/dev-runner-daemon`,
`packages/dev-runner-shim` and `docker-compose.dev-platform.yaml`. Those artifacts
move in **P4**; the suites move with them. `src/daemonProtocol.ts` itself IS
ported — only the cross-artifact parity test waits for its counterpart.

### Dormant-capability verdicts applied

| # | Capability | Verdict | Applied |
|---|---|---|---|
| 1 | Conductor `dev.job` step | DELETE | Already deleted in core by C5 (#554). Verified absent — nothing to carry. |
| 2 | `ctx.devJobs` | DELETE | Applied upstream in C2b. `devJobsHostService.ts` is the surviving read-side residue the chat surface uses, and ports normally. |
| 3 | Tracker polling | DEFER-AND-HARDEN | Ported; `tracker_polling_enabled` ships **off**, and turning it on logs that nothing polls. Six hardening fixes gate switch-on. |
| 4 | `TrackerRegistry` | DELETE | Not ported. Seam inverted (above). |
| 5 | Comment-back | REWRITE at P3 | Ported **unchanged and dormant**. Its transport is already a pure injection point (`postComment(target, body)`), so the prescribed rewrite reduces to a rename — and the `trackerContract.ts` it was to be rewritten *against* was never frozen in Phase A. Rewriting against a contract that does not exist would be inventing one. |
| — | `devJobConductorBridge.ts` | DELETE (plan.md §7) | Verified already deleted in core by C5 (#554); it exists in no branch this port was built from. The instruction is satisfied by absence, not by an act. |

---

## Required core capabilities — the follow-up list

Ordered by what they cost while missing.

1. **`conductorRoles@1`** — closes S7. Role-principal gates are unapprovable
   without it. The largest functional gap.
2. **`githubAppJwt@1`** — closes S2 and honours `implementation.md` §5 fully.
3. **`usageTelemetry@1`** — closes S6's ledger half. Cosmetic for enforcement,
   real for the operator's cost dashboard.
4. **`taskStore@1`** — would let S9 come back, if anything ever consumes it.
