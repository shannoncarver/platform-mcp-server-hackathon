// Insert one row into platform_mcp_user_permissions for the demo user.
//
// Run after the Platform stack is deployed:
//   AWS_PROFILE=linq-platform npx ts-node scripts/seed-demo-user.ts
//
// Override the email/tenant via env vars:
//   DEMO_USER_EMAIL, DEMO_TENANT_ID, DEMO_PERMISSIONS (comma-separated)

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.USER_PERMISSIONS_TABLE_NAME ?? "platform_mcp_user_permissions";
const EMAIL = process.env.DEMO_USER_EMAIL ?? "mshannoncarver@gmail.com";
const TENANT = process.env.DEMO_TENANT_ID ?? "demo-tenant";
const PERMISSIONS = (process.env.DEMO_PERMISSIONS ?? "erp:user:read")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

async function main(): Promise<void> {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const now = new Date().toISOString();
  const row = {
    user_email: EMAIL,
    permissions: new Set(PERMISSIONS),
    tenant_id: TENANT,
    last_modified_at: now,
    last_modified_by: "scripts/seed-demo-user.ts",
  };
  // eslint-disable-next-line no-console
  console.log(`Seeding ${TABLE}:`, {
    user_email: EMAIL,
    permissions: PERMISSIONS,
    tenant_id: TENANT,
  });
  await ddb.send(new PutCommand({ TableName: TABLE, Item: row }));
  // eslint-disable-next-line no-console
  console.log("Done.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
