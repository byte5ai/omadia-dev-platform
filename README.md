# omadia-dev-platform

The **Omadia Dev Platform**, packaged as an installable plugin.

The Dev Platform runs autonomous coding jobs against a repository: it provisions
a runner, drives an LLM through an analyze/plan/implement/review pipeline, and
opens a pull request. It ships its own HTTP routes, chat tools, background
loops, database migrations and UI.

Today all of that lives inside omadia core. This repository is where it moves
to, under [epic byte5ai/omadia#470][epic].

[epic]: https://github.com/byte5ai/omadia/issues/470

## Status: P0 — scaffold

**Nothing has moved yet.** What is here is a repository that builds, tests and
cuts a real, installable, empty plugin artifact.

That order is deliberate. A repository that cannot cut its own release artifact
ends up publishing from whatever tree someone last built in — a failure this
plugin set has already lived through, when a package kept being released from a
frozen monorepo branch. So the pipeline gets proven while the payload is empty
and a mistake costs nothing.

| Phase | What arrives | Where |
|---|---|---|
| **P0** | This scaffold — repo, build, tests, ZIP, CI | ✅ here |
| **P1** | `@omadia/dev-platform-plugin-api` published | `packages/plugin-api` |
| **P2** | The SPA — 26 files ported to Vite/React | `packages/ui` |
| **P3** | The middleware tree: `src/devplatform/**`, routers, migrations, config | `packages/plugin` |
| **P4** | Runner sidecars, the protocol shim, supply chain | new |
| **P5** | Hub publish + the staging proof gate | — |

Phases **C10–C13** then delete ~49k LOC from core and hand the migrations over.
The full sequence, the capability gaps and the blocking decisions are in
`specs/470-dev-platform-plugin/` in the omadia repo.

## Layout

```
packages/
  plugin-api/    @omadia/dev-platform-plugin-api  1.0.0   types-only DevJob* contract
  plugin/        @omadia/dev-platform             0.1.0   the plugin itself
  ui/                                                     placeholder — P2
```

`packages/plugin` is what installs into an Omadia host. Its `manifest.yaml` is
the file the hub reads, and `identity.kind` is **`extension`** — see the comment
in that file for why not `integration` or `tool`.

## Building it

Node 22 (`nvm use 22.22.3`). This repo is an npm workspaces monorepo.

```bash
npm install
npm run typecheck
npm run build
npm test
npm run package -w packages/plugin   # → packages/plugin/out/omadia-dev-platform-0.1.0.zip
```

`npm run package` refuses to build if `identity.version` in `manifest.yaml` and
`version` in `package.json` disagree, or if `identity.id` and the package `name`
disagree. **The hub reads the manifest, npm reads package.json**; when the two
drift, the published artifact carries a version that maps to no commit, or an
upgrade installs a second plugin beside the first instead of replacing it. Bump
both, together.

## The sibling-checkout dependency

The plugin types itself against `@omadia/plugin-api`, which is a **private
workspace package inside omadia core**. It is on no registry. This repo links it
from a sibling checkout, exactly as the other byte5 plugin repos do:

```jsonc
// package.json (root)
"devDependencies": {
  "@omadia/plugin-api": "file:../odoo-bot/middleware/packages/plugin-api"
}
```

So the layout on disk must be:

```
~/sources/
  odoo-bot/               ← a checkout of byte5ai/omadia
  omadia-dev-platform/    ← this repo
```

Two consequences worth knowing before the first confusing error:

1. **The sibling must be built.** `middleware/packages/plugin-api/dist/` is
   gitignored in core, and `tsconfig.json` here resolves the package through its
   emitted `.d.ts`. Run `npm run build` inside
   `odoo-bot/middleware/packages/plugin-api` once. It needs only `typescript`
   and `@types/node` — no core install.
2. **The dependency is types-only.** Every import of it is `import type` and
   vanishes from the emitted JavaScript, so the shipped ZIP has no runtime
   dependency on core's package at all. `npm run package` strips
   `devDependencies` for exactly this reason: those `file:` paths describe one
   machine's directory layout and must never reach a published artifact.

CI reproduces this by checking out both repositories side by side — see
`.github/workflows/ci.yml`.

Alternatives to the `file:` sibling (a vendored `.d.ts`, or a git dependency on
a tag) were considered and are still open; the sibling checkout is the pattern
already proven in production across six byte5 plugins.

## Installing it

The artifact is a flat ZIP — `manifest.yaml`, `package.json`, `dist/` and
`LICENSE` at the archive root, no wrapping directory.

- **Via the hub:** `hub.omadia.ai` serves the registry that Omadia hosts install
  from. Publishing is a `POST` of the ZIP to `/api/publish`. Before publishing
  anything, read the current `registry/index.json` — the hub has been ahead of a
  repo's `main` before, and a higher version number is not proof of newer
  content.
- **Via direct upload:** an operator can upload the ZIP in the Omadia admin UI.

Installing this P0 release is safe and reversible: it registers no routes, no
tools and no migrations, so uninstalling leaves nothing behind.

## Open questions

**Should `@omadia/dev-platform-plugin-api` exist at all?** Two documents in the
epic disagree, and this is worth settling before anything publishes:

- `middleware/src/devplatform/devJobTypes.ts` (in core, current `main`) states in
  its header that these types should stay **core-local** and travel with the
  dev-platform tree — "deliberately NOT a new published package, which would be
  the same speculative generality the accessor was."
- `specs/470-dev-platform-plugin/implementation.md`, phase row **P0–P1**, says to
  publish `@omadia/dev-platform-plugin-api`.

The package is scaffolded here because P0 asked for it. If the core-local
reading wins, delete `packages/plugin-api` and fold the types into
`packages/plugin/src/` — cheap now, expensive after a publish.

Related: `ctx.devJobs` and two of its six types (`DevJobCreateRequest`,
`DevJobsAccessor`) were **deleted** from core, not moved — zero providers, zero
consumers, threw on every call. They are deliberately not resurrected here. See
the header of `packages/plugin-api/src/index.ts`.

Still undecided upstream, and blocking later phases:

- **H3, the chat card.** Core's chat page hardcodes `tool.name ===
  'dev_job_start'` and renders a compiled React card. An iframe per tool call is
  not acceptable; the choice is a declarative card schema or an accepted
  degradation to a plain tool row. Needed before P4.
- **G7 fallback.** If the plugin asset pipeline (C8) proves too costly, the
  fallback is an npm-published UI package that `web-ui` optionally installs.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT © 2026 byte5 GmbH
