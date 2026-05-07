import { decide, type DecisionInput } from "../src/decision.js";

describe("decide — decision matrix", () => {
  const baseUser = (sk: string) => ({
    pk: "alice@linq.com",
    sk,
    is_active: true,
  });
  const baseTenant = (active = true) => ({ pk: "acme", is_active: active });

  it("AUTHORIZED_USER — active user-in-tenant + active tenant", () => {
    const result = decide({
      user_in_tenant: baseUser("acme"),
      superuser: undefined,
      tenant: baseTenant(true),
    });
    expect(result.authorized).toBe(true);
    expect(result.status).toBe("AUTHORIZED_USER");
    expect(result.matched_user_record).toBe("user_in_tenant");
  });

  it("AUTHORIZED_SUPERUSER — active superuser, active tenant", () => {
    const result = decide({
      user_in_tenant: undefined,
      superuser: baseUser("SUPERUSER"),
      tenant: baseTenant(true),
    });
    expect(result.authorized).toBe(true);
    expect(result.status).toBe("AUTHORIZED_SUPERUSER");
  });

  it("USER_NOT_FOUND — no user-in-tenant, no superuser, but tenant exists", () => {
    const result = decide({
      user_in_tenant: undefined,
      superuser: undefined,
      tenant: baseTenant(true),
    });
    expect(result.authorized).toBe(false);
    expect(result.status).toBe("USER_NOT_FOUND");
    expect(result.matched_user_record).toBe("none");
  });

  it("USER_DISABLED — user-in-tenant row inactive", () => {
    const result = decide({
      user_in_tenant: { pk: "alice@linq.com", sk: "acme", is_active: false },
      superuser: undefined,
      tenant: baseTenant(true),
    });
    expect(result.authorized).toBe(false);
    expect(result.status).toBe("USER_DISABLED");
  });

  it("TENANT_DISABLED — tenant row inactive blocks even an active user", () => {
    const result = decide({
      user_in_tenant: baseUser("acme"),
      superuser: undefined,
      tenant: baseTenant(false),
    });
    expect(result.authorized).toBe(false);
    expect(result.status).toBe("TENANT_DISABLED");
  });

  it("B1 — inactive superuser blocks even an active user-in-tenant", () => {
    const result = decide({
      user_in_tenant: baseUser("acme"),
      superuser: { pk: "alice@linq.com", sk: "SUPERUSER", is_active: false },
      tenant: baseTenant(true),
    });
    expect(result.authorized).toBe(false);
    expect(result.status).toBe("SUPERUSER_DISABLED");
  });

  it("B2 — missing tenant does NOT block an active user-in-tenant", () => {
    const result = decide({
      user_in_tenant: baseUser("acme"),
      superuser: undefined,
      tenant: undefined,
    });
    expect(result.authorized).toBe(true);
    expect(result.status).toBe("TENANT_MISSING_BUT_USER_AUTHORIZED");
  });

  it("B2 — missing tenant does NOT block an active superuser", () => {
    const result = decide({
      user_in_tenant: undefined,
      superuser: baseUser("SUPERUSER"),
      tenant: undefined,
    });
    expect(result.authorized).toBe(true);
    expect(result.status).toBe("TENANT_MISSING_BUT_USER_AUTHORIZED");
  });

  it("TENANT_MISSING_USER_NOT_AUTHORIZED — no user, no superuser, no tenant", () => {
    const result = decide({
      user_in_tenant: undefined,
      superuser: undefined,
      tenant: undefined,
    });
    expect(result.authorized).toBe(false);
    expect(result.status).toBe("TENANT_MISSING_USER_NOT_AUTHORIZED");
  });

  it("active superuser overrides inactive user-in-tenant", () => {
    const input: DecisionInput = {
      user_in_tenant: { pk: "alice@linq.com", sk: "acme", is_active: false },
      superuser: { pk: "alice@linq.com", sk: "SUPERUSER", is_active: true },
      tenant: baseTenant(true),
    };
    const result = decide(input);
    expect(result.authorized).toBe(true);
    expect(result.status).toBe("AUTHORIZED_SUPERUSER");
  });
});
