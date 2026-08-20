/**
 * Entry point for the Dev Platform SPA (epic #470 P2).
 *
 * ORDER MATTERS HERE, and it is the only reason this file is not three lines.
 *
 * `applyAppearanceFromQuery()` runs BEFORE `createRoot`, so `data-theme` and
 * `data-palette` are on `<html>` before React renders anything and therefore
 * before the first paint. Doing it inside a `useEffect` would paint light,
 * then correct — a visible flash of the wrong appearance every time an
 * operator on a dark shell opens this page.
 *
 * It is also why there is no inline `<script>` in `index.html` doing this,
 * which is how core's proof fixture does it: `pluginUiStatic.ts` serves the
 * document under `script-src 'self'` with no `'unsafe-inline'` and no hash, so
 * a browser refuses inline script here. This module is same-origin, so it
 * runs. See `lib/appearance.ts`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { applyAppearanceFromQuery } from './lib/appearance';

const appearance = applyAppearanceFromQuery();

const container = document.getElementById('root');
if (!container) {
  // The bundle and the HTML ship in the same ZIP, so this can only happen if
  // something rewrote `index.html`. Saying so beats rendering nothing.
  throw new Error('#root missing — index.html and the bundle are out of sync');
}

createRoot(container).render(
  <StrictMode>
    <App locale={appearance.locale} />
  </StrictMode>,
);
