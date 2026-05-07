# Changelog

All notable changes to this repository are documented here.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project follows [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Phase A repo bootstrap (2026-05-06)

- Initial scaffolding for the LINQ Platform MCP Server V1.
- Top-level governance files: `README.md`, `CHANGELOG.md`, `LICENSE` (MIT), `.gitignore`, `.editorconfig`.
- TypeScript build configuration: `package.json` (npm, Node 20+), `tsconfig.json`, `tsconfig.test.json`, `jest.config.js`.
- Empty source-tree skeleton at `src/`, `src/routes/`, `test/`, `infra/cfn/`, `scripts/`.
- Dependencies pinned: AWS SDK v3 clients (DynamoDB, CloudWatch Logs, signature-v4), Jest + ts-jest for tests.
