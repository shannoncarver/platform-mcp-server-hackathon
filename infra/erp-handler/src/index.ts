// erp.checkUserAccess Lambda — runs in the linq-erp-dev account, fronted
// by API Gateway REST v1 with AWS_IAM auth + a resource policy listing the
// Platform MCP Lambda role ARN as the only allowed principal.
//
// Trust model: the request body is trusted because the SigV4 signature
// (validated by API Gateway) proves it originated from the Platform MCP
// role. The handler does NOT validate JWTs; it does NOT re-authenticate
// the user. Tenant scope is enforced here — that's what the architecture
// asks of every product handler.

import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { decide, type TenantRow, type UserRow } from "./decision.js";

const ERP_USERS_TABLE = process.env.ERP_USERS_TABLE_NAME ?? "erp_users";
const ERP_TENANTS_TABLE =
  process.env.ERP_TENANTS_TABLE_NAME ?? "erp_tenants";
const SUPERUSER_SK_VALUE = process.env.ERP_SUPERUSER_SK ?? "SUPERUSER";

let docClient: DynamoDBDocumentClient | undefined;

function getClient(): DynamoDBDocumentClient {
  if (docClient === undefined) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return docClient;
}

interface RequestBody {
  user_email?: unknown;
  tenant_id?: unknown;
  request_id?: unknown;
  arguments?: unknown;
}

export interface ErpReader {
  getUserInTenant(
    email: string,
    tenantId: string,
  ): Promise<UserRow | undefined>;
  getSuperuser(email: string): Promise<UserRow | undefined>;
  getTenant(tenantId: string): Promise<TenantRow | undefined>;
}

const ddbReader: ErpReader = {
  async getUserInTenant(email, tenantId): Promise<UserRow | undefined> {
    const result = await getClient().send(
      new GetCommand({
        TableName: ERP_USERS_TABLE,
        Key: { pk: email, sk: tenantId },
      }),
    );
    return result.Item as UserRow | undefined;
  },
  async getSuperuser(email): Promise<UserRow | undefined> {
    const result = await getClient().send(
      new GetCommand({
        TableName: ERP_USERS_TABLE,
        Key: { pk: email, sk: SUPERUSER_SK_VALUE },
      }),
    );
    return result.Item as UserRow | undefined;
  },
  async getTenant(tenantId): Promise<TenantRow | undefined> {
    const result = await getClient().send(
      new GetCommand({
        TableName: ERP_TENANTS_TABLE,
        Key: { pk: tenantId },
      }),
    );
    return result.Item as TenantRow | undefined;
  },
};

let activeReader: ErpReader = ddbReader;

export function setReaderForTesting(reader: ErpReader): void {
  activeReader = reader;
}

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  let body: RequestBody;
  try {
    body = JSON.parse(event.body ?? "{}") as RequestBody;
  } catch {
    return badRequest("invalid JSON body");
  }

  if (typeof body.user_email !== "string" || body.user_email.length === 0) {
    return badRequest("user_email is required");
  }
  if (typeof body.tenant_id !== "string" || body.tenant_id.length === 0) {
    return badRequest("tenant_id is required");
  }

  try {
    const [user_in_tenant, superuser, tenant] = await Promise.all([
      activeReader.getUserInTenant(body.user_email, body.tenant_id),
      activeReader.getSuperuser(body.user_email),
      activeReader.getTenant(body.tenant_id),
    ]);

    const decision = decide({ user_in_tenant, superuser, tenant });

    return ok({
      authorization: {
        authorized: decision.authorized,
        status: decision.status,
        reason: decision.reason,
      },
      user_in_tenant: user_in_tenant ?? null,
      superuser: superuser ?? null,
      tenant: tenant ?? null,
      matched_user_record: decision.matched_user_record,
      request_id: typeof body.request_id === "string" ? body.request_id : null,
    });
  } catch (err) {
    return ok({
      authorization: {
        authorized: false,
        status: "ERROR",
        reason: (err as Error).message,
      },
      user_in_tenant: null,
      superuser: null,
      tenant: null,
      matched_user_record: "none",
      request_id: typeof body.request_id === "string" ? body.request_id : null,
    });
  }
}

function ok(body: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function badRequest(reason: string): APIGatewayProxyResult {
  return {
    statusCode: 400,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: { code: "BAD_REQUEST", message: reason } }),
  };
}
