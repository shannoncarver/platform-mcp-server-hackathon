// Loads the Auth0 management credentials from Secrets Manager.
//
// This Lambda owns its OWN secret. The platform Lambda never reads it.
// HACKATHON: no token caching — see prompt §2.5; we fetch the secret on
// every invocation and mint a fresh M2M token. Productionizing this is
// a follow-up concern.

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

export interface Auth0ManagementCreds {
  domain: string;
  client_id: string;
  client_secret: string;
}

const SECRET_ID =
  process.env.AUTH0_MANAGEMENT_SECRET_ID ??
  "platform-mcp/auth0/management-creds";

let smClient: SecretsManagerClient | undefined;

function getClient(): SecretsManagerClient {
  if (smClient === undefined) {
    smClient = new SecretsManagerClient({});
  }
  return smClient;
}

/** Pluggable seam — tests inject a fake to avoid network calls. */
export interface SecretLoader {
  load(): Promise<Auth0ManagementCreds>;
}

export const secretsManagerLoader: SecretLoader = {
  async load(): Promise<Auth0ManagementCreds> {
    const result = await getClient().send(
      new GetSecretValueCommand({ SecretId: SECRET_ID }),
    );
    if (result.SecretString === undefined) {
      throw new Error(
        `secret ${SECRET_ID} has no SecretString — was it populated by seed-auth0-secret.ts?`,
      );
    }
    const parsed = JSON.parse(result.SecretString) as Partial<Auth0ManagementCreds>;
    if (
      typeof parsed.domain !== "string" ||
      parsed.domain.length === 0 ||
      parsed.domain === "PLACEHOLDER" ||
      typeof parsed.client_id !== "string" ||
      parsed.client_id.length === 0 ||
      parsed.client_id === "PLACEHOLDER" ||
      typeof parsed.client_secret !== "string" ||
      parsed.client_secret.length === 0 ||
      parsed.client_secret === "PLACEHOLDER"
    ) {
      throw new Error(
        `secret ${SECRET_ID} is missing or has placeholder values for one of: domain, client_id, client_secret`,
      );
    }
    return {
      domain: parsed.domain,
      client_id: parsed.client_id,
      client_secret: parsed.client_secret,
    };
  },
};

let activeLoader: SecretLoader = secretsManagerLoader;

export function setSecretLoaderForTesting(loader: SecretLoader): void {
  activeLoader = loader;
}

export function _resetSecretLoaderForTesting(): void {
  activeLoader = secretsManagerLoader;
}

export async function loadAuth0Creds(): Promise<Auth0ManagementCreds> {
  return activeLoader.load();
}
