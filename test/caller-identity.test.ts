import {
  callerFromEvent,
  extractCallerArn,
  parseAssumedRoleArn,
} from "../src/caller-identity.js";
import { buildEvent } from "./fixtures.js";

describe("parseAssumedRoleArn", () => {
  it("parses an AWS-SSO-issued ARN and extracts the permission-set name", () => {
    const result = parseAssumedRoleArn(
      "arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_PlatformMcpUser_a1b2c3d4e5/alice@linq.com",
    );
    expect(result.account_id).toBe("111111111111");
    expect(result.role_session_name).toBe("alice@linq.com");
    expect(result.permission_set_name).toBe("PlatformMcpUser");
  });

  it("parses a plain assumed-role ARN with no SSO permission-set name", () => {
    const result = parseAssumedRoleArn(
      "arn:aws:sts::222222222222:assumed-role/MyServiceRole/some-session",
    );
    expect(result.account_id).toBe("222222222222");
    expect(result.role_name).toBe("MyServiceRole");
    expect(result.role_session_name).toBe("some-session");
    expect(result.permission_set_name).toBeUndefined();
  });

  it("throws on a malformed ARN", () => {
    expect(() => parseAssumedRoleArn("not-an-arn")).toThrow(
      /unrecognized assumed-role ARN/,
    );
  });
});

describe("extractCallerArn", () => {
  it("prefers requestContext.authorizer.iam.userArn (HTTP API v2)", () => {
    const event = buildEvent();
    expect(extractCallerArn(event)).toContain("alice@linq.com");
  });

  it("falls back to requestContext.identity.userArn (REST API v1 shape)", () => {
    const event = buildEvent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event.requestContext as any).authorizer = undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event.requestContext as any).identity = {
      userArn:
        "arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_PlatformMcpUser_xx/bob@linq.com",
    };
    expect(extractCallerArn(event)).toContain("bob@linq.com");
  });

  it("returns undefined when neither field is present", () => {
    const event = buildEvent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event.requestContext as any).authorizer = undefined;
    expect(extractCallerArn(event)).toBeUndefined();
  });
});

describe("callerFromEvent", () => {
  it("produces a Caller envelope from a valid event", () => {
    const event = buildEvent();
    const caller = callerFromEvent(event);
    expect(caller).toBeDefined();
    expect(caller?.user_email).toBe("alice@linq.com");
    expect(caller?.permission_set_name).toBe("PlatformMcpUser");
    expect(caller?.account_id).toBe("111111111111");
  });

  it("returns undefined when the event lacks a caller", () => {
    const event = buildEvent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event.requestContext as any).authorizer = undefined;
    expect(callerFromEvent(event)).toBeUndefined();
  });
});
