# Changelog

All notable changes to this repository are documented here.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project follows [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Auth0 management tools + lambda-direct dispatch (2026-05-07)

- New `lambda-direct` dispatch pattern for in-account, platform-team-owned handlers. The called Lambda holds its own third-party credentials; the platform Lambda's only added IAM surface is `lambda:InvokeFunction` on the function ARN.
- New in-account Auth0 management Lambda (`infra/auth0-handler/`) — multiplexes five registered tools onto one function, dispatching on a registry-controlled top-level `action` field. Field-projection refusals are MANDATORY: client_secret, signing_keys, encryption_key on the clients endpoint; password_hash, phone_password_hash, last_password_reset, guardian_authenticators on the user endpoint. Defensive strip preserves the property even if Auth0 returns the fields.
- Five new registry tools: `platform_auth0_logs`, `platform_auth0_stats`, `platform_auth0_sec`, `platform_auth0_clients`, `platform_auth0_user`.
- Five new permissions: `platform:auth0:{logs,stats,sec,clients,user}:read`. Default demo-user seed grants all five.
- New documentation at [`docs/dispatch-patterns.md`](docs/dispatch-patterns.md) — the canonical reference for the three dispatch kinds, wire shapes, IAM model, and a decision tree for picking one when adding a new tool.
- New deploy script `scripts/deploy-auth0-handler.sh` and post-deploy seed `scripts/seed-auth0-secret.ts`.

### Added — Phase A repo bootstrap (2026-05-06)

- Initial scaffolding for the LINQ Platform MCP Server V1.
- Top-level governance files: `README.md`, `CHANGELOG.md`, `LICENSE` (MIT), `.gitignore`, `.editorconfig`.
- TypeScript build configuration: `package.json` (npm, Node 20+), `tsconfig.json`, `tsconfig.test.json`, `jest.config.js`.
- Empty source-tree skeleton at `src/`, `src/routes/`, `test/`, `infra/cfn/`, `scripts/`.
- Dependencies pinned: AWS SDK v3 clients (DynamoDB, CloudWatch Logs, signature-v4), Jest + ts-jest for tests.
