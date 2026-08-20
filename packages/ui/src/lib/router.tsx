/**
 * A hash router, replacing `next/link` and `next/navigation` (epic #470 P2).
 *
 * ## Why the hash and not the path
 *
 * The bundle is served by core at `/p/<pluginId>/ui/`, and `<pluginId>` is a
 * property of the INSTALL, not of the build — the same ZIP can be installed
 * under a different id. A History-API router would have to know its own base
 * path to write URLs, and getting that wrong produces links that 404 only on
 * some installations.
 *
 * The fragment sidesteps that entirely: `#/jobs/abc` is relative to whatever
 * document URL the host page chose, no base path is involved, and no server
 * route has to exist for a client route. `pluginUiStatic.ts` serves exactly
 * two shapes — the bundle root and a real file — so a deep link written into
 * the PATH would 404 on reload. Written into the fragment it reloads fine,
 * because the fragment never reaches the server.
 *
 * It also survives the sandbox: `history.pushState` in an iframe without
 * `allow-same-origin` throws a SecurityError in some browsers, and
 * `location.hash` does not.
 *
 * ## The routes
 *
 * | Fragment | Screen |
 * |---|---|
 * | `#/` (or empty) | Hub — repos / jobs / apps / gates tabs |
 * | `#/jobs/<id>` | Job detail: phase rail, live log, artifacts |
 * | `#/repos/<id>` | Repo detail: budget, webhook, bind-app |
 * | `#/repos/new` | Add-repo wizard |
 *
 * The hub's tab lives in the query part of the fragment (`#/?tab=jobs`), which
 * is what the core page did with a real query string. Deep-linking a tab was a
 * shipped behaviour and `page.tsx` read it from `useSearchParams`; keeping the
 * shape means the ported component keeps its logic.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

export interface Route {
  /** Path part of the fragment, always starting with `/`. */
  readonly path: string;
  /** Query part of the fragment. */
  readonly query: URLSearchParams;
}

export interface RouterValue extends Route {
  push(href: string): void;
  replace(href: string): void;
  back(): void;
}

const RouterContext = createContext<RouterValue | null>(null);

/** `#/repos/abc?x=1` → `{ path: '/repos/abc', query: x=1 }`. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?', 2);
  const path = pathPart === '' ? '/' : pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return { path, query: new URLSearchParams(queryPart) };
}

/** `/repos/abc` → `#/repos/abc`. Idempotent, so a caller may pass either. */
export function toHref(target: string): string {
  if (target.startsWith('#')) return target;
  return `#${target.startsWith('/') ? target : `/${target}`}`;
}

export function RouterProvider({ children }: { children: ReactNode }): ReactElement {
  const [hash, setHash] = useState(() =>
    typeof window === 'undefined' ? '#/' : window.location.hash || '#/',
  );

  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const value = useMemo<RouterValue>(() => {
    const route = parseHash(hash);
    return {
      ...route,
      push: (href) => {
        window.location.hash = toHref(href);
      },
      replace: (href) => {
        // `replaceState` keeps a tab switch out of the back stack, which is
        // what the core page did with `router.replace`. It is guarded because
        // a sandboxed document without `allow-same-origin` can refuse it, and
        // losing one history entry is a better outcome than a thrown navigation.
        const next = toHref(href);
        try {
          window.history.replaceState(null, '', next);
          setHash(next);
        } catch {
          window.location.hash = next;
        }
      },
      back: () => window.history.back(),
    };
  }, [hash]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter used outside <RouterProvider>');
  return ctx;
}

/** The current fragment path — `useRouter().path`, named for readability. */
export function usePathname(): string {
  return useRouter().path;
}

/** Mirrors `useSearchParams()`: the query part of the fragment. */
export function useSearchParams(): URLSearchParams {
  return useRouter().query;
}

/**
 * Drop-in for `next/link`. A real `<a href="#/...">` so middle-click,
 * ctrl-click and "copy link address" keep working; the click handler exists
 * only to let a modified click fall through to the browser untouched.
 */
export function Link({
  href,
  children,
  onClick,
  ...rest
}: { href: string } & AnchorHTMLAttributes<HTMLAnchorElement>): ReactElement {
  const router = useRouter();
  const handle = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.button !== 0) return;
      event.preventDefault();
      router.push(href);
    },
    [href, onClick, router],
  );
  return (
    <a href={toHref(href)} onClick={handle} {...rest}>
      {children}
    </a>
  );
}

/**
 * Match `/jobs/:id` and `/repos/:id` against the current path.
 * Deliberately not a pattern engine: there are four routes, and a matcher
 * with more capability than that is more surface than the router it serves.
 */
export function matchRoute(path: string):
  | { kind: 'hub' }
  | { kind: 'job'; id: string }
  | { kind: 'repo'; id: string }
  | { kind: 'repo-new' }
  | { kind: 'not-found' } {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return { kind: 'hub' };
  if (segments[0] === 'jobs' && segments.length === 2) {
    return { kind: 'job', id: decodeURIComponent(segments[1] as string) };
  }
  if (segments[0] === 'repos' && segments[1] === 'new' && segments.length === 2) {
    return { kind: 'repo-new' };
  }
  if (segments[0] === 'repos' && segments.length === 2) {
    return { kind: 'repo', id: decodeURIComponent(segments[1] as string) };
  }
  return { kind: 'not-found' };
}
