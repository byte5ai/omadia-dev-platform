/**
 * Carrying the shell's appearance across the iframe boundary (epic #470 C8).
 *
 * An iframe is a separate document. Two things the shell takes for granted do
 * not cross into it, and both were identified in the spec before the port
 * started (`implementation.md` §2.3):
 *
 *   - `data-theme` / `data-palette` live on the SHELL's `<html>`. Without
 *     them this SPA renders light inside a shell the operator forced dark — a
 *     bug that looks like the plugin's fault and is reported as one.
 *   - `next/font` injects its faces into web-ui's document only. The
 *     generated plugin stylesheet re-binds the font variables for exactly this
 *     reason, so nothing is needed here beyond linking it.
 *
 * The host page (`web-ui/app/plugin-ui/[pluginId]/_components/PluginUiFrame.tsx`)
 * passes `?theme=&palette=&locale=` and re-keys the iframe when any of them
 * changes, so a theme flip in the shell header reloads this document with the
 * new value rather than needing a postMessage channel.
 *
 * ## Why this is a module and not an inline <script>
 *
 * Core's proof fixture does this from an inline `<script>` in `index.html`.
 * That shape does not survive contact with the real serving path:
 * `pluginUiStatic.ts` sends `Content-Security-Policy: default-src 'none';
 * script-src 'self'; …` on the HTML, and `script-src 'self'` carries neither
 * `'unsafe-inline'` nor a hash — a browser refuses the inline script. Copying
 * the fixture would have shipped a UI that renders in the wrong theme and
 * logs a CSP violation nobody reads.
 *
 * Calling this as the first statement of the entry module is the CSP-legal
 * equivalent. The module is a same-origin `<script type="module">`, so
 * `'self'` admits it, and it executes before React mounts — therefore before
 * anything paints.
 */

export type Theme = 'light' | 'dark';

/** The two-letter locales this bundle ships messages for. */
export const SUPPORTED_LOCALES = ['en', 'de'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export interface Appearance {
  readonly theme: Theme | null;
  readonly palette: string | null;
  readonly locale: Locale;
}

/**
 * Read `?theme=&palette=&locale=` with the same validation core's fixture
 * uses. Every value is checked rather than trusted: these land in DOM
 * attributes, and the query string of a framed document is not a trusted
 * input just because our own host page usually writes it.
 */
export function readAppearance(search: string): Appearance {
  const params = new URLSearchParams(search);

  const rawTheme = params.get('theme');
  const theme: Theme | null =
    rawTheme === 'light' || rawTheme === 'dark' ? rawTheme : null;

  const rawPalette = params.get('palette');
  // Palette names are bare lower-case words (`lagoon`, `ember`). Anything else
  // is not a palette this design system has, so it is dropped rather than
  // written into an attribute selector.
  const palette = rawPalette && /^[a-z]+$/.test(rawPalette) ? rawPalette : null;

  const rawLocale = params.get('locale');
  const locale = isSupportedLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  return { theme, palette, locale };
}

export function isSupportedLocale(value: unknown): value is Locale {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Mirror the appearance onto this document's `<html>`. The served stylesheet
 * keys every colour token off `[data-theme]` / `[data-palette]`, so setting
 * these two attributes is the entire integration — no colour value is ever
 * named on this side of the boundary.
 *
 * `lang` is set too: it is what a screen reader announces in, and the shell's
 * value does not cross the boundary either.
 */
export function applyAppearance(
  appearance: Appearance,
  root: HTMLElement = document.documentElement,
): void {
  if (appearance.theme) root.setAttribute('data-theme', appearance.theme);
  if (appearance.palette) root.setAttribute('data-palette', appearance.palette);
  root.setAttribute('lang', appearance.locale);
}

/** Convenience for the entry module: read the live query string and apply it. */
export function applyAppearanceFromQuery(): Appearance {
  const appearance = readAppearance(window.location.search);
  applyAppearance(appearance);
  return appearance;
}
