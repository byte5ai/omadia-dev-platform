# Three things in core that the P2 SPA cannot fix from here

The port is done and the bundle is green: it typechecks, builds, ships no CSS,
uses only vocabulary classes, and 50 tests pass. None of that proves it
**renders correctly in a browser**, and this file is the honest list of why —
three defects that live in omadia core, on the C8 branch, each of which fails
silently rather than loudly.

They are ordered by how much they hurt.

---

## 1. The sandbox makes every authenticated API call cross-origin

**Where:** `web-ui/app/plugin-ui/[pluginId]/_components/PluginUiFrame.tsx`

```tsx
sandbox="allow-scripts allow-forms allow-popups"
```

`allow-same-origin` is absent, deliberately, and the component says why:

> the bundle is third-party code and this keeps it out of the operator's
> cookies and localStorage on our origin. A plugin needing authenticated calls
> does them from its own backend router, which is where its authentication
> lives anyway.

The first half is sound. The second half does not follow. A sandbox without
`allow-same-origin` gives the document an **opaque origin**, and the plugin's
"own backend router" is still reached over HTTP from inside that document. So:

- every `fetch('/bot-api/v1/admin/dev-platform/...')` leaves with `Origin: null`
  and is a cross-origin request;
- `credentials: 'include'` cannot attach the session cookie as first-party — a
  cross-site request needs `SameSite=None; Secure` on that cookie;
- `EventSource(url, { withCredentials: true })` — the live job-event tail — has
  the same problem;
- `localStorage` throws outright in an opaque origin.

This SPA is **entirely** data-driven. Every one of its four screens opens with a
`GET`. So the current host page renders a correctly-styled, correctly-themed,
correctly-translated shell that shows an error state on all four screens.

**Why it is not visible in this repo's tests:** they stub `fetch`. A stub has no
origin. This is a property of the browser, not of the client, and only a real
browser against a real host page can show it.

**The options, honestly:**

| Option | Cost |
|---|---|
| Add `allow-same-origin` to the sandbox | One word. Gives up the isolation the comment is protecting — the bundle regains access to the operator's cookies on our origin. |
| Keep the sandbox; have core proxy the plugin's API under the frame's own path and answer with permissive CORS for `Origin: null` | Real work, and `Access-Control-Allow-Origin: null` is its own footgun. |
| Serve the bundle from a distinct origin and treat plugins as genuinely third-party | The clean answer. The biggest change. |

This is a decision about the plugin trust model, not a bug fix, and it belongs
to whoever owns C8. **It is the single thing standing between this bundle and a
working screen.**

---

## 2. The host page rejects every scoped plugin id — including this one

**Where:** `web-ui/app/plugin-ui/[pluginId]/page.tsx`

```ts
/** Mirrors the plugin-id charset gate in `manifestLoader`. */
const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
```

It does not mirror it. `manifestLoader.ts:182` is:

```ts
const PLUGIN_ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
```

The scope group is **optional but blessed**, and every `@omadia/*` plugin uses
one. This plugin's `identity.id` is `@omadia/dev-platform`. The host page's
regex has no scope alternative and no `@` or `/` in its character class, so it
calls `notFound()` on the only id this package can have.

The nav entry this PR registers is therefore correct and still lands on a 404
until the regex is fixed. `plugin.ts` percent-encodes the id so the value
survives as one path segment; the remaining half of the fix is one line in core:

```ts
const PLUGIN_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
```

Worth checking at the same time that `pluginUiStatic.ts`'s `resolvePackageRoot`
is looked up with the **decoded** id, since Express decodes `:pluginId` for you.

---

## 3. Three vocabulary declarations emit nothing, and `border` is one of them

**Where:** `web-ui/scripts/plugin-ui.source.css`, lines 341, 346, 353

```css
@source inline("border,border-{0,2,4}");                              /* 341 */
@source inline("divide-y,divide-x");                                  /* 346 */
@source inline("transition,transition-{none,all,colors,opacity,transform}"); /* 353 */
```

Tailwind's `@source inline()` expands **braces**. A top-level comma is not a
list separator, so all three declarations produce **zero** classes. Verified
against the committed artifact: `middleware/assets/plugin-ui/plugin-ui.css`
contains no `.border`, no `.divide-y`, no `.transition` rule of any kind.

The neighbouring declarations are fine because they use the empty-alternative
brace form, which is what makes this easy to miss on review:

```css
@source inline("rounded{,-none,-sm,-md,-lg,-xl,-full}");   /* works */
@source inline("shadow{,-none,-sm,-md,-lg}");              /* works */
```

**Why it is worse than a missing utility.** Tailwind's base reset is
`border: 0 solid`. So `class="border border-border"` — the single most common
pairing in the ported pages, 27 occurrences — sets a colour on a **zero-width**
border and renders **invisible**. No error, no warning, nothing in any build.
This is precisely the silent-unstyled failure that the whole
no-arbitrary-values contract exists to prevent, sitting inside the artifact
that enforces it.

`specs/470-dev-platform-plugin/plugin-ui-vocabulary.md` lists `border`,
`divide-y` and `transition` as available, so the document and the generated
sheet disagree. Anyone reading the doc will write a class that does nothing.

**The fix, in core:**

```css
@source inline("border{,-0,-2,-4}");
@source inline("divide-{y,x}");
@source inline("transition{,-none,-all,-colors,-opacity,-transform}");
```

then `npm run plugin-ui:css` and commit the regenerated artifact.

**What this package does meanwhile:** `src/lib/cx.ts` exports

```ts
export const BORDER = 'border-t border-r border-b border-l';
```

The four directional utilities **are** emitted, each setting 1px on its side, so
the rendered box is identical. When core is fixed, `BORDER` collapses to
`'border'` and nothing else changes. `test/vocabulary.test.ts` pins the current
broken reality, so regenerating `vocabulary/classes.txt` after the core fix
fails that test and prompts the collapse rather than leaving the workaround to
rot.

---

## What was verified, and what was not

| Claim | Evidence |
|---|---|
| Typechecks | `tsc --noEmit`, exit 0 |
| Builds, emits no CSS | `vite build` + `find -name '*.css'` = 0, asserted in CI and in `build-zip.mjs` |
| Uses only served classes | `scripts/check-ui-vocabulary.mjs`, exit 0, 690-class whitelist |
| Rejects a bad class | fixture tests for `w-[137px]`, `[&>tr]:…`, `bg-blue-500` |
| Four screens render from fixtures, en + de, themed | `test/screens.test.tsx`, 9 tests |
| Tests fail when the code breaks | two mutations run, both killed |
| **Renders correctly in a real browser** | **NOT VERIFIED** — blocked on #1 and #2 |

The last row is the one that matters to an operator, and it stays open until
core moves. Nothing in this repo can close it.
