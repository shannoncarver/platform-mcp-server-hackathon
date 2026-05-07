// Unit tests for the lambda-direct dispatcher.
//
// The dispatcher's AWS-SDK adapter is exercised indirectly through the
// pluggable seam (`setDispatcherForTesting`) in tools-call.test.ts. Here we
// hit the seam directly with a fake adapter and assert the end-to-end
// invariants we care about: payload shape, error mapping, and timeout.

import {
  dispatch,
  setDispatcherForTesting,
  _resetDispatcherForTesting,
  LambdaDirectDispatchError,
  type LambdaDirectDispatchInput,
  type LambdaDirectDispatchResult,
} from "../src/lambda-direct-dispatcher.js";

afterEach(() => {
  _resetDispatcherForTesting();
});

describe("lambda-direct dispatcher — pluggable adapter seam", () => {
  it("forwards inputs verbatim and surfaces the adapter's body in the result", async () => {
    let received: LambdaDirectDispatchInput | undefined;
    setDispatcherForTesting({
      async dispatch(input): Promise<LambdaDirectDispatchResult> {
        received = input;
        return { status: 200, body: { ok: true, data: { foo: "bar" } } };
      },
    });

    const result = await dispatch({
      lambdaArn:
        "arn:aws:lambda:us-east-1:111111111111:function:auth0-handler-platform-mcp",
      action: "logs",
      body: {
        caller_email: "alice@linq.com",
        request_id: "req-1",
        arguments: { query: "type:s" },
      },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, data: { foo: "bar" } });

    // The adapter receives the same payload shape the platform constructs.
    expect(received?.action).toBe("logs");
    expect(received?.body.arguments).toEqual({ query: "type:s" });
    expect(received?.body.caller_email).toBe("alice@linq.com");
    expect(received?.body.request_id).toBe("req-1");
  });

  it("propagates LambdaDirectDispatchError thrown by the adapter (function-error path)", async () => {
    setDispatcherForTesting({
      async dispatch(): Promise<LambdaDirectDispatchResult> {
        throw new LambdaDirectDispatchError(
          502,
          "{\"errorMessage\":\"boom\"}",
          "lambda function error: Unhandled",
        );
      },
    });

    await expect(
      dispatch({
        lambdaArn:
          "arn:aws:lambda:us-east-1:111111111111:function:auth0-handler-platform-mcp",
        action: "user",
        body: {
          caller_email: "alice@linq.com",
          request_id: "req-2",
          arguments: { email: "scarver@linq.com" },
        },
      }),
    ).rejects.toMatchObject({
      name: "LambdaDirectDispatchError",
      status: 502,
    });
  });

  it("propagates a timeout error as a LambdaDirectDispatchError-shaped failure when the adapter raises one", async () => {
    setDispatcherForTesting({
      async dispatch(): Promise<LambdaDirectDispatchResult> {
        throw new LambdaDirectDispatchError(
          504,
          "",
          "lambda-direct dispatch timeout",
        );
      },
    });

    await expect(
      dispatch({
        lambdaArn:
          "arn:aws:lambda:us-east-1:111111111111:function:auth0-handler-platform-mcp",
        action: "stats",
        body: {
          caller_email: "alice@linq.com",
          request_id: "req-3",
          arguments: { window: "7d" },
        },
      }),
    ).rejects.toMatchObject({
      name: "LambdaDirectDispatchError",
      status: 504,
    });
  });

  it("does not fold `action` into `arguments` — the registry-supplied action stays at the top level", async () => {
    let received: LambdaDirectDispatchInput | undefined;
    setDispatcherForTesting({
      async dispatch(input): Promise<LambdaDirectDispatchResult> {
        received = input;
        return { status: 200, body: { ok: true } };
      },
    });

    await dispatch({
      lambdaArn:
        "arn:aws:lambda:us-east-1:111111111111:function:auth0-handler-platform-mcp",
      action: "clients",
      body: {
        caller_email: "alice@linq.com",
        request_id: "req-4",
        // The user-supplied arguments include a malicious `action` key.
        // The dispatcher must not mistake it for the registry-supplied
        // action — `action` lives at the top level.
        arguments: { action: "DELETE_EVERYTHING", name: "ERP V4" },
      },
    });

    expect(received?.action).toBe("clients");
    expect(received?.body.arguments).toEqual({
      action: "DELETE_EVERYTHING",
      name: "ERP V4",
    });
  });
});
