import type { APIGatewayProxyEvent } from "aws-lambda";
import { handler, setReaderForTesting } from "../src/index.js";

function buildEvent(body: unknown): APIGatewayProxyEvent {
  // Cast through unknown — APIGatewayProxyEvent has many fields we don't need.
  return {
    body: typeof body === "string" ? body : JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent;
}

describe("erp-handler", () => {
  // The platform sends bodies of shape:
  //   { caller_email, request_id, arguments: { user_email, tenant_id } }
  // The handler reads operation inputs from `arguments`, NOT from the top
  // level. `caller_email` is metadata only.

  it("rejects requests missing arguments.user_email", async () => {
    setReaderForTesting({
      getUserInTenant: async () => undefined,
      getSuperuser: async () => undefined,
      getTenant: async () => undefined,
    });
    const result = await handler(
      buildEvent({
        caller_email: "scarver@linq.com",
        request_id: "req-1",
        arguments: { tenant_id: "acme" },
      }),
    );
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.message).toContain("arguments.user_email");
  });

  it("rejects requests missing arguments.tenant_id", async () => {
    setReaderForTesting({
      getUserInTenant: async () => undefined,
      getSuperuser: async () => undefined,
      getTenant: async () => undefined,
    });
    const result = await handler(
      buildEvent({
        caller_email: "scarver@linq.com",
        request_id: "req-1",
        arguments: { user_email: "alice@linq.com" },
      }),
    );
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.message).toContain("arguments.tenant_id");
  });

  it("returns AUTHORIZED_USER for an active user-in-tenant + active tenant; subject is from arguments, not caller", async () => {
    setReaderForTesting({
      getUserInTenant: async (email, tenant) => {
        // Subject must be the entity from arguments, NOT the caller.
        expect(email).toBe("alice@linq.com");
        expect(tenant).toBe("acme");
        return { pk: email, sk: tenant, is_active: true };
      },
      getSuperuser: async () => undefined,
      getTenant: async () => ({ pk: "acme", is_active: true }),
    });
    const result = await handler(
      buildEvent({
        caller_email: "scarver@linq.com",
        request_id: "req-1",
        arguments: { user_email: "alice@linq.com", tenant_id: "acme" },
      }),
    );
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.authorization.status).toBe("AUTHORIZED_USER");
    expect(body.subject).toEqual({ user_email: "alice@linq.com", tenant_id: "acme" });
    expect(body.request_id).toBe("req-1");
  });

  it("returns ERROR envelope on DDB failure (does not throw)", async () => {
    setReaderForTesting({
      getUserInTenant: async () => {
        throw new Error("DynamoDB unreachable");
      },
      getSuperuser: async () => undefined,
      getTenant: async () => undefined,
    });
    const result = await handler(
      buildEvent({
        caller_email: "scarver@linq.com",
        arguments: { user_email: "alice@linq.com", tenant_id: "acme" },
      }),
    );
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.authorization.status).toBe("ERROR");
    expect(body.authorization.reason).toContain("DynamoDB unreachable");
  });

  it("rejects malformed JSON bodies", async () => {
    setReaderForTesting({
      getUserInTenant: async () => undefined,
      getSuperuser: async () => undefined,
      getTenant: async () => undefined,
    });
    const result = await handler(buildEvent("not-valid-json{{"));
    expect(result.statusCode).toBe(400);
  });
});
