# platform-mcp-server-hackathon

LINQ Platform MCP Server — V1, internal-only.

## What this is

A Model Context Protocol (MCP) server that runs as an AWS Lambda behind an HTTP API Gateway. It provides Claude Code (or any AWS-SDK-aware MCP client) with a single governed entry point to a catalog of read-only tools that fan out across LINQ product accounts.

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
                    └─ ──SigV4──> Per-product API Gateway (REST API v1, AWS_IAM + Resource Policy)
                                    ──> Product Lambda → product DynamoDB
```

One auth mechanism (SigV4 + IAM) at every hop. No JWTs, no token-exchange brokers, no separately-minted credentials.

## Repo layout

```
src/
  index.ts                     Lambda entry — APIGW v2 event → JSON-RPC dispatch
  caller-identity.ts           Extract user_email from assumed-role ARN
  user-permissions-store.ts    DDB-backed permissions lookup (5-min cache)
  registry.ts                  DDB-backed tool registry + per-user projection
  audit.ts                     Single per-request structured-JSON record
  errors.ts                    JSON-RPC + HTTP error envelopes
  sigv4-dispatcher.ts          SigV4-signed HTTPS to per-product API Gateway
  platform-handlers.ts         platform.whoami, platform.list_products
  routes/
    tools-list.ts              tools/list with cursor pagination
    tools-call.ts              tools/call dispatch
    tools-search.ts            platform.search_tools (returns tool_reference[])
test/                          Jest suite
infra/
  cfn/platform.yaml            Platform infra: DDB, Lambda, API Gateway, IAM
  erp-handler/                 ERP product handler (deploys to linq-erp-dev)
scripts/
  deploy-platform.sh           sam build + deploy
  deploy-erp-handler.sh        sam build + deploy to linq-erp-dev
  seed-tool-registry.ts        Insert demo tools into the DDB registry
  seed-demo-user.ts            Insert demo user into the permissions table
  demo-cli.ts                  End-to-end demo: SSO login → tools/call → result
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

# Seed the demo data
npx ts-node scripts/seed-tool-registry.ts
npx ts-node scripts/seed-demo-user.ts

# Run the demo CLI
aws sso login --profile platform-mcp
npx ts-node scripts/demo-cli.ts
```

## Status

Hackathon V1, May 2026. Read-only tools, internal employees only. Not for production exposure.

## License

MIT — see [LICENSE](LICENSE).
