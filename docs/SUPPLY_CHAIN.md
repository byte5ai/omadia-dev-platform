# Supply chain — the runner image

The dev platform runs agent-written code. The image that code runs inside is the
single most security-relevant artifact this project ships, so it is signed at
release and verified before any job starts.

- **Image:** `ghcr.io/byte5ai/omadia-dev-runner`
- **Published by:** [`.github/workflows/release-runner-image.yml`](../.github/workflows/release-runner-image.yml)
- **Verified by:** [`sidecars/dev-runner-daemon/src/imageVerify.mjs`](../sidecars/dev-runner-daemon/src/imageVerify.mjs), at daemon boot

Signing is **keyless**. There is no private key anywhere — Fulcio issues a
short-lived certificate bound to the publishing workflow's identity, Rekor logs
it, and the daemon checks that identity at verify time. The thing being signed is
always the immutable **digest**, never a tag: a signature over `:latest` says
nothing about what `:latest` points at tomorrow.

---

## The transition (epic #470, decision D5)

**A keyless certificate identity is `repo + workflow + ref`.** The runner image
used to be published by omadia core and is published by this repository now, so
the identity on a newly signed image is a different string than the one deployed
daemons have pinned:

| | Certificate identity |
|---|---|
| **Old** | `https://github.com/byte5ai/omadia/.github/workflows/publish-images.yml@refs/tags/vX.Y.Z` |
| **New** | `https://github.com/byte5ai/omadia-dev-platform/.github/workflows/release-runner-image.yml@refs/tags/vX.Y.Z` |

`verifyRunnerImage` did an **exact** `--certificate-identity` match. Publishing
the first image from this repository without changing anything else would have
made every daemon with a pinned identity refuse to launch **any** job — at boot,
with no configuration change to point at. That is why this support landed
*before* the first publish, not after it.

### The default transition regexp

```
^(?:https://github\.com/byte5ai/omadia/\.github/workflows/publish-images\.yml|https://github\.com/byte5ai/omadia-dev-platform/\.github/workflows/release-runner-image\.yml)@refs/(?:heads|tags)/[A-Za-z0-9._/-]+$
```

Defined once, as `DEFAULT_TRANSITION_IDENTITY_REGEXP` in `imageVerify.mjs`, and
pinned from both ends: the release workflow re-verifies its own freshly signed
image with the identical string, and
`sidecars/dev-runner-daemon/test/certificateIdentity.test.mjs` fails if the two
drift. A signature the consumer would reject is not a signature, and CI is the
only place to find that out before an operator's daemon refuses to boot.

Two properties are deliberate:

- **Anchored at both ends.** cosign compiles this with Go's RE2 and matches it
  **unanchored**. Without `^…$`, an identity like
  `https://evil.example/?x=<a valid identity>` satisfies it and the pin is
  decoration.
- **Narrow.** Two exact repo+workflow pairs, not "anything under `byte5ai`".
  Anyone in the org can add a workflow to a new repository; a pattern that
  accepted the org would hand every one of them authority over what runs a job.

### Precedence

| Configuration | cosign flag | Why |
|---|---|---|
| `DEV_IMAGE_COSIGN_IDENTITY_REGEXP` set | `--certificate-identity-regexp <yours>` | You said exactly what you accept. Validated at boot — an unanchored or uncompilable pattern is a refusal naming the variable, not a confusing cosign error at the first verify. |
| `DEV_IMAGE_COSIGN_IDENTITY` set, and it is one of the two signers above | `--certificate-identity-regexp <transition>` | **The fix.** Your pin is widened to accept both publishers, and the daemon says so, loudly, once per boot. |
| `DEV_IMAGE_COSIGN_IDENTITY` set to anything else | `--certificate-identity <yours>` | Unchanged. Someone signing their own fork gets what they asked for; widening it would grant byte5ai's signers authority over a deployment that never asked for that. |
| Neither set | *verification skips, with a warning* | Unchanged behaviour. Making the transition regexp the default here would turn a documented skip into a hard boot refusal for everyone running a locally built runner image. The default for the shipped topology lives in `docker-compose.dev-platform.yaml`, where the rest of this deployment's infrastructure config already is. |

`DEV_IMAGE_VERIFY=off` disables verification entirely and is the only escape
hatch. `DEV_IMAGE_COSIGN_ISSUER` must be set in every enforcing configuration —
a regexp alone is not a pin, because it would accept a certificate from any OIDC
provider willing to mint that subject.

