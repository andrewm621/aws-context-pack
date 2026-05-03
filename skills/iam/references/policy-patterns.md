# IAM Policy Patterns Reference

## Policy Structure

Every IAM policy document follows this shape:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HumanReadableIdentifier",
      "Effect": "Allow",
      "Action": ["service:Action"],
      "Resource": ["arn:aws:service:region:account-id:resource"],
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "us-east-1"
        }
      }
    }
  ]
}
```

**Key fields:**

- `Version` — Always `"2012-10-17"`. The older `"2008-10-17"` lacks condition operators and policy variables (`${aws:username}`). Never omit.
- `Sid` — Optional statement identifier. Use it. Makes CloudTrail and debugging readable.
- `Effect` — `"Allow"` or `"Deny"`. Explicit Deny always wins over any Allow, including from SCPs.
- `Action` — List of `"service:Action"` strings. Wildcards are allowed but must be intentional.
- `Resource` — The ARN(s) the statement applies to. The most common least-privilege failure is `"*"` here.
- `Condition` — Optional but powerful. Scope permissions by region, org, IP, VPC endpoint, MFA, tags.

---

## Least Privilege Patterns

### Specific Resource ARNs

Never use `"Resource": "*"` in production identity policies. Specify the exact ARN or a scoped pattern.

```json
// Bad
"Resource": "*"

// Good — exact resource
"Resource": "arn:aws:dynamodb:us-east-1:123456789012:table/orders"

// Good — scoped wildcard (table + its indexes)
"Resource": [
  "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
  "arn:aws:dynamodb:us-east-1:123456789012:table/orders/index/*"
]
```

Some actions are inherently global and legitimately require `"*"` (e.g., `cloudwatch:PutMetricData`, `sts:GetCallerIdentity`). Document these explicitly with a `Sid` like `"GlobalActionsRequiringStar"`.

### Action Wildcards: Use Judiciously

Prefix wildcards that scope to a capability class are acceptable. Broad wildcards that grant a whole service are not.

```
// Acceptable — scopes to read operations on S3
"s3:Get*"
"s3:List*"
"s3:Describe*"

// Not acceptable — grants every S3 action including delete, replicate, ACL changes
"s3:*"

// Never acceptable in identity policies
"*"
```

When you use a wildcard action, mentally enumerate what it expands to. Check the [AWS Actions Reference](https://docs.aws.amazon.com/service-authorization/latest/reference/) if unsure.

### Condition Keys for Extra Constraints

Conditions narrow the effective permission beyond Action + Resource.

**Region restriction:**
```json
"Condition": {
  "StringEquals": {
    "aws:RequestedRegion": ["us-east-1", "us-west-2"]
  }
}
```

**Org membership (useful in trust policies and SCPs):**
```json
"Condition": {
  "StringEquals": {
    "aws:PrincipalOrgID": "o-xxxxxxxxxx"
  }
}
```

**S3 prefix (limit what paths a role can read):**
```json
"Condition": {
  "StringLike": {
    "s3:prefix": ["reports/team-a/*"]
  }
}
```

**Require MFA:**
```json
"Condition": {
  "Bool": {
    "aws:MultiFactorAuthPresent": "true"
  }
}
```

**Source VPC endpoint (deny access outside VPC):**
```json
"Condition": {
  "StringEquals": {
    "aws:SourceVpce": "vpce-0123456789abcdef0"
  }
}
```

---

## Common Policy Templates

### 1. Lambda Execution Role

Minimal permissions for a Lambda that logs to CloudWatch and reads/writes one DynamoDB table.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-function:*"
    },
    {
      "Sid": "DynamoDBTableAccess",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query"
      ],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        "arn:aws:dynamodb:us-east-1:123456789012:table/orders/index/*"
      ]
    }
  ]
}
```

Trust policy for this role (who can assume it):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### 2. CI/CD Role (CDK Deploy)

