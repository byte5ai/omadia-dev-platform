# omadia/dev-runner image

Hardened per-job execution image for the dev platform (epic #470, W1 — spec §3).
Published as `ghcr.io/byte5ai/omadia-dev-platform-runner`.

Each dev job runs in a fresh container from this image. Inside it the **runner
shim** (`@omadia/dev-runner-shim`, `middleware/packages/dev-runner-shim`) clones
the target repo read-only over HTTPS, drives the headless Claude CLI, streams
runner events back to the middleware, and uploads a diff. The shim never pushes
and holds no write credential — the middleware applies the reviewed diff
server-side (W0 v2 §8).

## What is in the image

| Component | Why |
| --- | --- |
| `node:22.23.1-slim` base | same runtime as the middleware image |
| `@anthropic-ai/claude-code` (pinned) | the headless agent the shim drives |
| `git` + `ca-certificates` | HTTPS-only clone |
| `ripgrep` | the CLI's file search |
| `tini` (PID 1 / entrypoint) | reaps the CLI and git on SIGTERM |
| compiled shim at `/opt/omadia/shim` | the entrypoint program |

`CLAUDE_CODE_VERSION` is pinned in this Dockerfile to the **same** value as the
repo-root `./Dockerfile` (the middleware image). The two must be bumped
together; a drift means dev jobs run a different CLI than the rest of the stack.

## Security invariants (spec §3, acceptance criteria §11)

- Runs as **`USER 1000:1000`**, never root.
- **`tini`** is the entrypoint so the CLI and git are reaped on SIGTERM.
- **`CLAUDE_CONFIG_DIR=/tmp/claude-cli`** — the only writable path once the
  daemon mounts the rootfs read-only.
- **No `openssh-client`** — W1 clones over HTTPS only.
- **No credentials and no omadia secrets baked in.** Everything arrives
  per-job at runtime: the job token via env, the git token via the credential
  helper fetched at use time. Nothing durable lives in the image.

## Build

Build context is the **repo root** (like the middleware image), because the
shim is a workspace package under `middleware/packages/`:

```bash
docker build -f middleware/sidecars/dev-runner/Dockerfile \
  -t ghcr.io/byte5ai/omadia-dev-platform-runner:dev .
```

The shim is compiled in a builder stage (`tsc` → `dist/src/*.js`, Node builtins
only, no runtime `node_modules`) and its `dist/src` is copied to
`/opt/omadia/shim`; the entrypoint is `node /opt/omadia/shim/index.js`. The shim
source is **not** duplicated into this directory — the image builds the existing
workspace package.

## Publishing

Built and pushed by this repository's
[`.github/workflows/release-runner-image.yml`](../../.github/workflows/release-runner-image.yml)
as `ghcr.io/byte5ai/omadia-dev-platform-runner`, automatically: every
runner-relevant push to `main` publishes `:main` and `:sha-<short>`, and every
`v*` tag publishes `:<version>` and `:latest` alongside the immutable
`:sha-<short>`. It is no longer version-locked to a middleware release — the
image now ships on the cadence of the code that goes into it.

The runner daemon resolves the configured tag to a digest at warm time and
launches jobs by digest, so `latest` drift between warm and launch cannot occur.
Every published digest is keyless-signed with an SPDX SBOM attestation; see
[`docs/SUPPLY_CHAIN.md`](../../docs/SUPPLY_CHAIN.md).
