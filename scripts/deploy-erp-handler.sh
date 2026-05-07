#!/usr/bin/env bash
# Deploy the ERP handler stack to the linq-erp-dev AWS account.
#
# Prerequisites:
#   - AWS CLI v2, AWS SAM CLI installed.
#   - An AWS profile (default: `linq-erp-dev`) configured to point at the
#     linq-erp-dev account, with permissions to create the resources in
#     infra/erp-handler/cfn/erp-handler.yaml.
#   - The platform stack must be deployed first; export
#     PLATFORM_MCP_ROLE_ARN with its PlatformMcpLambdaRoleArn output.
#
# Usage:
#   PLATFORM_MCP_ROLE_ARN=arn:aws:iam::PLATFORM:role/PlatformMcpRole \
#     ./scripts/deploy-erp-handler.sh

set -euo pipefail

PROFILE="${AWS_PROFILE:-linq-erp-dev}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-erp-handler-platform-mcp}"
TEMPLATE="infra/erp-handler/cfn/erp-handler.yaml"

if [[ -z "${PLATFORM_MCP_ROLE_ARN:-}" ]]; then
  echo "ERROR: PLATFORM_MCP_ROLE_ARN must be set." >&2
  echo "  Get it from: aws cloudformation describe-stacks \\" >&2
  echo "    --stack-name platform-mcp-server \\" >&2
  echo "    --query 'Stacks[0].Outputs[?OutputKey==\`PlatformMcpLambdaRoleArn\`].OutputValue' \\" >&2
  echo "    --output text" >&2
  exit 2
fi

echo "==> Installing ERP handler dependencies ..."
cd infra/erp-handler
npm install --no-audit --no-fund
cd ../..

echo "==> sam build (esbuild) ..."
sam build --template "${TEMPLATE}"

echo "==> sam deploy ..."
sam deploy \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --profile "${PROFILE}" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides PlatformMcpRoleArn="${PLATFORM_MCP_ROLE_ARN}"

echo ""
echo "==> Stack outputs:"
aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --profile "${PROFILE}" \
  --query 'Stacks[0].Outputs' \
  --output table

echo ""
echo "==> Applying ERP API resource policy (post-deploy step) ..."
ERP_API_ID=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --profile "${PROFILE}" \
  --query 'Stacks[0].Outputs[?OutputKey==`ErpApiId`].OutputValue' \
  --output text)

if [[ -z "${ERP_API_ID}" ]]; then
  echo "ERROR: could not read ErpApiId from stack outputs." >&2
  exit 3
fi

# Build the patch-operations JSON with Python to avoid shell-escaping hell.
# The resource policy itself becomes the `value` field of one patch op,
# encoded as a JSON-escaped string. Python's json module handles the
# nested-encoding correctly.
PATCH_FILE=$(mktemp -t erp-policy-patch.XXXXXX.json)
trap 'rm -f "${PATCH_FILE}"' EXIT

PLATFORM_MCP_ROLE_ARN="${PLATFORM_MCP_ROLE_ARN}" python3 - <<'PY' > "${PATCH_FILE}"
import json
import os

policy = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {"AWS": os.environ["PLATFORM_MCP_ROLE_ARN"]},
            "Action": "execute-api:Invoke",
            "Resource": "execute-api:/*/POST/erp/checkUserAccess",
        }
    ],
}
patch = [{"op": "replace", "path": "/policy", "value": json.dumps(policy)}]
print(json.dumps(patch))
PY

aws apigateway update-rest-api \
  --rest-api-id "${ERP_API_ID}" \
  --region "${REGION}" \
  --profile "${PROFILE}" \
  --patch-operations "file://${PATCH_FILE}" \
  > /dev/null

echo "Resource policy applied. API ${ERP_API_ID} now locks to: ${PLATFORM_MCP_ROLE_ARN}"
echo ""
echo "Verify with these two commands (AWS stores the policy with literal"
echo "\\\" and \\/ escape sequences, so we unescape before parsing):"
cat <<VERIFY

  cat > /tmp/check-erp-policy.py << 'EOF'
import sys, json
data = json.load(sys.stdin)
p = data.get('policy', '')
if not p:
    print('No resource policy is set on this API.')
else:
    cleaned = p.replace('\\\\"', '"').replace('\\\\/', '/')
    print(json.dumps(json.loads(cleaned), indent=2))
EOF

  aws apigateway get-rest-api \\
    --rest-api-id ${ERP_API_ID} \\
    --region ${REGION} --profile ${PROFILE} \\
    --output json | python3 /tmp/check-erp-policy.py

VERIFY
