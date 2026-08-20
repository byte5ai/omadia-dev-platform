/**
 * The repo→tracker resolver. Replaces `triggers/trackerRegistry.ts`, which is
 * DELETED rather than moved.
 *
 * ## Why the registry does not travel
 *
 * `dormant-capabilities.md` §3–5 works the seam through and inverts it. The
 * obvious reading — "dev-platform provides `trackerRegistry@1`, the Jira plugin
 * requires it and registers into it" — fails on four counts:
 *
 *   - it hands a MUTABLE registry through an accessor, so registering a tracker
 *     (a write that decides which tickets become code-execution jobs) is
 *     reachable by anything that can resolve the capability;
 *   - `registerTracker(kind, factory)` has no caller attribution at all — the
 *     identity IS the key the caller picks;
 *   - `services.replace()` is an exposed MITM primitive against it;
 *   - its ABI is `DevRepo`-shaped, a ~40-field internal type that lives in this
 *     repository now, paired with a return type from a core route file that C10
 *     deletes. Neither side of that signature survives where a third party can
 *     reach it.
 *
 * Inverted, the Jira/Linear plugin is the PROVIDER
 * (`provides: ["devTracker.jira@1"]`) and the dev platform is the CONSUMER,
 * resolving LATE — per repo, per sweep — through
 * `ctx.services.get('devTracker.' + repo.trackerKind)`. The object crossing the
 * seam is then a read-only, stateless service: the same risk class as
 * `graphPool@1`, which this org already ships.
 *
 * So the registry's plugin-map half becomes the `services.get` lookup below, and
 * its GitHub-fallback half folds into this resolver. Nothing is left to move.
 *
 * The capability name MUST carry the kind (`devTracker.jira@1`, never
 * `devTracker@1`), or Jira and Linear become mutually exclusive twice over —
 * `provide` throws on a duplicate name, and so does the boot provider index.
 */

import { GithubIssuesTracker, type IssuesFetch } from '../githubIssuesTracker.js';
import type { DevPlatformTracker } from '../routes/devPlatformShared.js';
import type { DevRepo } from '../types.js';

/** Capability-name prefix for a plugin-provided tracker. */
export const DEV_TRACKER_CAPABILITY_PREFIX = 'devTracker.';

/** The capability name a tracker of `kind` must be provided under. */
export function trackerCapabilityName(kind: string): string {
  return `${DEV_TRACKER_CAPABILITY_PREFIX}${kind}`;
}

/**
 * What a provider plugin registers. Deliberately NOT `DevRepo`-shaped: the
 * provider receives an opaque binding, never this repository's internal repo
 * row, so the contract does not depend on a type only this package defines.
 */
export interface DevTrackerBinding {
  readonly repoId: string;
  readonly owner: string;
  readonly name: string;
  /** `dev_repos.tracker_config` — the provider's own per-repo settings. */
  readonly config: Record<string, unknown>;
}

/** The provider-side capability contract (`devTracker.<kind>@1`). */
export interface DevTrackerProvider {
  /** Bind the provider to one repo, yielding the read surface the poller uses. */
  forRepo(binding: DevTrackerBinding): DevPlatformTracker | Promise<DevPlatformTracker>;
}

export interface TrackerResolverDeps {
  /**
   * Late capability lookup — `(name) => ctx.services.get(name)`. Called PER
   * SWEEP, not cached: a provider plugin installed after this one activated must
   * start working without a dev-platform restart, and one uninstalled must stop
   * without leaving a dangling reference to a torn-down module.
   *
   * Undefined ⇒ no capability lookup is available (the built-in path still
   * works). `ctx.services.get` throws `ServiceNotDeclaredError` for a name the
   * manifest does not declare, so the caller wraps it — a missing declaration
   * must degrade to "no tracker", never take the sweep down.
   */
  resolveCapability?: ((name: string) => unknown) | undefined;
  /** Build the built-in GitHub Issues tracker for a `github_app` repo, resolving
   *  its token. `null` when the credential cannot be resolved — the poller then
   *  treats the repo as having no tracker rather than crashing. */
  makeGithubTracker: (repo: DevRepo) => Promise<DevPlatformTracker | null>;
  log?: ((msg: string) => void) | undefined;
}

/**
 * Resolve the tracker for one repo.
 *
 * Order, unchanged from the registry it replaces:
 *   1. a plugin-provided tracker matching `repo.trackerKind` — an explicit
 *      `tracker_kind='jira'` wins even on a `github_app` clone credential;
 *   2. otherwise the built-in GitHub Issues tracker, for `github_app` repos;
 *   3. otherwise `null` — no tracker binding, and the poller skips the repo.
 */
export function createTrackerResolver(
  deps: TrackerResolverDeps,
): (repo: DevRepo) => Promise<DevPlatformTracker | null> {
  const log = deps.log ?? ((): void => {});
  return async (repo) => {
    const kind = repo.trackerKind;
    if (kind) {
      const provider = lookupProvider(deps.resolveCapability, kind, log);
      if (provider) {
        return provider.forRepo({
          repoId: repo.id,
          owner: repo.owner,
          name: repo.name,
          config: repo.trackerConfig,
        });
      }
      // An explicitly-bound kind with no installed provider is NOT silently
      // downgraded to GitHub: the operator asked for Jira, and quietly polling
      // GitHub Issues instead would create jobs from the wrong tickets.
      log(
        `[dev-platform] repo ${repo.owner}/${repo.name} declares tracker_kind='${kind}' but no ` +
          `'${trackerCapabilityName(kind)}' provider is installed — repo skipped`,
      );
      return null;
    }
    if (repo.credentialKind === 'github_app') return deps.makeGithubTracker(repo);
    return null;
  };
}

/** `ctx.services.get` throws for an undeclared name; a tracker kind nobody
 *  declared must degrade to "not installed", never abort the sweep. */
function lookupProvider(
  resolve: ((name: string) => unknown) | undefined,
  kind: string,
  log: (msg: string) => void,
): DevTrackerProvider | undefined {
  if (!resolve) return undefined;
  const name = trackerCapabilityName(kind);
  let found: unknown;
  try {
    found = resolve(name);
  } catch (err) {
    log(`[dev-platform] tracker capability '${name}' not resolvable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (!found || typeof (found as DevTrackerProvider).forRepo !== 'function') return undefined;
  return found as DevTrackerProvider;
}

/**
 * Default `makeGithubTracker` builder — the registry's built-in half, folded in
 * unchanged. Adapts the repo-bound `GithubIssuesTracker` to `DevPlatformTracker`
 * and resolves the token lazily.
 */
export function makeGithubTrackerBuilder(opts: {
  resolveToken: (repo: DevRepo) => Promise<string | undefined>;
  apiBaseUrl?: string;
  fetchImpl?: IssuesFetch;
}): (repo: DevRepo) => Promise<DevPlatformTracker | null> {
  return async (repo) => {
    const token = await opts.resolveToken(repo);
    if (!token) return null;
    const tracker = new GithubIssuesTracker({
      token,
      apiBaseUrl: opts.apiBaseUrl,
      fetchImpl: opts.fetchImpl,
    });
    const bound = { owner: repo.owner, name: repo.name };
    return {
      getTicket: (issueNumber) => tracker.getTicket(bound, issueNumber),
      listOpenTickets: (listOpts) => tracker.listOpenTickets(bound, listOpts),
    };
  };
}