### ⚠️ The narrowing step — one release after the first publish from this repo

The transition window is open on purpose and must be closed on purpose.
**One release after the first `omadia-dev-runner` image is published from this
repository**, every deployment has had a chance to pull an image signed by the
new identity, and the old alternative stops earning its place.

To narrow, in `sidecars/dev-runner-daemon/src/imageVerify.mjs`:

1. Delete `CORE_SIGNER_IDENTITY` and its alternative from
   `DEFAULT_TRANSITION_IDENTITY_REGEXP`, leaving only `PLUGIN_SIGNER_IDENTITY`.
2. Delete the `widened` branch of `resolveCertificateIdentity` and the
   `TRANSITION_SIGNERS` constant. An old pinned identity then falls through to
   the `operator-exact` path and fails verification — correctly, and with a
   message that names the image.
3. Update the literal in `release-runner-image.yml` to match.
4. Update this table and this section.

The suite is written so that this is a **deletion**, not a rewrite: the cases in
`certificateIdentity.test.mjs` that assert the OLD signer is accepted are the
ones to remove, and every other assertion — anchoring, foreign-identity
rejection, precedence, refusal on a bad signature — survives unchanged.

Until then, a widened pin logs a warning at every boot naming
`DEV_IMAGE_COSIGN_IDENTITY_REGEXP` and this file. Silence is how a transition
becomes permanent.

---

## Verifying by hand

```bash
cosign verify \
  --certificate-identity-regexp '^https://github\.com/byte5ai/omadia-dev-platform/\.github/workflows/release-runner-image\.yml@refs/(?:heads|tags)/[A-Za-z0-9._/-]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/byte5ai/omadia-dev-runner@sha256:<digest>

# The SPDX SBOM attestation over the same digest:
cosign verify-attestation --type spdxjson \
  --certificate-identity-regexp '…' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/byte5ai/omadia-dev-runner@sha256:<digest>
```

---

## The Fly caveat

On Fly.io the platform pulls the image itself at deploy time, so the daemon has
no pull hook at which to run cosign. Pull-time verification is not possible
there, and pretending otherwise would be worse than saying so. The guarantee on
Fly is instead: the image is **digest-pinned** in the daemon's config, and that
digest carries a CI-verified keyless signature produced at release. Boot-time
`cosign verify` still runs everywhere the daemon can reach the registry.

---

## Why the plugin ZIP ships no shim

`packages/runner-shim` is **not** staged into the plugin artifact, and that is a
supply-chain decision rather than an oversight.

The shim is the code that drives an agent over a repository — by some distance
the most sensitive thing here. On every production backend (`docker`, `fly`) it
reaches the job **baked into the dev-runner image**, which is the signed,
attested, digest-pinned path this document describes. Shipping a second copy
inside the plugin ZIP would create a parallel provenance path for exactly that
code, verified by nothing: the hub checks no signature, and the plugin ZIP
carries no attestation.

The only consumer of a filesystem shim is `LocalProcessBackend`, which the
assembly builds solely when `unsafe_local` is enabled — a mode that already
demands an explicit uid acknowledgment, exists for developing the dev platform
itself, and therefore implies a workspace checkout where
`packages/runner-shim` is present anyway.

`test/packagedArtifact.test.ts` pins this: the staged ZIP must contain no shim.

---

## GHCR access — unverified, and how to verify it

`ghcr.io/byte5ai/omadia-dev-runner` was created by `byte5ai/omadia` and is owned
by it. GitHub scopes a package to its creating repository, so a `packages: write`
token in *this* repository is **necessary but not sufficient** — the package
itself must also grant this repository write access:

> Package → **Package settings** → **Manage Actions access** → **Add repository**
> → `byte5ai/omadia-dev-platform` → role **Write**

This cannot be verified without actually pushing, and it has never been pushed
from here. `release-runner-image.yml` is therefore `workflow_dispatch` + tag-push
only, never `on: push` to a branch — a permissions gap becomes one deliberate red
run that a person is looking at, not permanently red CI on every merge.

To check it cheaply, run the workflow with **`dry_run: true`**: it builds the
image and pushes nothing. To check the access itself, run it with `dry_run:
false` and no version — an `:edge` publish is the smallest real push available.
