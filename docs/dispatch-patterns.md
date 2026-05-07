# Dispatch patterns

The Platform MCP Server resolves every `tools/call` request through a single discriminated-union field on the registry row: `dispatchTarget`. This document is the canonical reference for the three kinds, the wire shape each one sends, the IAM model, and the decision tree for picking one when adding a new tool.

## The three kinds

### `inline`

In-process call to a TypeScript function inside the Platform MCP Lambda itself. Used only for the platform's own meta-tools (`platform_whoami`, `platform_list_products`, `platform_search_tools`). No network hop, no IAM grant beyond what the Lambda already holds (DDB read).

### `https-jwt`

Public HTTPS POST to a per-product API Gateway in a different AWS account, with an OAuth-2.0 `client_credentials` JWT in the `Authorization` header. The Platform Lambda mints the JWT from a Cognito token endpoint, presents it as a Bearer token, and the API Gateway's JWT authorizer validates it. Used for cross-account product handlers (the ERP handler in `linq-erp-dev` is the reference implementation).

This pattern is **SCP-safe**: cross-account `execute-api:Invoke` is blocked at the LINQ org level, so JWT-on-the-wire routes around the constraint entirely. The Platform Lambda never holds AWS credentials for the product account.

### `lambda-direct`

Synchronous AWS Lambda `Invoke` against a Lambda in the **same AWS account** as the platform. No JWT, no API Gateway — the platform talks to the called Lambda over the AWS control plane. Used for **platform-team-owned handlers** that live alongside the platform Lambda. The first such handler is `auth0-handler-platform-mcp`.

The platform Lambda's IAM role grants `lambda:InvokeFunction` on the called Lambda's ARN; the called Lambda's resource policy grants invocation by the platform Lambda's role ARN (belt-and-braces). The called Lambda owns its own credentials — typically a dedicated Secrets Manager secret it reads on every invocation — and the platform never sees them.

## Wire shape

The body the platform sends to a downstream handler is the same for both `https-jwt` and `lambda-direct`:

```json
{
  "caller_email": "scarver@linq.com",
  "request_id": "req-abc-123",
  "arguments": { /* user-supplied tool arguments, verbatim */ }
}
```

`caller_email` is the verified user identity (extracted server-side from the SigV4'd AWS SSO assumed-role ARN — never user-supplied). `request_id` enables cross-hop tracing. `arguments` is `tools/call.params.arguments`, passed through verbatim so the handler reads its operation inputs from there.

`lambda-direct` adds one extra top-level field, sourced from the registry row (NOT from user input):

```json
{
  "caller_email": "scarver@linq.com",
  "request_id": "req-abc-123",
  "action": "user",
  "arguments": { "email": "scarver@linq.com" }
}
```

`action` lets a single Lambda multiplex multiple registered tools — the Auth0 handler dispatches on it to one of `logs`, `stats`, `sec`, `clients`, `user`. The registry controls `action`; a user cannot rewrite it through `arguments` injection (`arguments.action` is preserved verbatim but is data, not control).

## IAM and credential model

| | `inline` | `https-jwt` | `lambda-direct` |
| --- | --- | --- | --- |
| **AWS account** | Platform | Per-product (cross-account) | Platform (same-account) |
| **Wire auth** | None | OAuth Bearer JWT | AWS-SDK Invoke |
| **Platform IAM grant** | None | `secretsmanager:GetSecretValue` on `platform-mcp/<family>/*` | `lambda:InvokeFunction` on the function ARN |
| **Handler holds creds for** | Nothing | Itself | Itself (via its own Secrets Manager secret) |
| **Token caching** | N/A | Yes (per cold container) | N/A — handler-side concern |

The platform never holds the called handler's third-party credentials. For `https-jwt` it holds Cognito M2M creds (tied to the API Gateway's JWT authorizer). For `lambda-direct` it holds nothing — the called Lambda fetches its own secret.

## Decision tree

When adding a new tool, walk this tree top-to-bottom:

1. **Is the tool's logic a property of the platform itself** — e.g., it operates on the registry, the permissions store, or the caller's identity? → **`inline`**.
2. **Is the tool owned by another product team and deployed to that team's AWS account?** → **`https-jwt`**. The product team writes their own handler, fronted by their own API Gateway with a JWT authorizer; the platform team adds the registry row + Secrets Manager secret. (See `infra/erp-handler/` for the reference implementation.)
3. **Is the tool owned by the platform team but external in nature** — calling a third-party API like Auth0, GitHub, Slack? → **`lambda-direct`**. Live in `infra/<service>-handler/`, deploy alongside the platform stack, hold the third-party credentials in your own Secrets Manager secret.

If it's none of those, ask first. Do not invent a fourth kind.

## What `lambda-direct` is NOT for

- **Cross-account product handlers.** Use `https-jwt`. SCPs block in-account IAM from reaching another LINQ account.
- **Compute that the platform Lambda could just do itself.** If the call is fast and depends only on data the platform already has, prefer `inline`.
- **Per-tenant or per-customer handlers.** The platform has no concept of tenant; tenant scope (if any) belongs at the handler.
- **Long-running jobs.** Lambda's 15-minute ceiling applies to the called Lambda; if you need more, you need a different control plane.

## Adding a new `lambda-direct` tool — checklist

1. Create `infra/<service>-handler/` mirroring `infra/auth0-handler/`. Use the same `package.json` / `tsconfig.json` / `jest.config.js` shape.
2. Add a SAM template at `infra/<service>-handler/cfn/<service>-handler.yaml` with:
   - The Lambda (Node 20, arm64, esbuild).
   - Its own Secrets Manager secret (placeholder SecretString, populated post-deploy).
   - A conditional `AWS::Lambda::Permission` granting the platform role invoke access.
3. Add a `lambda:InvokeFunction` statement in `infra/cfn/platform.yaml` for the new function ARN.
4. Add a deploy script `scripts/deploy-<service>-handler.sh` modeled on `scripts/deploy-auth0-handler.sh`.
5. Add a post-deploy seed script `scripts/seed-<service>-secret.ts` for the third-party credentials.
6. Add registry rows in `scripts/seed-tool-registry.ts` with `dispatchTarget: { kind: "lambda-direct", lambdaArn, action }`. The `action` lets you multiplex multiple tools onto one Lambda; if the service only ever needs one operation, use the toolId itself.
7. Add the new permissions to `scripts/seed-demo-user.ts`.

That's it. No platform-side code changes — the dispatcher is generic.
