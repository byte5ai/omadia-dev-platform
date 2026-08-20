# `@omadia/dev-platform-ui` — the operator SPA

The Dev Platform's four operator screens, as a standalone Vite/React bundle.
Built into `../plugin/ui/`, shipped inside the plugin ZIP, served by core at
`/p/<pluginId>/ui/` and embedded by web-ui's `/plugin-ui/<pluginId>` page
(epic byte5ai/omadia#470, P2 against contract C8).

```sh
npm run build       # vite build -> ../plugin/ui, then the vocabulary gate
npm run typecheck
npm test            # vitest: 50 tests
npm run lint:vocabulary
```

## Why this package exists

The pages used to be `web-ui/app/admin/dev-platform/**` — compiled into core.
A plugin that lives in its own repository cannot compile pages into core's
build without becoming a hardcoded core reference, which the epic forbids. So
the UI ships as a compiled bundle inside the package and core serves it.

That trade is what every constraint below comes from.

## The four screens

| Fragment | Screen |
|---|---|
| `#/` | Hub — repos / jobs / apps / gates, tab deep-linked via `#/?tab=` |
| `#/jobs/<id>` | Job detail — phase rail, live SSE log, artifacts, gates |
| `#/repos/<id>` | Repo detail — budget, webhook, bind GitHub App |
| `#/repos/new` | Add-repo wizard — device flow, credential, checks |

Routing is by **fragment**, not path. `pluginUiStatic.ts` serves exactly two
shapes — the bundle root and a real file — so a client route in the path would
404 on reload; a fragment never reaches the server. It also avoids needing to
know the plugin id at build time, since the id comes from the install.

## What replaced what

| Core | Here | Why |
|---|---|---|
| `next-intl` | `src/lib/i18n.tsx` | No Next request context inside an iframe. 300 keys per locale, plain `{name}` interpolation, no ICU parser. The three ICU plurals were de-sugared to `{ one, other }` at extraction. |
| `next/link`, `next/navigation` | `src/lib/router.tsx` | Hash router, ~180 lines, same hook names so call sites are unchanged. |
| `@/app/_lib/api` (4,827 lines) | `src/lib/apiError.ts` | Exactly one name was imported from it: `ApiError`. |
| `framer-motion` | — | Animated `scale`/`y`, neither of which is in the vocabulary. 40 KB for two properties that cannot be expressed. |
| `lucide-react` | inline `<svg>` | One 16px chevron. |
| `Button`, `ConfirmDialog` | rewritten | Core writes every variant as an arbitrary value (`bg-[color:var(--accent)]`). Ingest rejects that shape; the vocabulary token `bg-accent` resolves to the same variable. |

`DevJobChatCard` and `devJobChatCardState` are **not** ported. That card renders
inside core's chat transcript, not in this iframe; `plan.md` §4.3 excludes the
chat surface from the compiled-SPA option (it is H3, still undecided). The one
function `JobDetailScreen` needed from it — `findGateForJob`, five lines — is in
`src/lib/gates.ts`.

## Two hard rules

**1. No CSS. Ever.** This package imports no stylesheet and Vite emits none.
`.css` is absent from the plugin-ZIP extension allowlist and from the static
router's Content-Type table, permanently — that absence is what forces every
plugin onto the one sheet core generates from its own Lume tokens. `index.html`
links `/bot-api/_harness/plugin-ui.css` and that is the whole styling channel.
Enforced in three places: `cssCodeSplit: false`, `check-ui-vocabulary.mjs`, and
an assertion in `build-zip.mjs`.

**2. Only classes in `vocabulary/classes.txt`.** 690 of them, extracted from the
generated stylesheet itself. A class outside the set does not error — it renders
**unstyled**, on the operator's screen, and nowhere else. See
`vocabulary/README.md`.

Never build a class from a template literal. `` `bg-${tone}` `` defeats every
static check here and core's alike. Write the branches out.

## No inline script in `index.html`

Core's proof fixture sets `data-theme` from an inline `<script>`. That cannot
work for a real bundle: `pluginUiStatic.ts` serves the document under
`script-src 'self'` with no `'unsafe-inline'` and no hash, so a browser refuses
it. `src/main.tsx` applies the appearance as its first statement instead —
before React mounts, so before first paint. `test/vocabulary.test.ts` asserts
the built HTML contains no inline script.

## Read this before shipping

`docs/iframe-credentials.md` in the repo root lists three defects in core that
this package cannot fix and that fail **silently**. The first one — the host
page's `sandbox` attribute omitting `allow-same-origin`, which makes every
authenticated API call cross-origin — currently prevents all four screens from
loading data in a real browser. The bundle is correct; the boundary is not.
