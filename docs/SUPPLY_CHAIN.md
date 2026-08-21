# Supply chain — the runner image

The dev platform runs agent-written code. The image that code runs inside is the
single most security-relevant artifact this project ships, so it is signed at
release and verified before any job starts.

- **Image:** `ghcr.io/byte5ai/omadia-dev-platform-runner`
- **Published by:** [`.github/workflows/release-runner-image.yml`](../.github/workflows/release-runner-image.yml), automatically
- **Verified by:** [`sidecars/dev-runner-daemon/src/imageVerify.mjs`](../sidecars/dev-runner-daemon/src/imageVerify.mjs), at daemon boot

| Trigger | Tags |
|---|---|
| push to `main` touching `sidecars/dev-runner/**`, `sidecars/dev-runner-daemon/**`, `packages/runner-shim/**` or the workflow | `main`, `sha-<short>` |
| push tag `v*` | `<version>`, `v<version>`, `<minor>`, `v<minor>`, `latest`, `sha-<short>` |
| `workflow_dispatch` | `edge` + `sha-<short>`, or the version you type; `dry_run` builds and pushes nothing |

Built for `linux/amd64` only. The Dockerfile is arch-agnostic and would build
for arm64 under QEMU, at roughly an order of magnitude more wall-clock on the
apt layer, the global npm install and the tsc stage — charged to every merge to
`main` now that the build is automatic, for an architecture nothing consumes:
jobs are launched on x86 hosts. An arm64 consumer means a native matrix leg on
`ubuntu-24.04-arm` plus a manifest merge, not a QEMU platform.

Signing is **keyless**. There is no private key anywhere — Fulcio issues a
short-lived certificate bound to the publishing workflow's identity, Rekor logs
it, and the daemon checks that identity at verify time. The thing being signed is
always the immutable **digest**, never a tag: a signature over `:latest` says
nothing about what `:latest` points at tomorrow.

---

## The certificate identity (epic #470, decision D5)

**A keyless certificate identity is `repo + workflow + ref`.** The runner image
used to be published by omadia core and is published by this repository now, so
the identity on a newly signed image is a different string than the one deployed
daemons pinned before 0.3.2:

| | Certificate identity |
|---|---|
| **Retired** | `https://github.com/byte5ai/omadia/.github/workflows/publish-images.yml@refs/tags/vX.Y.Z` |
| **Current** | `https://github.com/byte5ai/omadia-dev-platform/.github/workflows/release-runner-image.yml@refs/(heads/main\|tags/vX.Y.Z)` |

`verifyRunnerImage` did an **exact** `--certificate-identity` match. Publishing
the first image from this repository without changing anything else would have
made every daemon with a pinned identity refuse to launch **any** job — at boot,
with no configuration change to point at. That is why the transition support
landed *before* the first publish, not after it.

**0.3.2 was that first publish, and 0.3.4 closed the window.** The core
alternative and the automatic widening of a core pin are gone.

### The default regexp

```
^https://github\.com/byte5ai/omadia-dev-platform/\.github/workflows/release-runner-image\.yml@refs/(?:heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$
```

Defined once, as `DEFAULT_IDENTITY_REGEXP` in `imageVerify.mjs`, and pinned from
both ends: the release workflow re-verifies its own freshly signed image with the
identical string, and
`sidecars/dev-runner-daemon/test/certificateIdentity.test.mjs` fails if the two
drift. A signature the consumer would reject is not a signature, and CI is the
only place to find that out before an operator's daemon refuses to boot.

Three properties are deliberate:

- **Anchored at both ends.** cosign compiles this with Go's RE2 and matches it
  **unanchored**. Without `^…$`, an identity like
  `https://evil.example/?x=<a valid identity>` satisfies it and the pin is
  decoration.
- **One repo+workflow.** Not "anything under `byte5ai`", and no longer two
  alternatives. Anyone in the org can add a workflow to a new repository; a
  pattern that accepted the org would hand every one of them authority over what
  runs a job.
- **Two refs, not every ref.** `refs/heads/main` and `refs/tags/vX.Y.Z` — the
  refs this workflow actually publishes from. Until 0.3.4 the ref arm was
  `refs/(heads|tags)/<anything>`, which meant a `workflow_dispatch` from *any*
  branch minted an accepted identity. It still builds and still pushes; the image
  it signs off a feature branch is now **refused by every daemon**. Release from
  `main` or from a version tag.

### Precedence

