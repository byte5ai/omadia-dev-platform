# @omadia/dev-platform

The Omadia Dev Platform as an installable plugin. `kind: extension`.

This README ships **inside the plugin ZIP**, so it is written for whoever
installs the artifact rather than for whoever builds it. Build and contribution
instructions live in the [repository README](../../README.md).

## What this release does

**Nothing yet.** Version 0.1.0 activates, logs once, and deactivates cleanly. It
contributes no routes, no chat tools, no background jobs and no database
migrations, and there is nothing to configure.

It exists so that the packaging and install path are proven before the Dev
Platform itself moves in — roughly 49,000 lines currently living in omadia core.
Installing it is safe and fully reversible: uninstalling leaves no tables, no
routes and no scheduled work behind.

## What it will do

Run autonomous coding jobs against a repository — provision a runner, drive an
LLM through an analyze → plan → implement → review pipeline, and open a pull
request — plus the admin UI, the chat tools and the webhook surfaces that go
with it.

That payload arrives in phases P2 through P4 of
[epic byte5ai/omadia#470](https://github.com/byte5ai/omadia/issues/470).

## Permissions

None declared. Two are documented as comments in `manifest.yaml` for the
releases that will need them:

- **`sql`** — gates the existing `graphPool@1` capability so the plugin can own
  its own tables and run its own migrations.
- **`public_paths`** — an operator-consented grant for the two unauthenticated
  prefixes the dev runner phones home to.

Both stay commented until the core capability that enforces them has shipped. An
unknown manifest key is silently ignored rather than rejected, so declaring them
early would produce a plugin that activates with no grant and no error.

## License

MIT © 2026 byte5 GmbH
