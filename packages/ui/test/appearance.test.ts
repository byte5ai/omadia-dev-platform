/**
 * The iframe boundary (epic #470 C8, `implementation.md` §2.3).
 *
 * `data-theme` and `data-palette` live on the SHELL's `<html>` and do not
 * cross into a framed document. If this stops working the SPA renders light
 * inside a shell the operator forced dark — a bug that looks like the
 * plugin's fault and gets reported as one.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { applyAppearance, readAppearance } from '@/lib/appearance';

describe('readAppearance', () => {
  it('reads the three params the host page sends', () => {
    const a = readAppearance('?theme=dark&palette=ember&locale=de');
    expect(a).toEqual({ theme: 'dark', palette: 'ember', locale: 'de' });
  });

  it('falls back to en for an unshipped locale rather than rendering keys', () => {
    expect(readAppearance('?locale=fr').locale).toBe('en');
    expect(readAppearance('').locale).toBe('en');
  });

  // The query string of a framed document is not trusted input just because
  // our own host page usually writes it. These values land in DOM attributes.
  it('rejects a theme outside the two valid values', () => {
    expect(readAppearance('?theme=neon').theme).toBeNull();
    expect(readAppearance('?theme=<script>').theme).toBeNull();
  });

  it('rejects a palette outside the bare-word charset', () => {
    expect(readAppearance('?palette=ember').palette).toBe('ember');
    expect(readAppearance('?palette=ember"]/**/{').palette).toBeNull();
    expect(readAppearance('?palette=Ember1').palette).toBeNull();
  });
});

describe('applyAppearance', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-palette');
  });

  it('mirrors theme and palette onto <html> so the served sheet can key off them', () => {
    applyAppearance({ theme: 'dark', palette: 'ember', locale: 'de' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-palette')).toBe('ember');
    expect(document.documentElement.getAttribute('lang')).toBe('de');
  });

  it('leaves the attributes untouched when the host sent nothing', () => {
    applyAppearance({ theme: null, palette: null, locale: 'en' });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });
});
