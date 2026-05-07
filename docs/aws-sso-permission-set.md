# AWS SSO permission set — manual setup

Family C task C1. The AWS SSO (IAM Identity Center) permission set is the user-side identity that lets a logged-in LINQ employee invoke the Platform MCP API. Provision it manually in the AWS console for V1; an automated CFN approach is out of scope for the hackathon.

## What you provision

A permission set with:

- **Name**: `PlatformMcpUser`
- **Session duration**: 8 hours (default).
- **Permissions policies** — one inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "execute-api:Invoke",
      "Resource": "arn:aws:execute-api:us-east-1:<PLATFORM_ACCOUNT>:*/prod/POST/jsonrpc"
    }
  ]
}
```

Replace `<PLATFORM_ACCOUNT>` with the Platform AWS account ID where the Platform MCP stack deployed. The wildcard segment after the colons matches whichever API ID CloudFormation assigned to the HTTP API. If you want to lock it down further after deploy, replace `*` with the actual API ID from the `PlatformMcpApi` CFN output.

## Steps

1. In the AWS console, open **IAM Identity Center**.
2. **Permission sets** → **Create permission set** → **Custom permission set**.
3. Set the name to `PlatformMcpUser`.
4. Set **Session duration** to `8 hours`.
5. Skip managed-policy attachment.
6. Add an inline policy with the JSON above.
7. **AWS accounts** → select the Platform AWS account → **Assign users or groups** → assign the `PlatformMcpUser` permission set to the demo user (and any other LINQ employees who need it).
8. Have the user (or yourself) configure the AWS CLI profile:

```sh
aws configure sso
# SSO start URL: <your LINQ SSO portal URL>
# SSO region:    us-east-1
# Account:       <Platform account>
# Role:          PlatformMcpUser
# Profile name:  platform-mcp
```

9. Verify:

```sh
aws sso login --profile platform-mcp
aws sts get-caller-identity --profile platform-mcp
# Expect an assumed-role ARN like:
# arn:aws:sts::PLATFORM_ACCOUNT:assumed-role/AWSReservedSSO_PlatformMcpUser_xxx/<your.email>
```

The trailing email is what the Platform MCP Lambda extracts as `user_email`. It must match the `user_email` row that `seed-demo-user.ts` writes into `platform_mcp_user_permissions`.

## Deprovisioning

Removing the permission-set assignment from a user immediately revokes their access — the next `aws sso login` cycle won't issue STS credentials for this permission set.
