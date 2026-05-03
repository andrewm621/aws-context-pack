---
name: iam
description: AWS IAM guidance — identity, policies, roles, cross-account access, least privilege, permission boundaries. Use when configuring access control, debugging permission errors, or designing security.
metadata:
  priority: 8
  docs:
    - "https://docs.aws.amazon.com/IAM/latest/UserGuide/"
    - "https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies.html"
  pathPatterns:
    - 'iam/**'
    - 'policies/**'
    - '*-policy.json'
    - '*-role.json'
    - 'trust-policy.json'
  bashPatterns:
    - '\baws\s+iam\b'
    - '\baws\s+sts\b'
    - '\baws\s+sso\b'
    - '\baws\s+organizations\b'
  importPatterns:
    - "@aws-sdk/client-iam"
    - "@aws-sdk/client-sts"
  promptSignals:
    phrases:
      - "iam policy"
      - "iam role"
      - "permission denied"
      - "access denied"
      - "cross account"
      - "assume role"
      - "least privilege"
      - "permission boundary"
      - "service control policy"
      - "aws permissions"
      - "iam user"
      - "security group"
validate:
  - pattern: '"Effect"\s*:\s*"Allow"[^}]*"Resource"\s*:\s*"\*"'
    message: 'Wildcard Resource (*) in Allow policy — restrict to specific ARNs for least privilege'
    severity: error
  - pattern: '"Action"\s*:\s*"\*"'
    message: 'Wildcard Action (*) grants full access — restrict to specific actions needed'
    severity: error
---

# AWS IAM

## What It Is & When to Use It

AWS Identity and Access Management (IAM) controls who (authentication) can do what (authorization) on which AWS resources. IAM is the foundation of AWS security — every API call is evaluated against IAM policies. There is no cost for IAM itself. Use IAM for all access control: service roles, user permissions, cross-account access, and federation.

## Service Surface

| Component | Description | Limits |
|-----------|-------------|--------|
| **Users** | Long-lived identities (for humans or machines) | 5,000 per account |
| **Groups** | Collection of users sharing policies | 300 per account, 10 groups per user |
| **Roles** | Temporary credential identity (for services, cross-account, federation) | 1,000 per account (soft) |
| **Managed Policies** | Reusable, versioned policies (AWS-managed or customer-managed) | 6,144 bytes per policy |
| **Inline Policies** | Embedded directly in a user/group/role | 2,048 bytes per policy |
| **Permission Boundaries** | Max permissions an identity CAN have | Set on users or roles |
| **SCPs** | Organization-wide guardrails | Set on OUs or accounts |
| **IAM Identity Center** | SSO for human access, replaces IAM users for console | Multi-account |
| **Access Analyzer** | Find unintended access, generate least-privilege policies | Per-region |

**No cost**: IAM, SCPs, IAM Identity Center (SSO) — all free.

## Mental Model

1. **Policy evaluation logic** (critical to understand):
   ```
   Explicit DENY  →  wins always (from any policy type)
        ↓ (no explicit deny)
   Explicit ALLOW →  from identity policy OR resource policy (or both)
        ↓ (no allow found)
   Implicit DENY  →  default, no access
   ```
   Additionally: Permission Boundaries AND identity policies must BOTH allow. SCPs AND identity policies must BOTH allow. They intersect, not union.

2. **The 4 policy layers** (each is an AND condition for IAM principals):
   - **Identity policies** — Attached to user/group/role. "What can this identity do?"
   - **Resource policies** — Attached to a resource (S3 bucket, SQS queue). "Who can access this resource?"
   - **Permission boundaries** — Maximum permissions an identity CAN have. Intersects with identity policies.
   - **SCPs** — Organization-level guardrails. Intersects with everything below.

3. **Principals**: Who is making the request?
   - IAM users (long-lived credentials — avoid for humans)
   - IAM roles (temporary credentials — preferred)
   - AWS services (service-linked roles)
   - Federated identities (SAML, OIDC, IAM Identity Center)
   - Root account (never use for daily operations)

4. **Trust policies**: Every IAM role has a trust policy that specifies WHO can assume it. This is separate from the permissions policy (what the role can DO once assumed).

