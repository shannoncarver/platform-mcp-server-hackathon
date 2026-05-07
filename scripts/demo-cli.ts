// End-to-end demo CLI for the Platform MCP Server.
//
// Loads AWS SSO credentials from the active profile, SigV4-signs a JSON-RPC
// request to the Platform MCP API Gateway, and prints the response.
//
// Usage:
//   aws sso login --profile platform-mcp
//   AWS_PROFILE=platform-mcp \
//     PLATFORM_MCP_URL=https://abc.execute-api.us-east-1.amazonaws.com/prod/jsonrpc \
//     npx ts-node scripts/demo-cli.ts tools/list
//
//   AWS_PROFILE=platform-mcp \
//     PLATFORM_MCP_URL=https://... \
//     npx ts-node scripts/demo-cli.ts tools/call erp.checkUserAccess \
//       '{"user_email":"alice@linq.com","tenant_id":"acme"}'

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import * as https from "node:https";

async function main(): Promise<void> {
  const url = process.env.PLATFORM_MCP_URL;
  if (url === undefined) {
    // eslint-disable-next-line no-console
    console.error("PLATFORM_MCP_URL is required.");
    process.exit(2);
  }
  const region = regionFromHost(new URL(url).hostname);

  const args = process.argv.slice(2);
  const method = args[0] ?? "tools/list";
  let params: Record<string, unknown> = {};
  if (method === "tools/call") {
    const toolName = args[1];
    if (toolName === undefined) {
      // eslint-disable-next-line no-console
      console.error("usage: demo-cli.ts tools/call <toolName> [<jsonArguments>]");
      process.exit(2);
    }
    const argumentsJson = args[2] ?? "{}";
    params = { name: toolName, arguments: JSON.parse(argumentsJson) };
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  });

  const target = new URL(url);
  const signer = new SignatureV4({
    service: "execute-api",
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });
  const httpRequest = new HttpRequest({
    method: "POST",
    hostname: target.hostname,
    path: target.pathname,
    headers: { "content-type": "application/json", host: target.hostname },
    body,
    protocol: "https:",
  });
  const signed = await signer.sign(httpRequest);

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        method: signed.method,
        hostname: target.hostname,
        path: signed.path,
        headers: signed.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          // eslint-disable-next-line no-console
          console.log(`HTTP ${res.statusCode}`);
          try {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(JSON.parse(text), null, 2));
          } catch {
            // eslint-disable-next-line no-console
            console.log(text);
          }
          resolve();
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function regionFromHost(host: string): string {
  const parts = host.split(".");
  const idx = parts.indexOf("execute-api");
  if (idx >= 0 && parts.length > idx + 1) return parts[idx + 1];
  return process.env.AWS_REGION ?? "us-east-1";
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
