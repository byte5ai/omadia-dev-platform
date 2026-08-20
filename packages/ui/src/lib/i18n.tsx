/**
 * The local i18n runtime that replaces `next-intl` (epic #470 P2).
 *
 * ## Why not just depend on next-intl
 *
 * This bundle has no Next.js around it. `next-intl` reads its locale from the
 * Next request context and its provider is a server component in the shell —
 * neither exists inside a plugin's iframe. Bringing the library in would mean
 * bringing a shim for the context it expects, which is more code than the
 * library replaces.
 *
 * The API surface the ported pages actually use is small enough to measure:
 * `useTranslations(ns)`, `t(key)`, `t(key, vars)`, and three formatter
 * methods. That is what this implements — nothing else, so nothing else can
 * silently diverge.
 *
 * ## ICU is deliberately absent
 *
 * Interpolation is plain `{name}` substitution. There is no ICU parser here,
 * and that is a decision rather than a shortcut: core's own `t.rich` ICU
 * handling produced a bug that reached a customer at seventeen call sites, and
 * an ICU implementation written for 300 keys would be a second, less-tested
 * one. The three ICU plurals in the source messages were de-sugared at
 * extraction into `{ one, other }` objects, which `t()` selects between on
 * `vars.count`. English and German share the same cardinal rule (`n === 1`),
 * so the selection is exact for both locales this bundle ships. A third locale
 * with a different plural rule needs this function revisited, not extended
 * quietly — hence the explicit list in `SUPPORTED_LOCALES`.
 *
 * ## A missing key is visible, not silent
 *
 * `t()` returns the full dotted path when a key is absent, exactly as
 * next-intl does. A blank string would read as "this label is intentionally
 * empty" and survive review; `adminDevPlatform.jobs.tableHeader` on screen
 * does not.
 */
import {
  createContext,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from 'react';

import de from '../../messages/de.json';
import en from '../../messages/en.json';
import { DEFAULT_LOCALE, type Locale } from './appearance';

type MessageNode = string | { one: string; other: string } | MessageTree;
interface MessageTree {
  [key: string]: MessageNode;
}

const CATALOGS: Record<Locale, MessageTree> = {
  en: en as MessageTree,
  de: de as MessageTree,
};

export type TranslateValues = Record<string, string | number>;

/** `t('key')`, `t('key', { count: 3 })`. */
export type Translator = (key: string, values?: TranslateValues) => string;

export interface Formatter {
  number(value: number, options?: Intl.NumberFormatOptions): string;
  dateTime(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string;
  relativeTime(value: Date | string | number, now?: Date | string | number): string;
}

interface I18nContextValue {
  readonly locale: Locale;
  readonly catalog: MessageTree;
  readonly formatter: Formatter;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * `MessageTree` carries an index signature, so `'one' in node` does NOT
 * narrow it away from `{ one: string; other: string }` — under that signature
 * `node.one` types as `MessageNode`, not `string`, and the plural branch
 * fails to compile. Discriminating on the VALUE type is what actually
 * separates the two shapes, and it is also the honest test: a namespace that
 * happened to contain two keys named `one` and `other` holding sub-objects is
 * a tree, not a plural.
 */
function isPlural(node: MessageNode): node is { one: string; other: string } {
  if (typeof node !== 'object') return false;
  const candidate = node as { one?: unknown; other?: unknown };
  return typeof candidate.one === 'string' && typeof candidate.other === 'string';
}

function resolve(tree: MessageTree, path: string): MessageNode | undefined {
  let node: MessageNode | undefined = tree;
  for (const segment of path.split('.')) {
    if (node === undefined || typeof node === 'string' || isPlural(node)) {
      return undefined;
    }
    node = node[segment];
  }
  return node;
}

/** `{name}` → `values.name`. An unsupplied placeholder is left verbatim so it
 *  shows up as `{login}` on screen rather than as an empty gap. */
function interpolate(template: string, values?: TranslateValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

function selectPlural(
  node: { one: string; other: string },
  values: TranslateValues | undefined,
): string {
  const count = values?.['count'];
  return typeof count === 'number' && count === 1 ? node.one : node.other;
}

function makeFormatter(locale: Locale): Formatter {
  const toDate = (v: Date | string | number): Date =>
    v instanceof Date ? v : new Date(v);

  return {
    number: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    dateTime: (value, options) =>
      new Intl.DateTimeFormat(locale, options).format(toDate(value)),
    relativeTime: (value, now) => {
      const from = toDate(value).getTime();
      const to = now === undefined ? Date.now() : toDate(now).getTime();
      const seconds = Math.round((from - to) / 1000);
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      // Largest unit that still yields |value| >= 1, so "3 hours ago" wins
      // over "180 minutes ago". Matches what next-intl's relativeTime does
      // for the one call site that uses it.
      const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
        ['year', 31_536_000],
        ['month', 2_592_000],
        ['day', 86_400],
        ['hour', 3_600],
        ['minute', 60],
        ['second', 1],
      ];
      for (const [unit, size] of UNITS) {
        if (Math.abs(seconds) >= size || unit === 'second') {
          return rtf.format(Math.trunc(seconds / size), unit);
        }
      }
      return rtf.format(seconds, 'second');
    },
  };
}

export function I18nProvider({
  locale = DEFAULT_LOCALE,
  children,
}: {
  locale?: Locale;
  children: ReactNode;
}): ReactElement {
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      catalog: CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE],
      formatter: makeFormatter(locale),
    }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Rendering untranslated is not a graceful degradation — it is a screen of
    // dotted key paths. Failing here points at the missing provider instead.
    throw new Error('useTranslations/useFormatter used outside <I18nProvider>');
  }
  return ctx;
}

/**
 * `useTranslations('adminDevPlatform.jobs')` → `t('title')`.
 *
 * The namespace is a dotted prefix, exactly as in next-intl, so every ported
 * call site keeps its original argument and its original keys.
 */
export function useTranslations(namespace: string): Translator {
  const { catalog } = useI18n();
  return useMemo<Translator>(() => {
    const scope = namespace ? resolve(catalog, namespace) : catalog;
    return (key, values) => {
      const full = namespace ? `${namespace}.${key}` : key;
      if (scope === undefined || typeof scope === 'string') return full;
      const node = resolve(scope as MessageTree, key);
      if (typeof node === 'string') return interpolate(node, values);
      if (node !== undefined && isPlural(node)) {
        return interpolate(selectPlural(node, values), values);
      }
      return full;
    };
  }, [catalog, namespace]);
}

export function useFormatter(): Formatter {
  return useI18n().formatter;
}

export function useLocale(): Locale {
  return useI18n().locale;
}
