# Contributing

## Setup

Node 22 (`nvm use 22.22.3`). Clone [byte5ai/omadia][omadia] as a sibling
directory named `odoo-bot`, build its plugin-api once, then install here:

```bash
cd ../odoo-bot/middleware/packages/plugin-api && npm install && npm run build
cd -                                          && npm install
```

[omadia]: https://github.com/byte5ai/omadia

## Before opening a PR

```bash
npm run typecheck && npm run build && npm test && npm run package -w packages/plugin
```

All four must pass. CI runs exactly these.

## Conventions

- **Issues and PRs in English.** Code comments too.
- **Conventional commits:** `feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
  `chore:`, `perf:`, `ci:`.
- **No `Co-Authored-By` trailer** unless the commit genuinely had a co-author.
- **TypeScript, ESM, `strict`.** No new runtime dependencies without a reason in
  the PR body — this plugin resolves everything it can through host-provided
  peers.
- **Tests assert the built artifact**, not the source, wherever the host loads
  the built artifact. `dist/plugin.js` is what ships.

## Versioning

The version lives in **two** files: `packages/plugin/package.json` and
`packages/plugin/manifest.yaml`. The hub reads the manifest. `npm run package`
aborts on drift between them, and on drift between `identity.id` and the package
name — do not work around the guard, fix the version.

## Publishing

Before publishing to the hub, read the live `registry/index.json` and check that
the version it serves descends from what you are about to push. A higher version
number is not proof of newer content; the hub has served a build that `main` did
not contain. Never blind-overwrite an existing version — download the live ZIP
and diff it first.

## Scope

This repository receives the Dev Platform extraction described in
[epic byte5ai/omadia#470][epic]. Changes that are not part of that extraction, or
not part of making this repo a working plugin, belong in the omadia repo instead.

[epic]: https://github.com/byte5ai/omadia/issues/470
