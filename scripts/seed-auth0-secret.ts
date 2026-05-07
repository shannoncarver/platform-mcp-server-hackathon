// Populate the Auth0 management-creds secret from environment variables.
//
// The auth0-handler stack creates the secret with placeholder values; this
// script overwrites the SecretString with real Auth0 M2M credentials.
//
// Usage:
//   AUTH0_DOMAIN=linq-accounts-sandbox.us.auth0.com \
//   AUTH0_CLIENT_ID=... \
//   AUTH0_CLIENT_SECRET=... \
//   AWS_PROFILE=linq-platform-dev \
//     npx tsx scripts/seed-auth0-secret.ts
//
// The secret name is fixed (`platform-mcp/auth0/management-creds`) — this
// is intentionally a single-secret-per-Lambda pattern, not a per-tenant
// pattern. The Lambda reads it on every invocation; no env-var override
// in the Lambda runtime, by design.

import {
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const SECRET_NAME =
  process.env.AUTH0_SECRET_NAME ?? "platform-mcp/auth0/management-creds";
const REGION = process.env.AWS_REGION ?? "us-east-1";

const domain = process.env.AUTH0_DOMAIN ?? "";
const client_id = process.env.AUTH0_CLIENT_ID ?? "";
const client_secret = process.env.AUTH0_CLIENT_SECRET ?? "";

if (
  domain.length === 0 ||
  client_id.length === 0 ||
  client_secret.length === 0
) {
  // eslint-disable-next-line no-console
  console.error(
    "AUTH0_DOMAIN, AUTH0_CLIENT_ID, and AUTH0_CLIENT_SECRET must all be set.\n" +
      "Get them from the Auth0 Dashboard: Applications → [Platform-MCP M2M app]\n" +
      "→ Settings (domain) and Credentials (client_id, client_secret).",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const sm = new SecretsManagerClient({ region: REGION });
  const blob = JSON.stringify({ domain, client_id, client_secret });
  // eslint-disable-next-line no-console
  console.log(`Writing secret ${SECRET_NAME} ...`);
  const result = await sm.send(
    new PutSecretValueCommand({
      SecretId: SECRET_NAME,
      SecretString: blob,
    }),
  );
  if (result.ARN === undefined) {
    throw new Error("PutSecretValue did not return an ARN");
  }
  // eslint-disable-next-line no-console
  console.log("Done.");
  // eslint-disable-next-line no-console
  console.log(`  ARN: ${result.ARN}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
