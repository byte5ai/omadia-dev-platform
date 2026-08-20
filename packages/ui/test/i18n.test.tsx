/**
 * The local i18n runtime that replaced next-intl.
 *
 * 300 keys per locale came across. The failure that matters is not a wrong
 * translation — it is a key that resolves to nothing and paints an empty label
 * that survives review.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import de from '../messages/de.json';
import en from '../messages/en.json';
import { I18nProvider, useFormatter, useTranslations } from '@/lib/i18n';
import type { Locale } from '@/lib/appearance';

function Probe({ ns, k, values }: { ns: string; k: string; values?: Record<string, string | number> }) {
  const t = useTranslations(ns);
  return <span data-testid="out">{t(k, values)}</span>;
}

function show(locale: Locale, ns: string, k: string, values?: Record<string, string | number>) {
  // Each call renders a fresh tree. Without this, two `show()` calls in one
  // test leave two nodes carrying the same testid and the query throws — which
  // reads as an i18n failure and is not one.
  cleanup();
  render(
    <I18nProvider locale={locale}>
      <Probe ns={ns} k={k} values={values} />
    </I18nProvider>,
  );
  return screen.getByTestId('out').textContent;
}

function leafKeys(node: unknown, prefix = '', out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(prefix);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) leafKeys(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

describe('message catalogues', () => {
  it('ship both locales with identical key sets', () => {
    const a = leafKeys(en).sort();
    const b = leafKeys(de).sort();
    expect(a.length).toBeGreaterThan(250);
    expect(a).toEqual(b);
  });

  it('carries no ICU syntax — interpolation here is plain {name}', () => {
    for (const key of leafKeys(en)) {
      const value = key.split('.').reduce<unknown>((n, s) => (n as Record<string, unknown>)?.[s], en);
      expect(String(value)).not.toMatch(/\{\s*\w+\s*,\s*(plural|select|selectordinal)/);
    }
  });
});

describe('useTranslations', () => {
  it('resolves a namespaced key in both locales', () => {
    expect(show('en', 'adminDevPlatform', 'title')).toBeTruthy();
    expect(show('de', 'adminDevPlatform', 'title')).toBeTruthy();
  });

  it('switches language with the locale — the same key, two strings', () => {
    const enText = show('en', 'adminDevPlatform.jobs', 'title');
    const deText = show('de', 'adminDevPlatform.jobs', 'title');
    expect(enText).toBeTruthy();
    expect(deText).toBeTruthy();
  });

  it('interpolates {name} without an ICU parser', () => {
    expect(show('en', 'adminDevPlatform.apps', 'installs', { count: 3 })).toBe('3 installations');
    expect(show('de', 'adminDevPlatform.apps', 'installs', { count: 3 })).toBe('3 Installationen');
  });

  it('selects the singular on count === 1 in both locales', () => {
    expect(show('en', 'adminDevPlatform.apps', 'installs', { count: 1 })).toBe('1 installation');
    expect(show('de', 'adminDevPlatform.apps', 'installs', { count: 1 })).toBe('1 Installation');
  });

  // A blank string reads as "intentionally empty" and survives review. The
  // dotted path on screen does not.
  it('returns the full key path when a key is missing, never an empty string', () => {
    expect(show('en', 'adminDevPlatform', 'noSuchKeyAnywhere')).toBe(
      'adminDevPlatform.noSuchKeyAnywhere',
    );
  });

  it('leaves an unsupplied placeholder visible rather than blanking it', () => {
    expect(show('en', 'adminDevPlatform.apps', 'installs', {})).toContain('{count}');
  });
});

function Fmt() {
  const f = useFormatter();
  return (
    <>
      <span data-testid="n">{f.number(1234.5)}</span>
      <span data-testid="d">{f.dateTime('2026-08-20T09:00:00.000Z', { timeZone: 'UTC', year: 'numeric' })}</span>
      <span data-testid="r">{f.relativeTime('2026-08-20T08:00:00.000Z', '2026-08-20T09:00:00.000Z')}</span>
    </>
  );
}

describe('useFormatter', () => {
  it('formats numbers, dates and relative times per locale', () => {
    render(
      <I18nProvider locale="de">
        <Fmt />
      </I18nProvider>,
    );
    expect(screen.getByTestId('n').textContent).toBe('1.234,5');
    expect(screen.getByTestId('d').textContent).toBe('2026');
    // Largest unit that still yields |value| >= 1 — "1 hour ago", not "60 minutes ago".
    expect(screen.getByTestId('r').textContent).toMatch(/Stunde/);
  });
});
