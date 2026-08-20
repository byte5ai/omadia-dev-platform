# `vocabulary/classes.txt` — the 690 classes this SPA is allowed to use

Every Tailwind class this bundle emits must appear in `classes.txt`, and
`scripts/check-ui-vocabulary.mjs` fails the build when one does not.

## Why a vendored list and not a lint rule

A plugin installed at runtime from another repository is never scanned by
Tailwind, so core cannot generate a class it has not been told about in
advance. It therefore pre-generates a finite, documented vocabulary and serves
it at `/bot-api/_harness/plugin-ui.css`. A class outside that set does not
error — it renders **unstyled**, silently, on the operator's screen and
nowhere else. That is the worst failure mode available, which is why it is
caught here, at build time, in the repo that produced it.

Core catches it a second time at package ingest
(`middleware/src/plugins/tailwindArbitraryValueScan.ts`), but only the
arbitrary-value shape (`w-[137px]`, `[&>tr]:border`). Ingest does **not**
reject `bg-blue-500` — that is a perfectly ordinary-looking class that simply
does not exist in the served sheet. Only a whitelist diff catches it, and only
this repo has one.

## Provenance — measured, not transcribed

`classes.txt` was extracted from the **generated artifact**, not from the
prose table. The source of truth chain is:

```
web-ui/app/_lib/theme.css            design tokens
web-ui/scripts/plugin-ui.source.css  @source inline(...) declarations, 64 of them
  └─ npm run plugin-ui:css
middleware/assets/plugin-ui/plugin-ui.css   ← extracted from THIS
```

Extracting from the compiled stylesheet rather than expanding the brace ranges
by hand removes a whole class of drift: a brace expander written here could
disagree with Tailwind's, and it would disagree silently, in the permissive
direction. The class list in `plugin-ui.css` is what the browser will actually
match.

The human-readable form of the same set is
`specs/470-dev-platform-plugin/plugin-ui-vocabulary.md` in the omadia repo.

## Regenerating after core widens the vocabulary

Widening is a **core** change: edit `web-ui/scripts/plugin-ui.source.css`,
run `npm run plugin-ui:css`, commit the regenerated artifact, update the spec.
Then, here:

```sh
node scripts/extract-vocabulary.mjs \
  ../odoo-bot/middleware/assets/plugin-ui/plugin-ui.css \
  vocabulary/classes.txt
```

and commit the diff. Do not hand-edit `classes.txt` — a class added here that
core does not serve buys nothing but a green build and an unstyled element.

## What is deliberately absent

There is no Tailwind colour palette. `bg-blue-500` does not exist and will not
be added; the colour names are the design system's semantic roles
(`bg-accent`, `text-fg-muted`, `border-border`, `text-danger`), each wired to a
runtime CSS variable so the plugin follows the operator's active palette and
light/dark mode without knowing a single hex value.

The `harness-*` helpers are present but **frozen** — they exist so an upgrade
does not restyle plugin admin UIs that already link `admin-ui.css`. New markup
should use the utilities.
