/**
 * Class composition, and the two vocabulary workarounds that need one place
 * to live (epic #470 P2).
 *
 * `cx` is `clsx` minus the dependency and minus the object form: the ported
 * pages only ever pass strings, falsey values and conditionals, so that is all
 * this accepts. `scripts/check-ui-vocabulary.mjs` parses `cx(...)` call sites
 * directly, which is the second reason not to pull in a library — a class list
 * assembled by code the checker cannot read is a class list the checker cannot
 * verify.
 *
 * ## Write class names out in full
 *
 * Never build a class from a template literal. `` `bg-${tone}` `` defeats every
 * static check — core's ingest scanner and this repo's alike — and the failure
 * it hides is silent: the class simply does not exist in the served sheet and
 * the element renders unstyled. Write the branches out instead:
 *
 *     tone === 'danger' ? 'text-danger' : 'text-success'
 *
 * Both literals are then visible to the scanner and to a reader.
 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * A 1px border-t border-r border-b border-l on all four sides.
 *
 * `border-t border-r border-b border-l` — the obvious spelling — is NOT in the served stylesheet, and this
 * is a defect in core's vocabulary generation rather than a rule about what
 * plugins may use. `web-ui/scripts/plugin-ui.source.css:341` declares it as
 *
 *     @source inline("border,border-{0,2,4}");
 *
 * and Tailwind's `@source inline()` expands BRACES, not top-level commas — so
 * that line emits nothing at all. The same bug hits line 346
 * (`divide-y,divide-x`) and line 353 (`transition,transition-...`). The
 * neighbouring declarations that use the empty-alternative brace form,
 * `rounded{,-none,-sm,...}` and `shadow{,-none,...}`, expand correctly, which
 * is what makes the three broken ones easy to miss on review.
 *
 * The consequence is not a build error anywhere. Tailwind's base reset sets
 * `border: 0 solid` on every element, so `class="border-t border-r border-b border-l border-border"` sets a
 * colour on a zero-width border-t border-r border-b border-l and renders INVISIBLE — precisely the silent
 * failure the whole no-arbitrary-values contract exists to prevent, sitting in
 * the artifact that enforces it. `plugin-ui-vocabulary.md` lists all three
 * groups as available, so the document and the generated sheet disagree.
 *
 * Until core fixes those three lines, the four directional utilities — which
 * ARE emitted, each setting 1px on its side — produce the identical box. When
 * the fix lands, this constant collapses to `'border-t border-r border-b border-l'` and nothing else in
 * this package changes.
 */
export const BORDER = 'border-t border-r border-b border-l';