A scoped role for a deploy pipeline. Uses a permission boundary and restricts to specific CloudFormation stacks.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationDeploy",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:GetTemplate",
        "cloudformation:ValidateTemplate"
      ],
      "Resource": "arn:aws:cloudformation:us-east-1:123456789012:stack/my-app-*/*"
    },
    {
      "Sid": "CDKAssetsBucket",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::cdk-assets-123456789012-us-east-1",
        "arn:aws:s3:::cdk-assets-123456789012-us-east-1/*"
      ]
    },
    {
      "Sid": "PassRoleToCloudFormation",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::123456789012:role/CfnExecutionRole",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "cloudformation.amazonaws.com"
        }
      }
    },
    {
      "Sid": "RequireGitHubOIDCOrigin",
      "Effect": "Deny",
      "Action": "*",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestedRegion": ["us-east-1", "us-west-2"]
        }
      }
    }
  ]
}
```

### 3. S3 Read-Only for Specific Prefix

A role or user that can only read objects under `reports/` — nothing else in the bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBucketWithPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-data-bucket",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["reports/*"]
        }
      }
    },
    {
      "Sid": "GetObjectsUnderPrefix",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::my-data-bucket/reports/*"
    }
  ]
}
```

Note: `s3:ListBucket` goes on the bucket ARN; `s3:GetObject` goes on the object ARN (`bucket/*`). This is a common source of access denied errors.

### 4. Cross-Account Assume Role

Role in Account B that Account A can assume. See `cross-account.md` for the full pattern — this is the inline policy attached to a user/role in Account A that grants the `sts:AssumeRole` permission.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeReadRoleInAccountB",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::987654321098:role/ReadOnlyFromAccountA",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "unique-external-id-value"
        }
      }
    }
  ]
}
```

### 5. Deny All Except from Specific VPC Endpoint

A resource policy (e.g., on an S3 bucket or API Gateway) that rejects all access not originating from a specific VPC endpoint. This is a Deny on a resource policy, which is different from an identity policy.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyNonVPCEAccess",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::my-internal-bucket",
        "arn:aws:s3:::my-internal-bucket/*"
      ],
      "Condition": {
        "StringNotEquals": {
          "aws:SourceVpce": "vpce-0123456789abcdef0"
        }
      }
    }
  ]
}
```

This Deny is in addition to, not instead of, identity-based Allow policies. Both must permit the action for access to succeed (unless the principal is the account root).

---

## Permission Boundaries

### What They Are

A permission boundary is an IAM managed policy attached to a role or user that acts as a **maximum permissions ceiling**. The effective permissions are the intersection of the identity policy and the boundary — you cannot exceed the boundary even if the identity policy allows more.

```
Effective permissions = Identity Policy ∩ Permission Boundary
```

Example: a role has `AdministratorAccess` attached, but its permission boundary only allows `s3:*` and `logs:*`. The role can only perform S3 and Logs actions — the admin policy is constrained.

### When to Use

**Delegated admin:** You want to allow a team lead to create IAM roles for their team, but you don't want them to create roles with more permissions than the team itself has. Attach a boundary, then allow the lead to create roles only if they attach that same boundary.

```json
{
  "Sid": "AllowRoleCreationWithBoundary",
  "Effect": "Allow",
  "Action": ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"],
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/TeamBoundary"
    }
  }
}
```

**CI/CD safety net:** A deploy role has a boundary that prevents it from escalating its own permissions, even if a misconfigured CloudFormation template tries to create an over-privileged role.

---

## Service Control Policies (SCPs)

### What They Are

SCPs are org-level guardrails applied to accounts or OUs. They define the maximum permissions available to any principal in an account — IAM policies cannot grant beyond what the SCP allows.

SCPs do **not** grant permissions. They only constrain. You still need identity-based Allow policies. An SCP Allow + no IAM Allow = no access.

### Deny-List vs Allow-List Strategy

