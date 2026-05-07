# SAM build hook for the ERP handler Lambda.
build-ErpHandlerLambda:
	npm install --no-audit --no-fund
	npm run build
	mkdir -p $(ARTIFACTS_DIR)/dist
	cp -r dist/* $(ARTIFACTS_DIR)/dist/
	cp package.json $(ARTIFACTS_DIR)/
	cd $(ARTIFACTS_DIR) && npm install --omit=dev --no-audit --no-fund
