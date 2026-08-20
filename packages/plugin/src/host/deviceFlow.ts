/**
 * SEAM — was `middleware/src/issues/githubOAuthProvider.ts` +
 * `middleware/src/issues/deviceFlowStore.ts`.
 *
 * `routes/devPlatformShared.ts` imports both as TYPES ONLY, to describe the
 * optional device-flow onboarding dependency:
 *
 *     provider: Pick<GitHubDeviceFlowProvider, 'requestDeviceCode' | 'pollAccessToken' | 'fetchUserLogin'>;
 *     store: DeviceFlowStore;
 *
 * Core's issue-reporting subsystem owns the concrete provider and it is not a
 * capability. The dev platform never constructed either object — `index.ts` did,
 * and passed them in through `deps.deviceFlow`. So the port keeps that INJECTION
 * POINT and declares the shapes here.
 *
 * The split is by coupling, not by size:
 *
 *   - `DeviceFlowStore` is an in-memory map with no core coupling whatsoever, so
 *     it is reimplemented in full and byte-for-byte in behaviour (including
 *     `isTooSoon`'s 0.8 slack factor, which the routes depend on). Without it
 *     the `deviceFlow` dep could never be satisfied on this side at all.
 *   - `GitHubDeviceFlowProvider` stays an INTERFACE. The concrete one holds
 *     core's OAuth client id and its own fetch policy; reimplementing it would
 *     be inventing a second GitHub OAuth client, not porting one.
 *
 * Consequence, recorded rather than hidden: device-flow onboarding is DORMANT in
 * the plugin — `activate()` passes no `deviceFlow`, so `POST /repos/:id/connect/
 * device*` answers "not configured". **PAT onboarding is unaffected and remains
 * the supported path**, and `github_app` onboarding (the recommended one) never
 * used this at all. See SEAMS.md → S5.
 */

/** GitHub's device-authorization response. Field names match core's
 *  `DeviceCodeRequest` exactly — the routes destructure them. */
export interface DeviceCodeRequest {
  /** Server-only secret half — used to poll, never sent to the browser. */
  deviceCode: string;
  /** Short code the operator types on the verification page. */
  userCode: string;
  /** Page the operator opens (https://github.com/login/device). */
  verificationUri: string;
  /** Seconds until the code expires. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

/** Outcome of one poll of the device-token endpoint. */
export type DevicePollResult =
  | { status: 'authorized'; accessToken: string; scope: string }
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'error'; error: string };

/** The scopes the dev platform's device flow asks for. */
export const GITHUB_ISSUE_SCOPES = ['public_repo'] as const;

/** Structural copy of the slice `devPlatformShared.ts` names. */
export interface GitHubDeviceFlowProvider {
  requestDeviceCode(scopes: readonly string[]): Promise<DeviceCodeRequest>;
  pollAccessToken(deviceCode: string): Promise<DevicePollResult>;
  fetchUserLogin(accessToken: string): Promise<string>;
}

export interface DeviceFlow {
  sub: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
  /** Epoch ms of the last poll — used to throttle polling server-side so our
   *  clients cannot hammer GitHub faster than the advertised interval. */
  lastPolledAt: number;
}

export interface DeviceFlowStoreOptions {
  now?: () => number;
}

/**
 * In-flight device flows, keyed by the operator's session `sub`. Holds the
 * server-only `device_code` (never sent to the browser) plus the poll interval
 * and an absolute expiry. One active flow per operator, so the map is bounded by
 * the operator count; expiry is lazy (checked on `get`), so no timers.
 */
export class DeviceFlowStore {
  private readonly entries = new Map<string, DeviceFlow>();
  private readonly now: () => number;

  constructor(opts: DeviceFlowStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  start(sub: string, deviceCode: string, intervalSec: number, expiresInSec: number): void {
    this.entries.set(sub, {
      sub,
      deviceCode,
      intervalMs: Math.max(1, intervalSec) * 1000,
      expiresAt: this.now() + expiresInSec * 1000,
      lastPolledAt: 0,
    });
  }

  /** Read a non-expired flow (deletes + returns undefined when expired). */
  get(sub: string): DeviceFlow | undefined {
    const flow = this.entries.get(sub);
    if (!flow) return undefined;
    if (this.now() > flow.expiresAt) {
      this.entries.delete(sub);
      return undefined;
    }
    return flow;
  }

  /** True when the caller is polling faster than the advertised interval. The
   *  0.8 slack is core's, and it is load-bearing: an exact comparison rejects a
   *  well-behaved client whose timer fires a millisecond early. */
  isTooSoon(sub: string): boolean {
    const flow = this.entries.get(sub);
    if (!flow) return false;
    return this.now() - flow.lastPolledAt < flow.intervalMs * 0.8;
  }

  markPolled(sub: string): void {
    const flow = this.entries.get(sub);
    if (flow) flow.lastPolledAt = this.now();
  }

  bumpInterval(sub: string, intervalSec: number): void {
    const flow = this.entries.get(sub);
    if (flow) flow.intervalMs = Math.max(1, intervalSec) * 1000;
  }

  delete(sub: string): void {
    this.entries.delete(sub);
  }

  size(): number {
    return this.entries.size;
  }
}
