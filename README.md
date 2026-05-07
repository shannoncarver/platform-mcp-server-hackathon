# platform-mcp-server-hackathon

LINQ Platform MCP Server — V1, internal-only.

## What this is

A Model Context Protocol (MCP) server that runs as an AWS Lambda behind an HTTP API Gateway. It provides Claude Code (or any AWS-SDK-aware MCP client) with a single governed entry point to a catalog of read-only tools that fan out across LINQ product accounts and platform-team-owned handlers.

The trust chain end-to-end:

```
User (aws sso login)
  ──SigV4──> Platform MCP API Gateway (HTTP API v2, AWS_IAM auth)
              ──> Platform MCP Lambda
                    ├─ extract user_email from assumed-role ARN
                    ├─ load fine-grained permissions from DynamoDB
                    ├─ project the tool catalog by user
                    ├─ enforce coarse RBAC
                    ├─ emit per-request audit
                    └─ dispatch (one of three):
                          (a) inline       — in-process platform meta-tools
                          (b) https-jwt    ──> Per-product API Gateway (cross-account)
                                              JWT authorizer ──> Product Lambda
                          (c) lambda-direct──> In-account platform-team Lambda
                                              (e.g., auth0-handler-platform-mcp)
```

Cross-account hops are OAuth `client_credentials` JWT over public HTTPS — SCP-safe. In-account hops are synchronous Lambda Invoke with the called Lambda owning its own third-party credentials. See [`docs/dispatch-patterns.md`](docs/dispatch-patterns.md) for the full decision tree.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — full system architecture: components, request lifecycle, security model, data model, deployment, and diagrams.
- [`docs/dispatch-patterns.md`](docs/dispatch-patterns.md) — the three dispatch kinds, wire shapes, IAM model, and the decision tree for adding a new tool.
- [`docs/aws-sso-permission-set.md`](docs/aws-sso-permission-set.md) — the SSO permission set users must hold to call the platform.

## Repo layout

```
src/
  index.ts                     Lambda entry — APIGW v2 event → JSON-RPC dispatch
  caller-identity.ts           Extract user_email from assumed-role ARN
  user-permissions-store.ts    DDB-backed permissions lookup (5-min cache)
  registry.ts                  DDB-backed tool registry + per-user projection
  audit.ts                     Single per-request structured-JSON record
  errors.ts                    JSON-RPC + HTTP error envelopes
  jwt-dispatcher.ts            OAuth client_credentials + Bearer-JWT to per-product API GW
  secrets-store.ts             Secrets Manager wrapper with cache
  platform-handlers.ts         platform_whoami, platform_list_products, platform_search_tools
  routes/
    tools-list.ts              tools/list with cursor pagination
    tools-call.ts              tools/call dispatch
test/                          Jest suite
  lambda-direct-dispatcher.ts  In-account dispatcher — synchronous Lambda Invoke
infra/
  cfn/platform.yaml            Platform infra: DDB, Lambda, API Gateway, IAM
  erp-handler/                 ERP product handler (deploys to linq-erp-dev)
  auth0-handler/               Auth0 management handler (deploys in-account
                               alongside the platform Lambda; lambda-direct)
scripts/
  deploy-platform.sh           sam build + deploy
  deploy-erp-handler.sh        sam build + deploy to linq-erp-dev
  deploy-auth0-handler.sh      sam build + deploy in-account
  seed-tool-registry.ts        Insert demo tools into the DDB registry
  seed-demo-user.ts            Insert demo user into the permissions table
  seed-jwt-secret.ts           Copy Cognito client_credentials into Secrets Manager
  seed-auth0-secret.ts         Populate the Auth0 management-creds secret
  demo-cli.ts                  End-to-end demo: SSO login → tools/call → result
  platform-mcp-shim.ts         stdio MCP shim — Claude Code launches this as
                               a local MCP server; the shim SigV4-signs each
                               JSON-RPC frame onto the Platform MCP API GW
```

## Quickstart

Prerequisites: Node 20+, AWS CLI v2, an AWS SSO permission set named `PlatformMcpUser` provisioned in the Platform AWS account.

