// Read Cognito client credentials from the deployed ERP stack and write
// them as a JSON blob into AWS Secrets Manager in the platform account.
//
// The secret follows the naming convention `platform-mcp/<family>/jwt-creds`
// (e.g., platform-mcp/erp/jwt-creds). The Platform Lambda's IAM policy
// grants `secretsmanager:GetSecretValue` on `platform-mcp/*`, so any new
// handler family that follows the same naming becomes invocable without
// IAM changes.
//
// Usage:
//   ERP_STACK_NAME=erp-handler-platform-mcp \
//   ERP_PROFILE=linq-erp-dev \
//   AWS_PROFILE=linq-platform-dev \
//     npx tsx scripts/seed-jwt-secret.ts erp
//
// The first positional argument is the secret namespace (e.g., `erp`).
// The script:
//   1. Describes the ERP stack (using ERP_PROFILE) to read the Cognito
//      outputs.
//   2. Calls Cognito Admin API to retrieve the app-client secret (Cognito
//      doesn't expose `client_secret` as a stack output for security).
//   3. Writes the secret to Secrets Manager (using AWS_PROFILE).

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  ResourceExistsException,
} from "@aws-sdk/client-secrets-manager";
import { fromIni } from "@aws-sdk/credential-providers";

const namespace = process.argv[2];
if (namespace === undefined || namespace.length === 0) {
  // eslint-disable-next-line no-console
  console.error("usage: seed-jwt-secret.ts <namespace> (e.g. 'erp')");
  process.exit(2);
}

const ERP_STACK_NAME = process.env.ERP_STACK_NAME ?? "erp-handler-platform-mcp";
const ERP_PROFILE = process.env.ERP_PROFILE ?? "linq-erp-dev";
const REGION = process.env.AWS_REGION ?? "us-east-1";

interface StackOutputs {
  ErpApiUrl: string;
  CognitoTokenEndpoint: string;
  CognitoIssuer: string;
  CognitoAudience: string;
  CognitoScope: string;
  CognitoClientId: string;
  CognitoUserPoolId: string;
}

async function readErpStackOutputs(): Promise<StackOutputs> {
  const cfn = new CloudFormationClient({
    region: REGION,
    credentials: fromIni({ profile: ERP_PROFILE }),
  });
  const result = await cfn.send(
    new DescribeStacksCommand({ StackName: ERP_STACK_NAME }),
  );
  const stack = result.Stacks?.[0];
  if (stack === undefined) {
    throw new Error(`stack ${ERP_STACK_NAME} not found in ${ERP_PROFILE}`);
  }
  const map: Record<string, string> = {};
  for (const o of stack.Outputs ?? []) {
    if (o.OutputKey !== undefined && o.OutputValue !== undefined) {
      map[o.OutputKey] = o.OutputValue;
    }
  }
  const required = [
    "ErpApiUrl",
    "CognitoTokenEndpoint",
    "CognitoIssuer",
    "CognitoAudience",
    "CognitoScope",
    "CognitoClientId",
    "CognitoUserPoolId",
  ];
  for (const k of required) {
    if (map[k] === undefined) {
      throw new Error(`stack output ${k} is missing`);
    }
  }
  return map as unknown as StackOutputs;
}

async function readClientSecret(
  userPoolId: string,
  clientId: string,
): Promise<string> {
  const cog = new CognitoIdentityProviderClient({
    region: REGION,
    credentials: fromIni({ profile: ERP_PROFILE }),
  });
  const result = await cog.send(
    new DescribeUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
    }),
  );
  const secret = result.UserPoolClient?.ClientSecret;
  if (secret === undefined) {
    throw new Error(
      `Cognito client ${clientId} has no ClientSecret (was GenerateSecret enabled?)`,
    );
  }
  return secret;
}

async function writeSecret(
  name: string,
  value: Record<string, string>,
): Promise<string> {
  const sm = new SecretsManagerClient({ region: REGION });
  const secretString = JSON.stringify(value);
  try {
    const created = await sm.send(
      new CreateSecretCommand({
        Name: name,
        SecretString: secretString,
        Description:
          "Cognito client_credentials creds + token endpoint for a Platform MCP product handler.",
      }),
    );
    if (created.ARN === undefined) {
      throw new Error("CreateSecret did not return an ARN");
    }
    return created.ARN;
  } catch (err) {
    if (err instanceof ResourceExistsException) {
      const updated = await sm.send(
        new PutSecretValueCommand({
          SecretId: name,
          SecretString: secretString,
        }),
      );
      if (updated.ARN === undefined) {
        throw new Error("PutSecretValue did not return an ARN");
      }
      return updated.ARN;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`Reading ${ERP_STACK_NAME} outputs from ${ERP_PROFILE}...`);
  const stack = await readErpStackOutputs();

  // eslint-disable-next-line no-console
  console.log("Reading Cognito client secret...");
  const clientSecret = await readClientSecret(
    stack.CognitoUserPoolId,
    stack.CognitoClientId,
  );

  const secretName = `platform-mcp/${namespace}/jwt-creds`;
  const blob = {
    client_id: stack.CognitoClientId,
    client_secret: clientSecret,
    token_endpoint: stack.CognitoTokenEndpoint,
    audience: stack.CognitoAudience,
    scope: stack.CognitoScope,
  };

  // eslint-disable-next-line no-console
  console.log(
    `Writing secret ${secretName} (in the platform account)... [${Object.keys(blob).join(", ")}]`,
  );
  const arn = await writeSecret(secretName, blob);

  // eslint-disable-next-line no-console
  console.log("Done.\n");
  // eslint-disable-next-line no-console
  console.log("Use this ARN in the tool registry seed:");
  // eslint-disable-next-line no-console
  console.log(`  export ERP_JWT_SECRET_ARN=${arn}`);
  // eslint-disable-next-line no-console
  console.log(`  export ERP_API_URL=${stack.ErpApiUrl}`);
  // eslint-disable-next-line no-console
  console.log(`  export ERP_SCOPE=${stack.CognitoScope}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
