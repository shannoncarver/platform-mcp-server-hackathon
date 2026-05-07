#!/usr/bin/env node
/**
 * Platform MCP shim — adapts Claude Code's stdio MCP transport to the
 * Platform MCP Server's SigV4-authenticated HTTPS endpoint.
 *
 * Claude Code launches this file as an MCP `stdio` server. For every JSON-RPC
 * frame on stdin, the shim:
 *   1. SigV4-signs an HTTPS POST to PLATFORM_MCP_URL using the user's AWS
 *      credentials (loaded from the active AWS profile or environment).
 *   2. Reads the response body.
 *   3. Writes the response (a JSON-RPC reply) back on stdout.
 *
 * MCP transport: newline-delimited JSON (per MCP 2025-06-18 stdio transport).
 *
 * Required environment:
 *   PLATFORM_MCP_URL   The full URL to the Platform MCP API Gateway
 *                      jsonrpc route, e.g.
 *                      https://abc.execute-api.us-east-1.amazonaws.com/prod/jsonrpc
 *   AWS_PROFILE        The AWS profile to use (defaults to whatever
 *                      ~/.aws/config has as default).
 *   AWS_REGION         Region for SigV4 signing. Defaults to inferring from
 *                      the URL host, then us-east-1.
 *
 * Example Claude Code config (~/.config/claude-code/mcp.json or similar):
 *
 *   {
 *     "mcpServers": {
 *       "linq-platform": {
 *         "command": "npx",
 *         "args": ["tsx", "/abs/path/to/platform-mcp-server-hackathon/scripts/platform-mcp-shim.ts"],
 *         "env": {
 *           "AWS_PROFILE": "linq-platform-dev",
 *           "PLATFORM_MCP_URL": "https://abc.execute-api.us-east-1.amazonaws.com/prod/jsonrpc"
 *         }
 *       }
 *     }
 *   }
 */

import readline from "node:readline";
import * as https from "node:https";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";

const PLATFORM_MCP_URL = process.env.PLATFORM_MCP_URL;
if (PLATFORM_MCP_URL === undefined || PLATFORM_MCP_URL.length === 0) {
  process.stderr.write("[platform-mcp-shim] PLATFORM_MCP_URL env var is required\n");
  process.exit(2);
}

const TARGET = new URL(PLATFORM_MCP_URL);
const REGION = process.env.AWS_REGION ?? regionFromHost(TARGET.hostname);

// Lazily construct the SigV4 signer so credential resolution happens at the
// first request, after the process is fully up. Reuse for all subsequent
// requests (credential provider caches under the hood).
let signer: SignatureV4 | undefined;
function getSigner(): SignatureV4 {
  if (signer === undefined) {
    signer = new SignatureV4({
      service: "execute-api",
      region: REGION,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
  }
  return signer;
}

interface JsonRpcFrame {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

/**
 * Forward one JSON-RPC frame to the Platform MCP API and return the
 * raw response body (also a JSON-RPC frame).
 */
async function proxyFrame(rawLine: string): Promise<string> {
  const httpRequest = new HttpRequest({
    method: "POST",
    hostname: TARGET.hostname,
    path: TARGET.pathname + (TARGET.search ?? ""),
    headers: {
      "content-type": "application/json",
      host: TARGET.hostname,
    },
    body: rawLine,
    protocol: "https:",
  });
  const signed = await getSigner().sign(httpRequest);

  return await new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        method: signed.method,
        hostname: TARGET.hostname,
        path: signed.path,
        headers: signed.headers,
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            reject(
              new Error(
                `platform MCP returned HTTP ${res.statusCode}: ${text.slice(0, 500)}`,
              ),
            );
            return;
          }
          resolve(text);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("platform MCP request timed out"));
    });
    req.on("error", reject);
    req.write(rawLine);
    req.end();
  });
}

function emitErrorFrame(incoming: string, message: string): void {
  let id: unknown = null;
  try {
    const parsed = JSON.parse(incoming) as JsonRpcFrame;
    id = parsed.id ?? null;
  } catch {
    // ignore — we emit with id=null
  }
  const errFrame = {
    jsonrpc: "2.0",
    id,
    error: { code: -32603, message },
  };
  process.stdout.write(JSON.stringify(errFrame) + "\n");
}

function regionFromHost(host: string): string {
  // <api-id>.execute-api.<region>.amazonaws.com
  const parts = host.split(".");
  const idx = parts.indexOf("execute-api");
  if (idx >= 0 && parts.length > idx + 1) return parts[idx + 1];
  return "us-east-1";
}

// MCP stdio transport: line-delimited JSON.
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  void proxyFrame(trimmed)
    .then((response) => {
      process.stdout.write(response.endsWith("\n") ? response : response + "\n");
    })
    .catch((err) => {
      process.stderr.write(`[platform-mcp-shim] ${(err as Error).message}\n`);
      emitErrorFrame(trimmed, (err as Error).message);
    });
});

rl.on("close", () => {
  process.exit(0);
});
