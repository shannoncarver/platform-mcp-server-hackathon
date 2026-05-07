#!/usr/bin/env bash
# Deploy the Platform MCP Server stack to the Platform AWS account.
#
# Prerequisites:
#   - AWS CLI v2, AWS SAM CLI installed.
#   - An AWS profile (default: `linq-platform-dev`) configured to point at the
#     Platform Services account, with permissions to create the resources in
#     infra/cfn/platform.yaml.
#
# Usage:
#   ./scripts/deploy-platform.sh                # uses profile linq-platform-dev
#   AWS_PROFILE=other-profile ./scripts/deploy-platform.sh

set -euo pipefail

PROFILE="${AWS_PROFILE:-linq-platform-dev}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-platform-mcp-server}"
TEMPLATE="infra/cfn/platform.yaml"

echo "==> Installing dependencies ..."
npm install --no-audit --no-fund

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
  --no-fail-on-empty-changeset

echo ""
echo "==> Stack outputs:"
aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --profile "${PROFILE}" \
  --query 'Stacks[0].Outputs' \
  --output table