| Configuration | cosign flag | Why |
|---|---|---|
| `DEV_IMAGE_COSIGN_IDENTITY_REGEXP` set | `--certificate-identity-regexp <yours>` | You said exactly what you accept. Validated at boot — an unanchored or uncompilable pattern is a refusal naming the variable, not a confusing cosign error at the first verify. |
| `DEV_IMAGE_COSIGN_IDENTITY` set | `--certificate-identity <yours>` | Passed through exactly, whoever the signer is. **Nothing is widened any more.** A pin still naming core's `publish-images.yml` will fail against a newly published image — see the migration note below. |
| Neither set | *verification skips, with a warning* | Unchanged behaviour. Making `DEFAULT_IDENTITY_REGEXP` the default here would turn a documented skip into a hard boot refusal for everyone running a locally built runner image. The default for the shipped topology lives in `docker-compose.dev-platform.yaml`, where the rest of this deployment's infrastructure config already is. |

`DEV_IMAGE_VERIFY=off` disables verification entirely and is the only escape
hatch. `DEV_IMAGE_COSIGN_ISSUER` must be set in every enforcing configuration —
a regexp alone is not a pin, because it would accept a certificate from any OIDC
provider willing to mint that subject.

### ⚠️ If your daemon still pins core's identity

Between 0.3.2 and 0.3.3 a pin on either signer was widened for you and the daemon
said so, loudly, once per boot. From 0.3.4 it is not. A daemon configured with

```
DEV_IMAGE_COSIGN_IDENTITY=https://github.com/byte5ai/omadia/.github/workflows/publish-images.yml@refs/tags/vX.Y.Z
```

will **refuse to start** on an image published from this repository, with an
`ImageVerificationError` naming the image. The fix is one variable:

```
DEV_IMAGE_COSIGN_IDENTITY_REGEXP='^https://github\.com/byte5ai/omadia-dev-platform/\.github/workflows/release-runner-image\.yml@refs/(?:heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$'
DEV_IMAGE_COSIGN_ISSUER=https://token.actions.githubusercontent.com
```

(unset `DEV_IMAGE_COSIGN_IDENTITY`, or leave it — the regexp takes precedence).
This is a refusal, not a silent downgrade, and that is the intended shape: the
alternative was granting a retired publisher standing authority that nobody
re-confirmed.

The narrowing was a **deletion**, as designed:
`CORE_SIGNER_IDENTITY`, `TRANSITION_SIGNERS` and the `widened` branch are gone
from `imageVerify.mjs`, and the suite's cases asserting the old signer is
*accepted* became cases asserting it is *rejected*. Everything else — anchoring,
foreign-identity rejection, precedence, refusal on a bad signature — survived
unchanged.

---

## Verifying by hand

```bash
cosign verify \
  --certificate-identity-regexp '^https://github\.com/byte5ai/omadia-dev-platform/\.github/workflows/release-runner-image\.yml@refs/(?:heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/byte5ai/omadia-dev-platform-runner@sha256:<digest>

# The SPDX SBOM attestation over the same digest:
cosign verify-attestation --type spdxjson \
  --certificate-identity-regexp '…' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/byte5ai/omadia-dev-platform-runner@sha256:<digest>
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

## GHCR access — why the package is named after this repository

The image used to be `ghcr.io/byte5ai/omadia-dev-runner`, a package **created by
and owned by `byte5ai/omadia`**. GitHub scopes a container package to its
creating repository, so a `packages: write` token in *this* repository was
**necessary but not sufficient**: the package's own admin settings also had to
grant this repository the `write` role (Package settings → Manage Actions access
→ Add repository → role **Write**). Nobody made that grant, so the runner image
was never built — not once — and the workflow was written to be run by hand so
the permission gap would not become permanently red CI.

That traded a build nobody could run for a permission nobody would grant.

`omadia-dev-platform-runner` did not exist, and GitHub creates a container
package for the repository that first pushes it, with that repository already
holding write access. **The name makes the permission true by construction**, so
the build can be automatic — which was the requirement all along. No org-level
action is needed to publish.

One thing is still not automatic: a brand-new GHCR package is **private**
regardless of the repository's visibility. The publish job attempts

```bash
gh api -X PATCH /orgs/byte5ai/packages/container/omadia-dev-platform-runner -f visibility=public
```

with the workflow token, which is very likely not enough (org package visibility
wants an `admin:packages` credential). The attempt is advisory — it never fails
the job — and prints the same command to the run summary for an org owner to run
once. Until then, pulling and `cosign verify` need `docker login ghcr.io`.