```sh
# Install
npm install

# Test
npm test

# Deploy platform infra (requires AWS credentials for the Platform account)
./scripts/deploy-platform.sh

# Deploy ERP handler (requires linq-erp-dev profile)
./scripts/deploy-erp-handler.sh

# Deploy the in-account Auth0 handler (uses lambda-direct dispatch)
./scripts/deploy-auth0-handler.sh

# Populate the JWT credentials secret for the ERP handler
AWS_PROFILE=linq-platform-dev npx tsx scripts/seed-jwt-secret.ts erp

# Populate the Auth0 management-creds secret (M2M creds from the Auth0 dashboard)
AUTH0_DOMAIN=linq-accounts-sandbox.us.auth0.com \
AUTH0_CLIENT_ID=... \
AUTH0_CLIENT_SECRET=... \
AWS_PROFILE=linq-platform-dev \
  npx tsx scripts/seed-auth0-secret.ts

# Seed the tool registry (9 tools: 3 inline + 1 erp + 5 auth0)
AUTH0_LAMBDA_ARN=$(aws cloudformation describe-stacks \
  --stack-name auth0-handler-platform-mcp --region us-east-1 \
  --profile linq-platform-dev \
  --query "Stacks[0].Outputs[?OutputKey=='Auth0HandlerLambdaArn'].OutputValue" \
  --output text) \
ERP_API_URL=... ERP_JWT_SECRET_ARN=... \
AWS_PROFILE=linq-platform-dev \
  npx tsx scripts/seed-tool-registry.ts

# Seed the demo user (all default permissions including Auth0)
AWS_PROFILE=linq-platform-dev npx tsx scripts/seed-demo-user.ts

# Run the demo CLI
aws sso login --profile platform-mcp
npx tsx scripts/demo-cli.ts
```

## Adding a tool: dispatch patterns

Three kinds, picked by where the work happens:

- **`inline`** — in-process inside the Platform Lambda. Used for the platform's own meta-tools (`platform_whoami`, `platform_list_products`, `platform_search_tools`). No network hop, no extra IAM grant.
- **`https-jwt`** — public HTTPS POST to a per-product API Gateway in a different LINQ account, with an OAuth `client_credentials` JWT in the `Authorization` header. SCP-safe (no cross-account IAM). Use this when the tool is owned by another product team and lives in their AWS account. Reference: `infra/erp-handler/`.
- **`lambda-direct`** — synchronous AWS Lambda Invoke against a Lambda in the same AWS account as the platform. Use this for platform-team-owned handlers that call third-party APIs (Auth0, GitHub, Slack). The called Lambda owns its own credentials; the platform never sees them. Reference: `infra/auth0-handler/`.

The full decision tree, wire shapes, IAM model, and a checklist for adding a new `lambda-direct` tool are in [`docs/dispatch-patterns.md`](docs/dispatch-patterns.md).

## Using the Platform MCP Server from Claude Code or Claude Desktop

Claude Code and Claude Desktop both speak MCP, but neither natively SigV4-signs API Gateway requests. We ship a small **stdio shim** as a globally-installable npm command. It bridges the MCP-over-stdio transport to the Platform MCP API Gateway, signing each frame with the user's AWS SSO credentials.

### One-time install (per teammate, per machine)

Each teammate runs this once:

```sh
npm install -g github:shannoncarver/platform-mcp-server-hackathon
```

This clones the repo, builds the shim with esbuild (via the `prepare` script), and installs `platform-mcp-shim` as a globally-available command. Verify:

```sh
which platform-mcp-shim
# /opt/homebrew/bin/platform-mcp-shim (or similar — should print a path)
```

To upgrade later: `npm install -g github:shannoncarver/platform-mcp-server-hackathon` again, or use `npm uninstall -g platform-mcp-server-hackathon` to remove.

### Configure Claude Code

```sh
aws sso login --profile linq-platform-dev

claude mcp add linq-platform-dev \
  --scope user \
  --env AWS_PROFILE=linq-platform-dev \
  --env PLATFORM_MCP_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com/prod/jsonrpc \
  -- platform-mcp-shim
```

Restart Claude Code. Run `/mcp` to verify `linq-platform-dev` shows as connected.

### Configure Claude Desktop (macOS)

Open `~/Library/Application Support/Claude/claude_desktop_config.json` (or use **Settings → Developer → Edit Config**). Add the entry under `mcpServers`:

```json
{
  "mcpServers": {
    "linq-platform-dev": {
      "command": "platform-mcp-shim",
      "env": {
        "AWS_PROFILE": "linq-platform-dev",
        "PLATFORM_MCP_URL": "https://<api-id>.execute-api.us-east-1.amazonaws.com/prod/jsonrpc"
      }
    }
  }
}
```

The same config works on every teammate's Mac. Only `PLATFORM_MCP_URL` (constant for the team) and `AWS_PROFILE` (varies if a teammate uses a different SSO profile name) are user-tunable.

Quit and relaunch Claude Desktop. Click the 🔌 icon in a conversation to see `linq-platform-dev` connected.

### Use it

In either app, ask a prompt that maps to a tool. For example: *"Verify johndoe@example.com is authorized for ERP for tenant1"* — Claude picks `erp_checkUserAccess`, the shim signs the request, and the chain runs through API Gateway → Platform MCP Lambda → ERP Lambda → DynamoDB.

## Status

Hackathon V1, May 2026. Read-only tools, internal employees only. Not for production exposure.

## License

MIT — see [LICENSE](LICENSE).