5. **Condition keys**: Fine-grained control using request context — source IP, MFA status, time, tags, VPC, encryption status, etc. Essential for advanced access patterns.

## Common Patterns

### Lambda Execution Role (CDK)
```typescript
import { Role, ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';

const lambdaRole = new Role(this, 'LambdaRole', {
  assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
});

// Least privilege: only specific DynamoDB table, only specific actions
lambdaRole.addToPolicy(new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
  resources: [table.tableArn, `${table.tableArn}/index/*`],
}));
```

### Cross-Account Role Assumption
```json
// Trust policy on Role in Account B
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::123456789012:role/ServiceRoleInAccountA" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "sts:ExternalId": "unique-external-id" }
    }
  }]
}
```

```typescript
// Code in Account A to assume role in Account B
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

const sts = new STSClient({});
const { Credentials } = await sts.send(new AssumeRoleCommand({
  RoleArn: 'arn:aws:iam::987654321098:role/CrossAccountRole',
  RoleSessionName: 'my-session',
  ExternalId: 'unique-external-id',
}));
```

### GitHub Actions OIDC Federation (no long-lived keys)
```json
// Trust policy for GitHub Actions
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:myorg/myrepo:*"
      }
    }
  }]
}
```

### Permission Boundary (prevent privilege escalation)
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:*", "dynamodb:*", "lambda:*",
        "logs:*", "cloudwatch:*", "sqs:*", "sns:*"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Deny",
      "Action": [
        "iam:CreateUser", "iam:CreateRole",
        "iam:DeletePolicy", "iam:PutRolePermissionsBoundary",
        "organizations:*"
      ],
      "Resource": "*"
    }
  ]
}
```

## Gotchas

1. **Wildcard Resource (`"*"`) is the #1 security risk**: Every Allow policy should have the narrowest possible Resource ARN. `"Resource": "*"` grants access to ALL resources of that type across the entire account.

2. **IAM changes are eventually consistent**: After creating/updating a policy, it may take a few seconds to propagate globally. In automation, add a brief wait or retry after policy changes before testing them.

3. **Policy size limits**: Managed policies max 6,144 bytes, inline policies 2,048 bytes, assume-role policies 2,048 bytes. Use policy variables and conditions instead of listing every resource ARN.

4. **Permission boundaries are AND, not OR**: If an identity policy allows S3 access but the permission boundary doesn't include S3, access is denied. Both must allow the action.

5. **SCPs don't affect the management account**: SCPs restrict member accounts only. The organization management account is always unrestricted — protect it carefully.

6. **Long-lived access keys are security risks**: IAM user access keys don't expire. Use IAM roles with temporary credentials everywhere possible. For CI/CD, use OIDC federation (GitHub Actions, GitLab).

7. **The confused deputy problem**: When a service assumes a role on behalf of a customer, without `ExternalId` in the trust policy, another customer could trick the service into accessing your resources. Always use `ExternalId` for third-party cross-account access.

8. **IAM Access Analyzer — use it**: Generates least-privilege policies from CloudTrail data. Analyzes resource policies for unintended external access. It's free and catches issues that manual review misses.

9. **5,000 IAM users per account is a hard limit**: For organizations with many users, use IAM Identity Center (SSO) with permission sets instead of individual IAM users.

10. **Root account best practices**: Enable MFA, delete access keys, use only for account-level tasks (changing support plan, closing account). Set up a strong password and store recovery info securely.

11. **Tags enable ABAC**: Attribute-Based Access Control uses tags on resources and principals for dynamic policies. More maintainable than listing ARNs, but requires consistent tagging discipline.

12. **Policy simulator exists**: Use the [IAM Policy Simulator](https://policysim.aws.amazon.com/) to test policies before applying them. Also available as `aws iam simulate-principal-policy` CLI command.

## Official Documentation

- [IAM User Guide](https://docs.aws.amazon.com/IAM/latest/UserGuide/)
- [Policy Reference](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies.html)
- [Policy Evaluation Logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)
- [IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [IAM Access Analyzer](https://docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html)
