/**
 * SEAM — was `middleware/src/services/ssrfGuard.ts`.
 *
 * `deriveJobPolicy.ts` uses exactly two of that module's four exports —
 * `isInternalHost` and `isInternalIp` — to keep an operator's egress allowlist
 * from naming a private address the runner could pivot through. Both are pure
 * string/CIDR predicates over literals; neither touches core state, config or
 * DNS. (`assertPublicHttpsUrl`, which DOES resolve DNS, is not used here and is
 * deliberately not copied.)
 *
 * Reimplemented locally rather than reached through a capability because there
 * is no `ssrfGuard` capability and a predicate over RFC 1918 ranges is not the
 * kind of thing that drifts. See SEAMS.md → S3.
 */

/** Hostnames that always resolve inside the deployment. */
const INTERNAL_HOST_SUFFIXES = ['.internal', '.local', '.localdomain'] as const;
const INTERNAL_HOST_EXACT = ['localhost', 'metadata.google.internal'] as const;

/**
 * True when `host` names something inside the deployment rather than the public
 * internet. Case-insensitive; a trailing dot (the FQDN root) is stripped first,
 * because `localhost.` and `localhost` reach the same place.
 */
export function isInternalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (h.length === 0) return true;
  if (INTERNAL_HOST_EXACT.includes(h as (typeof INTERNAL_HOST_EXACT)[number])) return true;
  if (INTERNAL_HOST_SUFFIXES.some((s) => h.endsWith(s))) return true;
  return isInternalIp(h);
}

/**
 * True when `ip` is a loopback, link-local, private, CGNAT, unique-local or
 * unspecified address. Accepts bracketed IPv6 (`[::1]`) and IPv4-mapped IPv6
 * (`::ffff:10.0.0.1`), because a guard that can be walked around by changing the
 * notation is not a guard.
 */
export function isInternalIp(ip: string): boolean {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // Strip a zone index (`fe80::1%eth0`).
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  // IPv4-mapped IPv6 — judge the embedded IPv4.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped?.[1]) s = mapped[1];

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  if (!s.includes(':')) return false; // not an IP literal at all
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // fc00::/7 unique-local
  return false;
}

/** Thrown by callers that reject a blocked target. Kept for signature parity
 *  with core's module; the ported tree constructs it nowhere today. */
export class SsrfBlockedError extends Error {
  constructor(target: string) {
    super(`ssrf_blocked: ${target}`);
    this.name = 'SsrfBlockedError';
  }
}
