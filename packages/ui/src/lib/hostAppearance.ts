import { useEffect, useState } from 'react';

import {
  applyAppearance,
  isSupportedLocale,
  type Appearance,
  type Locale,
  type Theme,
} from './appearance';

/**
 * Live appearance updates from the host page (byte5ai/omadia#1480).
 *
 * The query string is read once, at load. Core's host page used to re-key the
 * iframe on every theme, palette or language switch, so this document started
 * over on the hub screen and the operator lost the open job, a half-filled
 * wizard and the scroll position. Core now keeps the frame mounted for a
 * bundle that announces `{ type: 'omadia:plugin-ui:ready' }` and sends each
 * change as `{ type: 'omadia:plugin-ui:appearance', theme, palette, locale }`
 * (contract: `specs/470-dev-platform-plugin/plugin-ui-vocabulary.md` in core).
 * A core without the channel ignores `ready` and keeps reloading, so this is
 * safe against an older host.
 */

export const READY_MESSAGE = 'omadia:plugin-ui:ready';
export const APPEARANCE_MESSAGE = 'omadia:plugin-ui:appearance';

/**
 * Validated exactly like `readAppearance` validates the query string: the
 * values land in DOM attributes, and a message is no more trusted than a URL.
 * A value that fails is dropped, never applied.
 */
export function readAppearanceMessage(data: unknown): Appearance | null {
  if (typeof data !== 'object' || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (msg['type'] !== APPEARANCE_MESSAGE) return null;
  const rawTheme = msg['theme'];
  const theme: Theme | null =
    rawTheme === 'light' || rawTheme === 'dark' ? rawTheme : null;
  const rawPalette = msg['palette'];
  const palette =
    typeof rawPalette === 'string' && /^[a-z]+$/.test(rawPalette) ? rawPalette : null;
  const rawLocale = msg['locale'];
  if (!isSupportedLocale(rawLocale)) return null;
  return { theme, palette, locale: rawLocale };
}

/**
 * Listen for the host's appearance messages, then announce `ready`. Only the
 * parent window on this origin is heard. Returns the unsubscribe function; a
 * document that is not framed has no host to talk to and gets a no-op.
 */
export function subscribeToHostAppearance(
  onChange: (appearance: Appearance) => void,
  win: Window = window,
): () => void {
  if (win.parent === win) return () => {};
  const origin = win.location.origin;
  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== origin || event.source !== win.parent) return;
    const appearance = readAppearanceMessage(event.data);
    if (appearance) onChange(appearance);
  };
  // Listener first: the host answers `ready` with the current value at once.
  win.addEventListener('message', onMessage);
  win.parent.postMessage({ type: READY_MESSAGE }, origin);
  return () => win.removeEventListener('message', onMessage);
}

/**
 * The active locale, following the host. Theme and palette are applied to
 * `<html>` directly — the stylesheet keys off those attributes, so no React
 * state is involved; the locale has to re-render the catalogue.
 */
export function useHostLocale(initial: Locale): Locale {
  const [locale, setLocale] = useState(initial);
  useEffect(
    () =>
      subscribeToHostAppearance((appearance) => {
        applyAppearance(appearance);
        setLocale(appearance.locale);
      }),
    [],
  );
  return locale;
}
