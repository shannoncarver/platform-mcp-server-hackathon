// SigV4-signed HTTPS dispatcher for cross-account API Gateway calls.
//
// The Platform MCP Lambda's execution-role credentials are loaded via the
// AWS SDK v3 default credential provider chain (which inside Lambda yields
// short-lived STS credentials with a session token). We sign with SigV4
// using the `execute-api` service name and the region of the target API.
//
// Errors surface as typed exceptions so the dispatcher in `tools-call.ts`
// can map them onto JSON-RPC error envelopes.

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import * as https from "node:https";

export interface DispatchInput {
  url: string; // e.g. https://abc123.execute-api.us-east-1.amazonaws.com/prod/erp/checkUserAccess
  body: Record<string, unknown>;
  region?: string; // defaults to the URL's region
  timeoutMs?: number;
}

export interface DispatchResult {
  status: number;
  body: unknown;
}

export class DispatchError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string,
    message: string,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

/**
 * Sign and POST a JSON body to a per-product API Gateway with `AWS_IAM` auth.
 *
 * Region is inferred from the URL host (`<id>.execute-api.<region>.amazonaws.com`)
 * unless explicitly overridden.
 */
export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const url = new URL(input.url);
  const region = input.region ?? regionFromHost(url.hostname);

  const signer = new SignatureV4({
    service: "execute-api",
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const bodyString = JSON.stringify(input.body);
  const httpRequest = new HttpRequest({
    method: "POST",
    hostname: url.hostname,
    path: url.pathname + (url.search ?? ""),
    headers: {
      "content-type": "application/json",
      host: url.hostname,
    },
    body: bodyString,
    protocol: "https:",
  });

  const signed = await signer.sign(httpRequest);

  return await new Promise<DispatchResult>((resolve, reject) => {
    const req = https.request(
      {
        method: signed.method,
        hostname: url.hostname,
        path: signed.path,
        headers: signed.headers,
        timeout: input.timeoutMs ?? 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(
              new DispatchError(
                status,
                text,
                `dispatch returned non-2xx: ${status}`,
              ),
            );
            return;
          }
          let parsed: unknown;
          try {
            parsed = text.length > 0 ? JSON.parse(text) : {};
          } catch {
            parsed = text;
          }
          resolve({ status, body: parsed });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("dispatch timeout"));
    });
    req.on("error", reject);
    req.write(bodyString);
    req.end();
  });
}

function regionFromHost(host: string): string {
  // <api-id>.execute-api.<region>.amazonaws.com
  const parts = host.split(".");
  const idx = parts.indexOf("execute-api");
  if (idx >= 0 && parts.length > idx + 1) return parts[idx + 1];
  return process.env.AWS_REGION ?? "us-east-1";
}