**Deny-list (recommended for most orgs):** Start with `FullAWSAccess` (the default SCP that allows everything), then add targeted Deny statements to block specific actions.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyLeavingOrganization",
      "Effect": "Deny",
      "Action": "organizations:LeaveOrganization",
      "Resource": "*"
    },
    {
      "Sid": "DenyNonApprovedRegions",
      "Effect": "Deny",
      "Action": "*",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestedRegion": ["us-east-1", "us-west-2", "eu-west-1"]
        }
      }
    }
  ]
}
```

**Allow-list:** Remove `FullAWSAccess` and enumerate exactly what's permitted. Maximally restrictive, maximally painful to maintain. Use only in highly regulated accounts (e.g., PCI scope).

### Common SCP Guardrails

- Deny disabling CloudTrail or GuardDuty
- Deny root account actions (except by break-glass procedure)
- Deny creation of IAM users with long-lived credentials (enforce SSO/roles)
- Deny leaving the organization
- Deny purchasing reserved instances or savings plans without approval
- Restrict regions to approved list

---

## IAM Access Analyzer

### What It Does

- **External access findings:** Identifies resources (S3 buckets, roles, KMS keys, Lambda functions, SQS queues) that are accessible from outside your account or org. Runs continuously.
- **Unused access analysis:** Identifies roles, permissions, and access keys that haven't been used in the review window (up to 180 days). Requires a paid analyzer.
- **Policy validation:** Checks policies for syntax errors, deprecated elements, and AWS best practice violations before deployment.
- **Policy generation:** Observes CloudTrail activity for a principal over a period, then generates a least-privilege policy based on what was actually called.

### Generate Least-Privilege Policy from CloudTrail

```bash
# Start policy generation (CloudTrail must be enabled)
aws accessanalyzer start-policy-generation \
  --policy-generation-details principalArn=arn:aws:iam::123456789012:role/MyRole \
  --cloud-trail-details trailArn=arn:aws:cloudtrail:us-east-1:123456789012:trail/MyTrail,\
accessRole=arn:aws:iam::123456789012:role/AccessAnalyzerRole,\
startTime=2024-01-01T00:00:00Z,endTime=2024-02-01T00:00:00Z

# Check status
aws accessanalyzer get-generated-policy --job-id <job-id>
```

The generated policy is a starting point — review it, add resource-level specificity, and add conditions before deploying.

---

## Common Mistakes

### 1. `"Resource": "*"` Everywhere

The single most common least-privilege failure. Every `"*"` resource in a production identity policy is a scope that should be tightened. Start with Access Analyzer's unused access findings to find the worst offenders.

### 2. Not Using Conditions

Action + Resource alone often isn't enough. A role that can `s3:GetObject` on `arn:aws:s3:::bucket/*` can read from any region, any VPC, any IP. Conditions are where real least-privilege lives.

### 3. Overly Broad Action Lists

Copying example policies from the internet without auditing the action list. Common traps:
- `ec2:Describe*` — 100+ actions, most harmless, but includes instance metadata
- `iam:Get*` and `iam:List*` — effectively read-only access to your entire IAM configuration
- `kms:*` — includes schedule key deletion

### 4. Conflating Resource Policies and Identity Policies

S3 bucket policies, KMS key policies, and SQS queue policies are resource-based. IAM user/role policies are identity-based. Both must allow an action for a cross-account access to work. Within the same account, either one is sufficient (plus no SCP deny).

### 5. Not Auditing Attached Policies Regularly

Roles accumulate permissions over time as teams add what they need and never remove what they stop using. Schedule quarterly Access Analyzer unused access reviews. Set a policy that roles unused for 90 days are disabled.

### 6. Using Long-Lived Credentials for CI/CD

IAM user access keys for GitHub Actions, CircleCI, or Jenkins are long-lived credentials that rotate poorly and get committed to repos. Use OIDC federation instead — see `cross-account.md` for the GitHub Actions OIDC pattern.
