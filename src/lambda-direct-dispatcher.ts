// In-account dispatcher — synchronous AWS Lambda Invoke.
//
// The third dispatch pattern, alongside `inline` and `https-jwt`. Used for
// platform-team-owned handlers that live in the SAME AWS account as the
// platform (the Auth0 management Lambda is the first such handler).
//
// Wire shape sent to the called Lambda:
//   { caller_email, request_id, action, arguments }
//
// `action` is sourced from the registry row (NOT from user input) so a
// single Lambda can multiplex multiple registered tools. The called Lambda
// owns its own credentials — the platform never reads the called Lambda's
// secrets. The only IAM surface added on the platform side is
// `lambda:InvokeFunction` against the called Lambda's ARN.
//
// Test seam: a pluggable adapter (`setDispatcherForTesting`) lets unit
// tests substitute the AWS SDK call. Mirrors the `RegistryStore` /
// `SecretsStore` injection pattern used elsewhere in this codebase.
//
// See ADR 0025 and `docs/dispatch-patterns.md` for the decision tree.

import {
  LambdaClient,
  InvokeCommand,
  type InvokeCommandOutput,
} from "@aws-sdk/client-lambda";

/** Body field shape the platform sends to the called Lambda. */
export interface LambdaDirectDispatchBody {
  caller_email: string;
  request_id: string;
  arguments: Record<string, unknown>;
}

/** Inputs to a single `lambda-direct` dispatch. */
export interface LambdaDirectDispatchInput {
  lambdaArn: string;
  action: string;
  body: LambdaDirectDispatchBody;
  /** Per-invocation timeout. Default 15s. */
  timeoutMs?: number;
}

/** Result envelope returned to the caller on a successful invoke. */
export interface LambdaDirectDispatchResult {
  /** HTTP-shaped status. 200 on a successful Invoke regardless of the
   *  Lambda's own return value (the called Lambda may return its own
   *  `{ ok: false, error }` envelope at status 200 — that is a domain
   *  concern, not a transport concern). Non-200 here means the Invoke
   *  itself failed (function error, throttling, ARN not found, etc.). */
  status: number;
  body: unknown;
}

/**
 * Thrown when an `Invoke` call fails at the AWS-SDK level (function error,
 * throttling, ARN not found, payload-too-large, etc.) or when the Lambda
 * itself returned a `FunctionError` (`Unhandled` / `Handled`).
 */
export class LambdaDirectDispatchError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string,
    message: string,
  ) {
    super(message);
    this.name = "LambdaDirectDispatchError";
  }
}

/** Pluggable adapter — production uses AWS SDK; tests inject a fake. */
export interface LambdaDirectDispatcher {
  dispatch(input: LambdaDirectDispatchInput): Promise<LambdaDirectDispatchResult>;
}

let lambdaClient: LambdaClient | undefined;

function getClient(): LambdaClient {
  if (lambdaClient === undefined) {
    lambdaClient = new LambdaClient({});
  }
  return lambdaClient;
}

/** Production adapter — synchronous `Invoke` via @aws-sdk/client-lambda. */
export const awsLambdaDispatcher: LambdaDirectDispatcher = {
  async dispatch(
    input: LambdaDirectDispatchInput,
  ): Promise<LambdaDirectDispatchResult> {
    const timeoutMs = input.timeoutMs ?? 15_000;

    // The platform sets `action` AT THE TOP LEVEL of the payload, not folded
    // into `arguments`. This is a security property: the registry controls
    // `action`, the user controls `arguments`. A user cannot rewrite
    // `action` through `arguments` injection.
    const payload = {
      caller_email: input.body.caller_email,
      request_id: input.body.request_id,
      action: input.action,
      arguments: input.body.arguments,
    };

    const cmd = new InvokeCommand({
      FunctionName: input.lambdaArn,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload), "utf8"),
    });

    let result: InvokeCommandOutput;
    try {
      result = await runWithTimeout(getClient().send(cmd), timeoutMs);
    } catch (err) {
      if ((err as Error).message === "lambda-direct dispatch timeout") {
        throw new LambdaDirectDispatchError(
          504,
          "",
          "lambda-direct dispatch timeout",
        );
      }
      throw err;
    }

    const status = result.StatusCode ?? 0;
    const responseText =
      result.Payload !== undefined
        ? Buffer.from(result.Payload).toString("utf8")
        : "";

    if (result.FunctionError !== undefined) {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          kind: "lambda_direct_function_error",
          lambdaArn: input.lambdaArn,
          action: input.action,
          functionError: result.FunctionError,
          response_body: responseText.slice(0, 1024),
        }),
      );
      throw new LambdaDirectDispatchError(
        502,
        responseText,
        `lambda function error: ${result.FunctionError}`,
      );
    }

    if (status < 200 || status >= 300) {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          kind: "lambda_direct_non_2xx",
          lambdaArn: input.lambdaArn,
          action: input.action,
          status,
          response_body: responseText.slice(0, 1024),
        }),
      );
      throw new LambdaDirectDispatchError(
        status,
        responseText,
        `lambda invoke returned non-2xx: ${status}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = responseText.length > 0 ? JSON.parse(responseText) : {};
    } catch {
      parsed = responseText;
    }
    return { status, body: parsed };
  },
};

let activeDispatcher: LambdaDirectDispatcher = awsLambdaDispatcher;

/** Inject a fake dispatcher (test-only). Resets via `_resetDispatcherForTesting`. */
export function setDispatcherForTesting(
  dispatcher: LambdaDirectDispatcher,
): void {
  activeDispatcher = dispatcher;
}

/** Test-only: restore the AWS-SDK adapter. */
export function _resetDispatcherForTesting(): void {
  activeDispatcher = awsLambdaDispatcher;
}

/** Public entry point — calls the active dispatcher. */
export async function dispatch(
  input: LambdaDirectDispatchInput,
): Promise<LambdaDirectDispatchResult> {
  return activeDispatcher.dispatch(input);
}

async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("lambda-direct dispatch timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
