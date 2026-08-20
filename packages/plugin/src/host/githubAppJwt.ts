/**
 * SEAM — was `middleware/src/services/githubAppJwt.ts` → `mintAppJwt`.
 *
 * ## Why this file is a seam and not a copy
 *
 * `implementation.md` §5 is explicit: **`githubAppJwt` must not follow
 * dev-platform out.** It was moved INTO core precisely to close the one
 * core→devplatform reverse dependency (`plugins/builder/githubAppAuth.ts`), and
 * sending it to this repository would recreate that leak in the opposite
 * direction, across a repo boundary.
 *
 * The rule §5 is protecting is about the DIRECTION OF THE DEPENDENCY, and this
 * file honours it: nothing in core imports from here, and nothing here imports
 * from core.
 *
 * ## The capability that does not exist yet
 *
 * The clean resolution is a host capability — `ctx.services.get('githubAppJwt')`
 * returning core's minter, declared as `requires: githubAppJwt@1`. **Core does
 * not publish one today** (verified against the C6+C7 contract surface: no
 * `provide('githubAppJwt', …)` anywhere in `middleware/src`).
 *
 * So the seam is written capability-first and falls back:
 *
 *   - `installAppJwtMinter(minter)` — `activate()` installs the host's minter
 *     when the capability resolves. That path needs no code change here when
 *     core ships it; only the manifest gains a `requires` entry.
 *   - otherwise the local RS256 signer below is used.
 *
 * The fallback is 20 lines of RFC 7519 over `node:crypto` — the algorithm is
 * published by GitHub, not by omadia, and there is no version skew to drift
 * against. It is still the top item in SEAMS.md → S2, because §5's instinct
 * ("a security primitive is the last thing to copy-paste") is right and the
 * capability is the correct end state.
 */

import { createSign } from 'node:crypto';

/** GitHub rejects a JWT whose lifetime exceeds 10 minutes; 9 leaves headroom. */
const JWT_TTL_SECONDS = 9 * 60;
/** Backdate to tolerate minor clock skew against GitHub. */
const CLOCK_SKEW_SECONDS = 30;

/** The host capability this seam prefers. `requires: githubAppJwt@1`. */
export interface GithubAppJwtMinter {
  /** Mint an App JWT for `appId`, signed with the App's PEM private key. */
  mintAppJwt(appId: string, privateKey: string, now?: () => number): string;
}

export function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

let hostMinter: GithubAppJwtMinter | undefined;

/**
 * Install the host-provided minter. Called from `activate()` when
 * `ctx.services.get('githubAppJwt')` resolves; returns a dispose handle that
 * restores the local fallback, so `deactivate()` leaves no dangling reference to
 * a torn-down host module.
 */
export function installAppJwtMinter(minter: GithubAppJwtMinter | undefined): () => void {
  const previous = hostMinter;
  hostMinter = minter;
  return () => {
    hostMinter = previous;
  };
}

/** True when a host capability is currently installed (asserted in tests). */
export function isHostAppJwtMinterInstalled(): boolean {
  return hostMinter !== undefined;
}

/**
 * Mint an App JWT. `now` is injectable so tests get deterministic `iat`/`exp`.
 *
 * @param appId GitHub's numeric App id (as text — it is `iss`).
 * @param privateKey the App's PEM private key.
 * @param now epoch ms; defaults to the wall clock.
 */
export function mintAppJwt(
  appId: string,
  privateKey: string,
  now: () => number = Date.now,
): string {
  if (hostMinter) return hostMinter.mintAppJwt(appId, privateKey, now);
  const issuedAt = Math.floor(now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: issuedAt - CLOCK_SKEW_SECONDS,
    exp: issuedAt + JWT_TTL_SECONDS,
    iss: appId,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}
