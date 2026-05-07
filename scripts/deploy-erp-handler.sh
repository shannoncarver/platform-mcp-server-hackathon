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

echo "==> Building ERP handler ..."
cd infra/erp-handler
npm install --no-audit --no-fund
npm run build
cd ../..

echo "==> sam build ..."
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
