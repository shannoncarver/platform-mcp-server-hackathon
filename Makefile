# SAM build hook for the Platform MCP Lambda. SAM looks for `build-<LogicalId>`.
# The TypeScript build emits to dist/ at the repo root; SAM picks up dist/index.js
# from the function's CodeUri.

build-PlatformMcpLambda:
	npm install --no-audit --no-fund
	npm run build
	mkdir -p $(ARTIFACTS_DIR)/dist
	cp -r dist/* $(ARTIFACTS_DIR)/dist/
	cp package.json $(ARTIFACTS_DIR)/
	cd $(ARTIFACTS_DIR) && npm install --omit=dev --no-audit --no-fund
