#!/usr/bin/env bash
# Deploy the Auth0 handler stack to the linq-platform-dev AWS account.
#
# Same-account-as-the-platform deployment. The `lambda-direct` dispatch
# pattern relies on the platform Lambda having lambda:InvokeFunction on
# this Lambda's ARN — which is granted in infra/cfn/platform.yaml. The
# Auth0HandlerInvokePermission resource in this stack also grants
# resource-policy access to the platform Lambda's role (looked up by
# cross-stack export PlatformMcpLambdaRoleArn).
#
# Prerequisites:
#   - AWS CLI v2, AWS SAM CLI installed.
#   - AWS_PROFILE configured to point at linq-platform-dev (default).
#   - Platform stack already deployed (we read PlatformMcpLambdaRoleArn).
#
# Usage:
#   ./scripts/deploy-auth0-handler.sh
#
# After this completes:
#   1. Run scripts/seed-auth0-secret.ts to populate the management-creds
#      secret with real M2M credentials.
#   2. Run scripts/seed-tool-registry.ts with AUTH0_LAMBDA_ARN set to
#      this stack's Auth0HandlerLambdaArn output.

set -euo pipefail

PROFILE="${AWS_PROFILE:-linq-platform-dev}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-auth0-handler-platform-mcp}"
PLATFORM_STACK_NAME="${PLATFORM_STACK_NAME:-platform-mcp-server}"
TEMPLATE="infra/auth0-handler/cfn/auth0-handler.yaml"

echo "==> Installing Auth0 handler dependencies ..."
cd infra/auth0-handler
npm install --no-audit --no-fund
cd ../..

echo "==> Reading platform-mcp Lambda role ARN from stack ${PLATFORM_STACK_NAME} ..."
PLATFORM_ROLE_ARN="$(
  aws cloudformation describe-stacks \
    --stack-name "${PLATFORM_STACK_NAME}" \
    --region "${REGION}" \
    --profile "${PROFILE}" \
    --query "Stacks[0].Outputs[?OutputKey=='PlatformMcpLambdaRoleArn'].OutputValue" \
    --output text 2>/dev/null || echo ""
)"

if [[ -z "${PLATFORM_ROLE_ARN}" || "${PLATFORM_ROLE_ARN}" == "None" ]]; then
  echo "WARN: could not read PlatformMcpLambdaRoleArn from ${PLATFORM_STACK_NAME}."
  echo "      Deploying without the resource-policy grant; deploy the platform"
  echo "      stack first, then re-run this script."
  PLATFORM_ROLE_ARN=""
else
  echo "      ${PLATFORM_ROLE_ARN}"
fi

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
  --parameter-overrides \
    "PlatformMcpLambdaRoleArn=${PLATFORM_ROLE_ARN}"

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
echo "    1. Populate the M2M secret:"
echo "         AUTH0_DOMAIN=... AUTH0_CLIENT_ID=... AUTH0_CLIENT_SECRET=... \\"
echo "         AWS_PROFILE=${PROFILE} npx tsx scripts/seed-auth0-secret.ts"
echo ""
echo "    2. Seed the tool registry:"
echo "         AUTH0_LAMBDA_ARN=\$(aws cloudformation describe-stacks \\"
echo "           --stack-name ${STACK_NAME} --region ${REGION} --profile ${PROFILE} \\"
echo "           --query \"Stacks[0].Outputs[?OutputKey=='Auth0HandlerLambdaArn'].OutputValue\" \\"
echo "           --output text) \\"
echo "           ERP_API_URL=... ERP_JWT_SECRET_ARN=... \\"
echo "           AWS_PROFILE=${PROFILE} npx tsx scripts/seed-tool-registry.ts"
