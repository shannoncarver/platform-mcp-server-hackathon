import type { APIGatewayProxyEvent } from "aws-lambda";
import { handler, setReaderForTesting } from "../src/index.js";

function buildEvent(body: unknown): APIGatewayProxyEvent {
  // Cast through unknown — APIGatewayProxyEvent has many fields we don't need.
  return {
    body: typeof body === "string" ? body : JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent;
}

describe("erp-handler", () => {
  it("rejects requests missing user_email", async () => {
    setReaderForTesting({
      getUserInTenant: async () => undefined,
      getSuperuser: async () => undefined,
      getTenant: async () => undefined,
    });
    const result = await handler(buildEvent({ tenant_id: "acme" }));
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.message).toContain("user_email");
  });

  it("rejects requests missing tenant_id", async () => {
    setReaderForTesting({
      getUserInTenant: async () => undefined,
      getSuperuser: async () => undefined,
      getTenant: async () => undefined,
    });
    const result = await handler(
      buildEvent({ user_email: "alice@linq.com" }),
    );
    expect(result.statusCode).toBe(400);
  });

  it("returns AUTHORIZED_USER for an active user-in-tenant + active tenant", async () => {
    setReaderForTesting({
      getUserInTenant: async () => ({
        pk: "alice@linq.com",
        sk: "acme",
        is_active: true,
      }),
      getSuperuser: async () => undefined,
      getTenant: async () => ({ pk: "acme", is_active: true }),
    });
    const result = await handler(
      buildEvent({
        user_email: "alice@linq.com",
        tenant_id: "acme",
        request_id: "req-1",
      }),
    );
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.authorization.status).toBe("AUTHORIZED_USER");
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
      buildEvent({ user_email: "alice@linq.com", tenant_id: "acme" }),
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
