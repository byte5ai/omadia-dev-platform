# omadia-dev-platform

The **Omadia Dev Platform**, packaged as an installable plugin.

An agent clones one of your GitHub repositories into an isolated runner, works a
job through an analyze → plan → implement → review pipeline, and opens a pull
request. Human approval gates, a diff policy, a per-job cost budget and a
default-deny egress proxy bound what it can do at every step.

Extracted from omadia core under [epic byte5ai/omadia#470][epic]. Current
release **0.3.1**.

[epic]: https://github.com/byte5ai/omadia/issues/470

> **Operators start here:** [`docs/OPERATOR-GUIDE.md`](./docs/OPERATOR-GUIDE.md)
> — install, the two required grants, credentials, runner backends, migration
> handoff, uninstall and troubleshooting. The rest of this file is about
> building the thing.

## Why a plugin

The Dev Platform was ~49,000 lines inside core: its own routes, tables, UI,
sidecars and background workers, all coupled to a host that did not need any of
it. As a plugin it installs on demand, owns its own schema, declares the
permissions it needs, and can be removed without leaving core carrying its
weight. Core keeps the extension points; the payload lives here.

## Architecture

```mermaid
flowchart TB
    subgraph host["omadia core (host process)"]
        kernel["Plugin kernel<br/>capability resolver · route registry · vault"]
        pool[("graphPool<br/>Postgres")]
        ui_host["web-ui<br/>/plugin-ui/&lt;id&gt;"]
    end

    subgraph plugin["@omadia/dev-platform (this repo)"]
        activate["activate()<br/>seed ledger → migrate → register"]
        routes["HTTP routes<br/>admin · runner · webhooks"]
        tools["chat tools · background workers"]
        spa["operator SPA (ui/)"]
        migs["migrations/ → 9 tables"]
    end

    subgraph runners["Runner backend (one per job, ephemeral)"]
        daemon["dev-runner-daemon<br/>control plane"]
        proxy["egress proxy<br/>default-deny"]
        job["runner + shim<br/>agent-written code"]
    end

    kernel -->|"ctx.services / ctx.sql / ctx.routes"| activate
    activate --> routes & tools & migs
    migs --> pool
    kernel --> pool
    ui_host -->|"serves ui/ at /p/&lt;id&gt;/ui/"| spa

    routes -->|"provision job"| daemon
    daemon --> job
    job -->|"all egress"| proxy
    proxy -->|"LLM · git · registries"| net(["internet"])
    job -.->|"phone home: bearer token<br/>/api/v1/dev-runner"| routes
    gh(["GitHub"]) -.->|"webhook: HMAC<br/>/api/webhooks/github"| routes

    classDef c fill:#0f172a,stroke:#38bdf8,color:#e2e8f0
    classDef p fill:#0f172a,stroke:#a78bfa,color:#e2e8f0
    classDef r fill:#0f172a,stroke:#fbbf24,color:#e2e8f0
    class kernel,pool,ui_host c
    class activate,routes,tools,spa,migs p
    class daemon,proxy,job r
```

Three properties are load-bearing:

- **The middleware never holds docker credentials.** Only the runner daemon
  does, and the compose topology test asserts the middleware has no socket, no
  `DOCKER_HOST` and no route to the engine.
- **The runner reaches the internet only through the egress proxy**, which is
  default-deny.
- **No long-lived credential enters a runner.** With a GitHub App the runner
  gets a freshly minted, single-repo, read-only token that is revoked when the
  job ends.

## Layout

```
packages/
  plugin-api/    @omadia/dev-platform-plugin-api   types-only DevJob* contract
  plugin/        @omadia/dev-platform      0.3.1   the plugin itself
  ui/                                              Vite/React 19 operator SPA
  runner-shim/   @omadia/dev-runner-shim           the in-runner protocol shim
sidecars/
  dev-runner/          image that runs exactly one job
  dev-runner-daemon/   control plane + egress proxy
  dev-dind/            the one privileged service
docs/                  operator guide, secrets, supply chain, acceptance runs
```

`packages/plugin` is what installs into an Omadia host. Its `manifest.yaml` is
the file the hub reads, and `identity.kind` is **`extension`** — see the comment
in that file for why not `integration` or `tool`.

## Building it

Node 22 (`nvm use 22.22.3`). npm workspaces monorepo.

```bash
npm install
npm run typecheck
npm run build
npm test
npm run package -w packages/plugin   # → packages/plugin/out/omadia-dev-platform-0.3.1.zip
```

`npm run package` refuses to build if `identity.version` in `manifest.yaml` and
`version` in `package.json` disagree, or if `identity.id` and the package `name`
disagree. **The hub reads the manifest, npm reads package.json**; when the two
drift, the published artifact carries a version that maps to no commit, or an
upgrade installs a second plugin beside the first instead of replacing it. Bump
both, together.

The ZIP is flat — `manifest.yaml`, `package.json`, `dist/`, `migrations/`,
`ui/`, `handoff-plan.json`, `README.md` and `LICENSE` at the archive root, no
wrapping directory. `dist`, `migrations` and `ui` are **required** directories
and `handoff-plan.json` a required file: each was once omitted, and each
produced an artifact that installed cleanly and then failed at activation.

## The sibling-checkout dependency

The plugin types itself against `@omadia/plugin-api`, a **private workspace
package inside omadia core**. It is on no registry, so this repo links it from a
sibling checkout, exactly as the other byte5 plugin repos do:

```
~/sources/
  odoo-bot/               ← a checkout of byte5ai/omadia
  omadia-dev-platform/    ← this repo
```

Two consequences worth knowing before the first confusing error:

1. **The sibling must be built.** `middleware/packages/plugin-api/dist/` is
   gitignored in core, and `tsconfig.json` here resolves the package through its
   emitted `.d.ts`:

   ```bash
   cd ../odoo-bot/middleware
   npm install --no-workspaces typescript @types/node
   ./node_modules/.bin/tsc -p packages/plugin-api
   ```

   Run it from `middleware`, not from `packages/plugin-api`: that directory sits
   inside an npm **workspace root**, so an install started there is hijacked to
   the root and leaves the package's own `node_modules` empty. And invoke the
   compiler by path — a bare `npx tsc` does not fail when TypeScript is missing,
   it downloads an unrelated abandoned `tsc` package instead. Both cost a red CI
   run already.
2. **The dependency is types-only.** Every import is `import type` and vanishes
   from the emitted JavaScript, so the shipped ZIP has no runtime dependency on
   core's package. `npm run package` strips `devDependencies` for exactly this
   reason: those `file:` paths describe one machine's directory layout and must
   never reach a published artifact.

To build against an unmerged core branch, use `OMADIA_CORE_DIR` with
`npm run link:core` rather than editing the committed `file:` path — see
[CONTRIBUTING.md](./CONTRIBUTING.md). CI reproduces the layout by checking out
both repositories side by side.

## Testing

```bash
npm test
```

About a third of the suite needs a real Postgres and **skips loudly** without one
— a skipped suite must never read as a passing one:

```bash
docker run -d --name omadia-devplatform-pgtest -p 55438:5432 \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
  pgvector/pgvector:pg16

export GRAPH_PG_TEST_URL=postgres://test:test@127.0.0.1:55438/test
export OMADIA_CORE_DIR=../odoo-bot     # core's base migrations 0001-0021
npm test
```

The plugin's schema builds on core's, so the bootstrap applies core's base
migrations first and then this package's nine — from the **shipped `.js`
artifacts**, so a pg suite exercises what the ZIP contains rather than the
`.sql` they were generated from.

There is also an end-to-end acceptance harness that drives a live instance:

```bash
BASE_URL=http://localhost:3000 DATABASE_URL=… node scripts/acceptance-local.mjs
```

It is idempotent and its exit code equals the FAIL count. Recorded runs:

| Run | Against | Outcome |
|---|---|---|
| [2026-08-20](./docs/ACCEPTANCE-RUN-2026-08-20.md) | 0.2.0, patched core | 71 PASS / 0 FAIL / 2 BLOCKED |
| [2026-08-21](./docs/ACCEPTANCE-RUN-2026-08-21.md) | 0.3.0, plain `origin/main` | 38/33/2 on `main`; **71/0/2** with C12 — all 33 traced to one core residue, since merged as [#807][c12] |

[c12]: https://github.com/byte5ai/omadia/pull/807

## Installing it

- **Via the hub:** `hub.omadia.ai` serves the registry Omadia hosts install
  from. Publishing is a `POST` of the ZIP to `/api/publish`. Before publishing,
  read the live `registry/index.json` — the hub has been ahead of a repo's
  `main` before, and a higher version number is not proof of newer content.
- **Via direct upload:** upload the ZIP in the Omadia admin UI.

**Two grants are required after install** and neither is implied by installing
— the SQL permission and the public-path consents. Both are answered in the
admin UI: a **Permissions** step in the install wizard, and a **Permissions**
panel on the plugin page for changing your mind later. They take effect in
process, so no restart is involved. Details, the automation route, and the
hand-INSERT procedure for cores older than
[byte5ai/omadia#824](https://github.com/byte5ai/omadia/pull/824) are in
[Operator Guide §4](./docs/OPERATOR-GUIDE.md#4-the-two-operator-grants).

**Never re-upload a changed ZIP under the same version.** The already-`import()`ed
module is reused from Node's ESM cache and the old code keeps serving until the
middleware restarts. Bump the version instead.

## Supply chain

The runner image is `ghcr.io/byte5ai/omadia-dev-platform-runner`, published
**automatically** — on every runner-relevant push to `main` (`:main`,
`:sha-<short>`) and on every `v*` tag (`:<version>`, `:latest`) — signed keyless
over the immutable digest, and verified at daemon boot. The package is named
after this repository on purpose: GitHub creates it for the repository that
first pushes it, so publishing needs no cross-repository grant.

During the transition from core's publisher the identity regexp accepts either
signer — anchored at both ends, because cosign matches unanchored. Details and
the narrowing step: [`docs/SUPPLY_CHAIN.md`](./docs/SUPPLY_CHAIN.md).

## Documentation

| Document | For |
|---|---|
| [`docs/OPERATOR-GUIDE.md`](./docs/OPERATOR-GUIDE.md) | Installing and running it |
| [`docs/SECRETS.md`](./docs/SECRETS.md) | Every credential and how to rotate it |
| [`docs/SUPPLY_CHAIN.md`](./docs/SUPPLY_CHAIN.md) | Image signing, SBOM, verification |
| [`packages/plugin/SEAMS.md`](./packages/plugin/SEAMS.md) | Every core seam and its degradation |
| [`CHANGELOG.md`](./CHANGELOG.md) | What changed, per release |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Setup, migrations, conventions |

## Open questions

**Should `@omadia/dev-platform-plugin-api` exist at all?** Two documents in the
epic disagree, and it is worth settling before anything publishes.
`middleware/src/devplatform/devJobTypes.ts` in core states these types should
stay **core-local**; `specs/470-dev-platform-plugin/implementation.md` phase row
P0–P1 says to publish the package. It is scaffolded here because P0 asked for
it. If the core-local reading wins, fold the types into `packages/plugin/src/` —
cheap now, expensive after a publish.

Still undecided upstream:

- **H3, the chat card.** Core's chat page hardcodes `tool.name ===
  'dev_job_start'` and renders a compiled React card. The choice is a
  declarative card schema or an accepted degradation to a plain tool row.
- **G7 on older cores.** Fixed in 0.3.1 by declaring
  `permissions.sql.handoff`, which makes the kernel run the ledger handoff
  ahead of its own migration runner — but that key needs `@omadia/plugin-api`
  1.6.0. Below it the key is ignored, the pre-activate migration run still
  pre-empts the handoff, and the `skippedNoWitness` alarm never fires. On such a
  core, run the dry-run CLI by hand
  ([Operator Guide §7](./docs/OPERATOR-GUIDE.md#7-migration-handoff)).
- **Grant lifecycle.** `plugin_sql_grants` and `plugin_public_path_grants` rows
  are not revoked on uninstall. Orphaned rather than a live hole — the runtime
  stops honouring them — but the intended lifecycle is still open.

## License

MIT © 2026 byte5 GmbH
