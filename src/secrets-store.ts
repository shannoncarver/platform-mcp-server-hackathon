// Secrets Manager wrapper with a per-cold-container cache.
//
// We cache aggressively because:
//   - Secret values rarely change (manual rotation only, in V1).
//   - Lambda cold starts already pay the latency cost; warm calls should
//     not re-fetch.
//
// The store is pluggable so tests can substitute an in-memory map.

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

export interface JwtCredentials {
  client_id: string;
  client_secret: string;
  token_endpoint: string;
  audience: string;
  scope: string;
}

export interface SecretsStore {
  loadJwtCredentials(secretArn: string): Promise<JwtCredentials>;
}

const cache = new Map<string, { value: JwtCredentials; fetchedAtMs: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — half the JWT TTL

let smClient: SecretsManagerClient | undefined;
function getClient(): SecretsManagerClient {
  if (smClient === undefined) {
    smClient = new SecretsManagerClient({});
  }
  return smClient;
}

export const secretsManagerStore: SecretsStore = {
  async loadJwtCredentials(secretArn: string): Promise<JwtCredentials> {
    const nowMs = Date.now();
    const cached = cache.get(secretArn);
    if (cached !== undefined && nowMs - cached.fetchedAtMs < CACHE_TTL_MS) {
      return cached.value;
    }

    const result = await getClient().send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (result.SecretString === undefined) {
      throw new Error(`secret ${secretArn} has no SecretString`);
    }
    const parsed = JSON.parse(result.SecretString) as Partial<JwtCredentials>;
    if (
      parsed.client_id === undefined ||
      parsed.client_secret === undefined ||
      parsed.token_endpoint === undefined ||
      parsed.audience === undefined ||
      parsed.scope === undefined
    ) {
      throw new Error(
        `secret ${secretArn} is missing one of: client_id, client_secret, token_endpoint, audience, scope`,
      );
    }
    const value: JwtCredentials = {
      client_id: parsed.client_id,
      client_secret: parsed.client_secret,
      token_endpoint: parsed.token_endpoint,
      audience: parsed.audience,
      scope: parsed.scope,
    };
    cache.set(secretArn, { value, fetchedAtMs: nowMs });
    return value;
  },
};

let activeStore: SecretsStore = secretsManagerStore;

export function setSecretsStore(store: SecretsStore): void {
  activeStore = store;
}

export async function loadJwtCredentials(
  secretArn: string,
): Promise<JwtCredentials> {
  return activeStore.loadJwtCredentials(secretArn);
}

/** Test-only: clear the secrets cache between cases. */
export function _resetSecretsCacheForTesting(): void {
  cache.clear();
}
