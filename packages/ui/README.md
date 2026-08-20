# `packages/ui` — placeholder

The Vite SPA port lands in **P2**.

Twenty-six `'use client'` pages currently live in omadia core's `web-ui` under
the dev-platform routes. P2 ports them to a standalone Vite/React SPA, replaces
`next-intl` with local i18n, and constrains Tailwind to the vocabulary that core
serves to plugins.

P2 is blocked on **C8** in core: a distributed plugin cannot ship a multi-file
SPA under today's contract, which mandates single-file HTML and a `tsc`-only
build. C8 extracts the `@theme inline` bridge out of `globals.css`, generates and
serves the plugin Tailwind subset, and adds static-asset serving. C8 is also the
epic's abandonment checkpoint — if it proves too costly, the fallback is an
npm-published UI package that `web-ui` optionally installs.

Two regressions the port has to handle, already identified and easy to miss:

- `next/font` does not cross an iframe boundary — the plugin SPA renders in the
  fallback stack unless it ships its own `@font-face`.
- `data-theme` does not cross it either — the plugin UI sits in light mode inside
  a shell the operator forced dark. Fixed by a core host page passing
  `?theme=&locale=`.

See `specs/470-dev-platform-plugin/plan.md` §4.3 and §4.3a in the omadia repo.
