/**
 * SEAM — was `middleware/src/secrets/vault.ts` → `SecretVault`.
 *
 * Three units (`githubApp/appStore.ts`, `devRepoCredentials.ts`, the assembly)
 * take a `SecretVault` and address it as `vault.<op>(agentId, key, ...)`. Core's
 * concrete vault is not a capability a plugin can reach; `ctx.secrets` is, and it
 * is ALREADY scoped to the calling plugin — there is no `agentId` argument
 * because there is no way to name another plugin's namespace.
 *
 * So this file is two things:
 *   1. the structural `SecretVault` interface, copied verbatim, so the three
 *      units and their tests compile and run unchanged; and
 *   2. `secretVaultFromContext(ctx.secrets)`, the adapter `activate()` installs.
 *
 * The adapter DROPS the `agentId` argument rather than forwarding it. That is
 * the point: under core the dev platform wrote everything to the fixed namespace
 * `core:dev-platform`, and any caller that passed a different id would have
 * reached another subsystem's secrets. Under `ctx.secrets` that is structurally
 * impossible, so the argument is inert — and an adapter that silently ignored a
 * NON-dev-platform namespace would be hiding a real mistake. It throws instead.
 *
 * See SEAMS.md → S1.
 */

/** The namespace the dev platform used inside core's vault. Retained as the ONLY
 *  accepted `agentId` so a stray namespace is a loud failure, not a silent write
 *  into the plugin's own store under a name that means nothing there. */
export const DEV_PLATFORM_VAULT_NAMESPACE = 'core:dev-platform';

/** Structural copy of core's `SecretVault`. */
export interface SecretVault {
  set(agentId: string, key: string, value: string): Promise<void>;
  setMany(agentId: string, entries: Record<string, string>): Promise<void>;
  get(agentId: string, key: string): Promise<string | undefined>;
  listKeys(agentId: string): Promise<string[]>;
  purge(agentId: string): Promise<void>;
  /** Remove a single secret. No-op if the key is absent. */
  deleteKey(agentId: string, key: string): Promise<void>;
}

/** The slice of `PluginContext['secrets']` this adapter needs. Declared
 *  structurally so `@omadia/plugin-api` stays a type-only peer and the adapter is
 *  testable with a plain object. */
export interface PluginSecretsAccessor {
  get(key: string): Promise<string | undefined>;
  keys(): Promise<string[]>;
  /** Present only with `permissions.secrets.runtime_write`. The dev platform
   *  REQUIRES both: it persists GitHub App private keys and per-repo tokens at
   *  runtime, so `activate()` refuses rather than degrading to a vault that
   *  silently drops writes. */
  set?(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

/**
 * Adapt the plugin's own, already-scoped secret store to the `SecretVault`
 * shape the ported tree expects.
 *
 * `purge` is deliberately NOT implemented as a loop-and-delete: the dev platform
 * never called it, and a plugin-wide secret wipe reachable from a code path
 * nothing exercises is a footgun, not a feature. It throws.
 */
export function secretVaultFromContext(secrets: PluginSecretsAccessor): SecretVault {
  const requireWrite = (): ((key: string, value: string) => Promise<void>) => {
    const write = secrets.set;
    if (!write) {
      throw new Error(
        'devplatform.vault_readonly: this plugin needs `permissions.secrets.runtime_write` — ' +
          'it persists GitHub App private keys and per-repo clone tokens at runtime',
      );
    }
    return (key, value) => write.call(secrets, key, value);
  };
  const assertNamespace = (agentId: string): void => {
    if (agentId !== DEV_PLATFORM_VAULT_NAMESPACE) {
      throw new Error(
        `devplatform.vault_namespace: this plugin's secret store is scoped to itself; ` +
          `refusing a write addressed to '${agentId}' (expected '${DEV_PLATFORM_VAULT_NAMESPACE}')`,
      );
    }
  };
  return {
    async set(agentId, key, value) {
      assertNamespace(agentId);
      await requireWrite()(key, value);
    },
    async setMany(agentId, entries) {
      assertNamespace(agentId);
      const write = requireWrite();
      for (const [key, value] of Object.entries(entries)) await write(key, value);
    },
    async get(agentId, key) {
      assertNamespace(agentId);
      return secrets.get(key);
    },
    async listKeys(agentId) {
      assertNamespace(agentId);
      return (await secrets.keys()).sort();
    },
    async purge() {
      throw new Error('devplatform.vault_purge_unsupported: the dev platform never purges its namespace');
    },
    async deleteKey(agentId, key) {
      assertNamespace(agentId);
      if (secrets.delete) await secrets.delete(key);
    },
  };
}

/** In-memory `SecretVault`, for tests. Mirrors core's `InMemorySecretVault`. */
export class InMemorySecretVault implements SecretVault {
  private readonly store = new Map<string, Map<string, string>>();

  private ns(agentId: string): Map<string, string> {
    let ns = this.store.get(agentId);
    if (!ns) {
      ns = new Map<string, string>();
      this.store.set(agentId, ns);
    }
    return ns;
  }

  async set(agentId: string, key: string, value: string): Promise<void> {
    this.ns(agentId).set(key, value);
  }

  async setMany(agentId: string, entries: Record<string, string>): Promise<void> {
    const ns = this.ns(agentId);
    for (const [k, v] of Object.entries(entries)) ns.set(k, v);
  }

  async get(agentId: string, key: string): Promise<string | undefined> {
    return this.ns(agentId).get(key);
  }

  async listKeys(agentId: string): Promise<string[]> {
    // SORTED, like core's. Insertion order is not a contract, and three ported
    // suites assert an exact key list.
    return [...this.ns(agentId).keys()].sort();
  }

  async purge(agentId: string): Promise<void> {
    this.store.delete(agentId);
  }

  async deleteKey(agentId: string, key: string): Promise<void> {
    this.ns(agentId).delete(key);
  }
}
