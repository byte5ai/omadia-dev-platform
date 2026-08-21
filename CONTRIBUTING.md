# Contributing

## Setup

Node 22 (`nvm use 22.22.3`). Clone [byte5ai/omadia][omadia] as a sibling
directory named `odoo-bot`, build its plugin-api once, then install here:

```bash
# from `middleware`, NOT from `packages/plugin-api` — that directory is inside
# an npm workspace root and an install started there is hijacked to the root.
cd ../odoo-bot/middleware
npm install --no-workspaces typescript @types/node
./node_modules/.bin/tsc -p packages/plugin-api   # `npx tsc` silently installs the WRONG tsc
cd -
npm install
```

[omadia]: https://github.com/byte5ai/omadia

### Building against an unmerged core branch — `OMADIA_CORE_DIR`

The committed default in `package.json` is
`file:../odoo-bot/middleware/packages/plugin-api`, and it stays that way: it is
what CI and every normal checkout use, and it is the pattern
`omadia-byte5-plugins` has run in production for six plugins
(`implementation.md` D1). **Do not edit it** — a `file:` path pointing at a
throwaway worktree is one machine's directory layout committed to a public
repository.

Contract work happens on unmerged core branches, though, so the override is a
symlink instead:

```bash
# e.g. a worktree with #470 C6 + C7 merged
git -C ../odoo-bot worktree add /tmp/odoo-bot-470-api origin/feat/470-c6-session-auth-raw-body
git -C /tmp/odoo-bot-470-api merge origin/feat/470-c7-sql-permission-plugin-migrations
(cd /tmp/odoo-bot-470-api/middleware && npm install && npm run build)

OMADIA_CORE_DIR=/tmp/odoo-bot-470-api npm run link:core
```

`scripts/link-core.mjs` points `node_modules/@omadia/plugin-api` at that
checkout. `node_modules/` is gitignored, so nothing it writes can be committed.
It verifies the target is **built** — `tsc` resolves the package through its
emitted `dist/index.d.ts`, and a source-only checkout produces a wall of "cannot
find module" errors that say nothing about the real cause.

`OMADIA_CORE_DIR` is read by three things, all defaulting to `../odoo-bot`:

| Consumer | Uses it for |
|---|---|
| `scripts/link-core.mjs` | the `@omadia/plugin-api` symlink |
| `packages/plugin/scripts/codegen-migrations.mjs` | reading core's `.sql` originals |
| `packages/plugin/test/_helpers/coreSchema.ts` | core's base migrations, for the pg suites |

## Before opening a PR

```bash
npm run typecheck && npm run build && npm test && npm run package -w packages/plugin
```

All four must pass. CI runs exactly these.

### Running the Postgres suites

About a third of the suite needs a real database and **skips loudly** without one
(issue #572 — a skipped suite must never read as a passing one). Start the CI
recipe container and point the suites at it:

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
artifacts**, so a pg suite exercises what the ZIP contains rather than the `.sql`
they were generated from.

With a database configured the runner switches to `--test-concurrency=1`.
Several suites drive a real `DevJobWorker` claim loop, and in parallel they claim
each other's jobs and report defects that exist in neither. Serial is the fix;
the pure run stays parallel.

## Migrations

`migrations/*.js` are **generated** — do not edit them. The ZIP extension
allowlist has no `.sql` (`implementation.md` B4), so a distributed plugin
structurally cannot ship one; the codegen is D6's answer.

```bash
OMADIA_CORE_DIR=../odoo-bot npm run codegen:migrations
```

Filenames are preserved (`.sql` → `.js`) because the ledger is keyed by filename
and C11 seeds this plugin's ledger from core's donor rows by that key. The SQL
inside is byte-identical, and `test/migrationSql.test.ts` proves it against
`migrations/checksums.json` — hashing what the migration passes to
`client.query`, not the file, so an escaping bug cannot hide behind a
symmetrical un-escape in the test.

## Documentation

Four documents are operator-facing, and two of them ship to people who never see
this repository. Keep them in step:

| File | Audience | Ships in the ZIP |
|---|---|---|
| `packages/plugin/manifest.yaml` → `setup.guide` | Whoever browses the hub or runs the install wizard | **yes**, and it is the only operator text the hub renders |
| `packages/plugin/README.md` | Whoever unzips the artifact | **yes** |
| `docs/OPERATOR-GUIDE.md` | Whoever runs it in production | no — linked from both |
| `README.md` | Whoever builds or contributes | no |

Two rules that are easy to get wrong:

- **The hub strips every manifest block it does not name**, including
  `optional_requires` and *all comments*. Anything an operator must know before
  installing has to live in `identity.description`, `setup.fields` or
  `setup.guide` — see the header comment in `manifest.yaml` for the kept/stripped
  list with `omadia-hub` file:line references.
- **`setup.fields` `label` and `help` are `{ en, de }` maps.** Core normalises
  them through `manifestLocalized.normalizeLocalized` (byte5ai/omadia#602). A
  bare string is tolerated and read as English; adding a field with an
  English-only label is how the German install wizard ends up half-translated.

Changing anything an operator does — a new permission, a new required grant, a
changed default, a capability moving between `requires` and `optional_requires`
— means updating `setup.guide` in **both locales** and the operator guide in the
same PR.

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
