#!/usr/bin/env bash
# Deploy the ERP handler stack to the linq-erp-dev AWS account.
#
# This stack includes the Cognito User Pool, app client, and HTTP API v2
# with JWT authorizer — no cross-account IAM is required because auth on
# the wire is OAuth 2.0 client_credentials + Bearer JWT.
#
# Prerequisites:
#   - AWS CLI v2, AWS SAM CLI installed.
#   - An AWS profile (default: `linq-erp-dev`) configured to point at the
#     linq-erp-dev account, with permissions to create the resources in
#     infra/erp-handler/cfn/erp-handler.yaml.
#
# Usage:
#   ./scripts/deploy-erp-handler.sh
#
# After this completes, run scripts/seed-jwt-secret.ts (with the linq-platform-dev
# profile) to copy the Cognito credentials into Secrets Manager.

set -euo pipefail

PROFILE="${AWS_PROFILE:-linq-erp-dev}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-erp-handler-platform-mcp}"
TEMPLATE="infra/erp-handler/cfn/erp-handler.yaml"

echo "==> Installing ERP handler dependencies ..."
cd infra/erp-handler
npm install --no-audit --no-fund
cd ../..

echo "==> sam build (esbuild) ..."
sam build --template "${TEMPLATE}"

# LINQ env-aware table naming. The dev tables in linq-erp-dev are
# `dev_erp_users` and `dev_erp_tenants` (per the verify-user-authorization
# skill convention). Override the parameter defaults explicitly because
# CloudFormation does NOT re-read parameter defaults during stack updates
# once a value is in place.
ERP_USERS_TABLE="${ERP_USERS_TABLE:-dev_erp_users}"
ERP_TENANTS_TABLE="${ERP_TENANTS_TABLE:-dev_erp_tenants}"

echo "==> sam deploy ..."
echo "    Using tables: ${ERP_USERS_TABLE}, ${ERP_TENANTS_TABLE}"
sam deploy \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --profile "${PROFILE}" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "ErpUsersTableName=${ERP_USERS_TABLE}" \
    "ErpTenantsTableName=${ERP_TENANTS_TABLE}"

echo ""
echo "==> Stack outputs:"
aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --profile "${PROFILE}" \
  --query 'Stacks[0].Outputs' \
  --output table

echo ""
echo "==> Next steps:"
echo "    1. Run scripts/seed-jwt-secret.ts with AWS_PROFILE=linq-platform-dev"
echo "       to copy the Cognito client credentials into Secrets Manager."
echo "    2. Run scripts/seed-tool-registry.ts with the new dispatch shape."
