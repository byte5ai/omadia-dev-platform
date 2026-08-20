# Secrets — what the plugin stores, and what you re-enter after install

**Short version: after installing (or reinstalling) the dev platform, you
re-connect each repository's credential by hand. There is no automatic
migration, and that is deliberate.**

---

## What the plugin holds

The dev platform persists credential material into **its own vault namespace**
through `ctx.secrets` — which is why `manifest.yaml` requests
`permissions.secrets.runtime_write`, and why `activate()` refuses to start
without it rather than degrading into a state where every repository is
unconnectable.

| Secret | Written when | Used for |
|---|---|---|
| GitHub App **private key** (PEM) | you register or bind a GitHub App | minting short-lived installation tokens |
| GitHub App **client secret** | GitHub App registration | the OAuth leg of App setup |
| GitHub App **webhook secret** | GitHub App registration | HMAC-SHA256 over the raw webhook body |
| Per-repo **clone token** (PAT) | you connect a repo with a PAT credential | read-only clone inside the runner |
| Per-repo **device-flow token** | you complete the device flow for a repo | same |

Nothing here is baked into the plugin ZIP, and nothing is shared between
repositories.

---

## Why re-entry, and not a migration (epic #470, decision D4)

When the dev platform lived inside omadia core, these values sat in core's
vault under core's namespace. As a plugin it owns its own namespace, so the same
value has a different address.

Bridging that gap automatically would mean a **one-time migration hook in core**:
code whose entire purpose is to hand a departing subsystem its old secrets once.
That hook has three problems, and the third is the one that decided it:

1. It would read the operator's secrets on a code path nobody exercises again.
2. It becomes dead code the day after it runs, in a repository where nothing
   will ever prompt anyone to remove it.
3. **It moves credentials silently.** An operator would have no moment at which
   they saw which secrets went where — and the correct time to notice that a
   GitHub App private key has moved into a plugin's namespace is *while it is
   happening*, not during an incident.

Re-entry is more work, once, and it is honest. You see exactly which credentials
the plugin holds, because you are the one who put them there.

---

## What to do after installing

1. Open **Dev Platform → Repositories**.
2. For each repository, connect a credential:
   - **GitHub App (recommended).** The runner then receives a freshly minted,
     single-repository, read-only installation token that is revoked when the
     job ends. Nothing long-lived reaches the agent.
   - **PAT or device flow.** Use a token scoped to read the one repository.
3. Re-register the webhook secret if you use webhook triggers.

Until a repository has a credential, jobs against it fail to clone — visibly, at
the start of the job, not silently.

---

## Uninstall, reinstall, and purge

Uninstall does **not** drop the plugin's tables (see epic #470, decision D3), so
a reinstall keeps every job, repo, gate and artifact. Whether the *secrets*
survive depends on the host's vault, not on this plugin: the plugin writes
through `ctx.secrets` and never manages storage itself. Expect to re-connect
credentials after a reinstall, and treat it as cheap rather than surprising.

The type-to-confirm purge route
(`POST /api/v1/admin/dev-platform/admin/purge`) drops the plugin's nine tables
and its migration ledger. It does **not** reach into the vault — deleting
credentials is the host's operation, on the host's namespace, and a plugin
route that quietly removed vault entries as a side effect of a schema drop
would be doing something its name does not say. Remove them through the host's
secret management once the plugin is gone.

---

## Rotation

Rotating a GitHub App key or a repository token is the same action as entering
one: re-connect the repository, or re-bind the App. The old value is replaced in
place; jobs already running keep the installation token they were minted, which
expires on its own.

Two secrets are **not** managed here at all — they belong to the deployment, next
to the sidecars, in `docker-compose.dev-platform.yaml`:

- `DEV_RUNNER_DAEMON_TOKEN` — a comma-separated list so it can be rotated with
  zero downtime. Both ends **accept** every token in the list and **send** the
  first, so a rotation is: prepend the new token, restart, then drop the old one.
- The LLM provider key the proxy forwards with.
