# IAM Cross-Account Access Reference

## Why Cross-Account

Cross-account access is the primary mechanism for blast radius isolation in AWS organizations. Key motivations:

- **Environment separation:** dev, staging, and prod in separate accounts prevents a bad deploy or compromised credential in dev from touching production data.
- **Team isolation:** different teams own different accounts; cross-account roles are the formal access contract between them.
- **Security tooling:** a centralized security/logging account can pull CloudTrail, Config, and GuardDuty findings from all member accounts without those accounts having access to the security account.
- **Billing and quota isolation:** each account has its own service limits and cost center.
- **Audit clarity:** CloudTrail in each account shows who assumed which role from where, creating a clear chain of custody.

---

## The Trust Chain

```
Trusted Account (Account A)          Trusting Account (Account B)
  Principal (user/role)     ──────>    IAM Role
  has permission to call               has trust policy that names
  sts:AssumeRole                       Account A principal as Principal
```

Terminology is counterintuitive. The **trusting** account is the one that *has* the role and *grants* access to it. The **trusted** account contains the principal that is *allowed* to assume the role.

Memory aid: the trusting account trusts the other account enough to let it in.

---

## Trust Policy Anatomy

A trust policy is the resource-based policy attached to an IAM role that controls who can call `sts:AssumeRole` on it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAccountARole",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::111111111111:role/DeployRole"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "unique-external-id-value"
        }
      }
    }
  ]
}
```

**Principal options:**
- Specific role: `"arn:aws:iam::111111111111:role/RoleName"` — most restrictive, preferred
- Specific user: `"arn:aws:iam::111111111111:user/UserName"` — for legacy IAM users
- Entire account: `"arn:aws:iam::111111111111:root"` — allows any principal in Account A with the right identity policy; less precise
- AWS service: `"lambda.amazonaws.com"` — for service roles
- Federated OIDC: `"arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"`

**Condition options for trust policies:**
- `sts:ExternalId` — anti-confused-deputy for third-party access
- `aws:PrincipalOrgID` — any principal from your organization
- `aws:MultiFactorAuthPresent` — require MFA before assuming
- `sts:RoleSessionName` — enforce that the session name matches a pattern (useful for auditing which CI job assumed the role)

---

## AssumeRole Flow

```
1. Caller in Account A calls STS AssumeRole
   → specifies RoleArn in Account B, optional ExternalId, optional session name

2. STS checks:
   a. Caller's identity policy allows sts:AssumeRole on that ARN
   b. Role's trust policy allows the caller as a Principal

3. Both checks pass → STS issues temporary credentials:
   - AccessKeyId (starts with ASIA...)
   - SecretAccessKey
   - SessionToken
   - Expiration (15 min – 12 hours, default 1 hour)

4. Caller uses temporary credentials for subsequent API calls in Account B
   CloudTrail in Account B records the assumed role session, not the original caller
```

Session duration is set at assume-time up to the role's `MaxSessionDuration` (default 1h, max 12h). Shorter is better for automation; longer is acceptable for human console sessions.

---

## Patterns

### 1. Simple Cross-Account Role

Account B has a role with a trust policy that names a specific role in Account A.

**Trust policy on role in Account B:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::ACCOUNT_A_ID:role/PipelineRole"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

**Identity policy on role in Account A (grants the assume permission):**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::ACCOUNT_B_ID:role/CrossAccountRole"
    }
  ]
}
```

Both sides must be configured. The trust policy is necessary but not sufficient — the calling principal must also have an identity policy that allows `sts:AssumeRole` on that ARN.

### 2. Organization-Wide Trust

Allows any principal from within your AWS Organization to assume the role. Useful for centralized tooling accounts (e.g., security, logging, billing) that need to pull data from all member accounts.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "*"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "aws:PrincipalOrgID": "o-xxxxxxxxxx"
        }
      }
    }
  ]
}
```

Note: `Principal: "*"` with an org condition is correct syntax. The condition is evaluated — only org members can assume the role. Still scope the identity policy on the calling side to specific roles.

### 3. External ID Pattern (Third-Party Access)

When a third-party vendor (monitoring tool, SaaS platform) needs access to your account, the **confused deputy problem** arises: the vendor's system can assume roles in any of their customers' accounts with the same ARN structure. An external ID prevents this.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::VENDOR_ACCOUNT_ID:root"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "your-unique-customer-id-from-vendor"
        }
      }
    }
  ]
}
```

The external ID should be:
- Unique per customer relationship (the vendor generates it for you)
- Unpredictable (UUID or similar)
- Stored on the vendor side, not in the trust policy on your side

Without an external ID, a malicious customer of the same vendor could trick the vendor's system into assuming your role by providing your role ARN.

### 4. Role Chaining

Role A assumes Role B in Account B, and then Role B assumes Role C in Account C. This is valid but has an important constraint: **chained sessions are capped at 1 hour** regardless of the role's `MaxSessionDuration`.

```bash
# Step 1: Assume role in Account B
aws sts assume-role \
  --role-arn arn:aws:iam::ACCOUNT_B_ID:role/RoleB \
  --role-session-name step1-session \
  --duration-seconds 3600

# Step 2: Using Account B credentials, assume role in Account C
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_SESSION_TOKEN=... \
aws sts assume-role \
  --role-arn arn:aws:iam::ACCOUNT_C_ID:role/RoleC \
  --role-session-name step2-session \
  --duration-seconds 3600  # still capped at 1h total
```

Design to avoid role chaining where possible. If you need it, account for the 1-hour hard ceiling.

### 5. GitHub Actions OIDC (No Long-Lived Credentials)

The modern standard for CI/CD. GitHub Actions can assume an AWS role directly via OIDC federation — no IAM user, no stored access key.

**Setup (one-time):**
```bash
# Create the OIDC provider in your AWS account
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

**Trust policy on the IAM role:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:your-org/your-repo:*"
        }
      }
    }
  ]
}
```

Tighten the `sub` condition to restrict to a specific branch or environment:
```
"repo:your-org/your-repo:ref:refs/heads/main"
"repo:your-org/your-repo:environment:production"
```

**GitHub Actions workflow:**
```yaml
permissions:
  id-token: write   # required for OIDC
  contents: read

steps:
  - name: Configure AWS credentials
    uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsDeployRole
      aws-region: us-east-1
```

---

## CDK Patterns for Cross-Account Roles

CDK handles cross-account deployments via the `env` prop on stacks and CDK bootstrap in each target account.

**Define a cross-account stack:**
```typescript
const prodStack = new MyStack(app, 'MyStack', {
  env: {
    account: '987654321098',  // target account
    region: 'us-east-1'
  }
});
```

**CDK bootstrap in target account (run once):**
```bash
# From the target account, trust the deployment account's CDK role
cdk bootstrap aws://987654321098/us-east-1 \
  --trust 111111111111 \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

The `--trust` flag adds Account A to the trust policy of the CDKDeploymentRole in Account B. The `--cloudformation-execution-policies` controls what CloudFormation can do during deployment — scope this down from AdministratorAccess in production.

**Create a cross-account role in CDK:**
```typescript
import { Role, AccountPrincipal, ManagedPolicy } from 'aws-cdk-lib/aws-iam';

const crossAccountRole = new Role(this, 'CrossAccountRole', {
  assumedBy: new AccountPrincipal('111111111111'),  // trusts entire Account A
  // or: new ArnPrincipal('arn:aws:iam::111111111111:role/SpecificRole')
  roleName: 'ReadOnlyFromAccountA',
  description: 'Allows Account A pipeline to read S3 reports',
  maxSessionDuration: Duration.hours(4),
});

crossAccountRole.addManagedPolicy(
  ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess')
);
```

---

## SDK v3: AssumeRole + Use Temporary Credentials

```typescript
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';

// Option 1: Explicit AssumeRole then use credentials
async function assumeAndUse() {
  const sts = new STSClient({ region: 'us-east-1' });

  const { Credentials } = await sts.send(new AssumeRoleCommand({
    RoleArn: 'arn:aws:iam::987654321098:role/CrossAccountRole',
    RoleSessionName: 'my-session-name',
    DurationSeconds: 3600,
    ExternalId: 'optional-external-id',  // required if trust policy demands it
  }));

  const s3 = new S3Client({
    region: 'us-east-1',
    credentials: {
      accessKeyId: Credentials!.AccessKeyId!,
      secretAccessKey: Credentials!.SecretAccessKey!,
      sessionToken: Credentials!.SessionToken!,
      expiration: Credentials!.Expiration,
    },
  });

  const response = await s3.send(new ListObjectsV2Command({
    Bucket: 'account-b-bucket',
  }));

  return response.Contents;
}

// Option 2: Use credential provider (handles auto-refresh)
function createCrossAccountS3Client(roleArn: string) {
  return new S3Client({
    region: 'us-east-1',
    credentials: fromTemporaryCredentials({
      params: {
        RoleArn: roleArn,
        RoleSessionName: 'cross-account-session',
        DurationSeconds: 3600,
      },
      // Optional: provide explicit source credentials if not using default chain
    }),
  });
}

// The credential provider automatically calls AssumeRole and refreshes
// before expiration — prefer this over manual assume-role management
const s3 = createCrossAccountS3Client('arn:aws:iam::987654321098:role/CrossAccountRole');
```

---

## Common Mistakes

### 1. Overly Broad Trust Policies

Setting `"Principal": {"AWS": "arn:aws:iam::111111111111:root"}` trusts the entire account — any principal in that account with `sts:AssumeRole` permission can assume your role. Prefer naming the specific role ARN.

```json
// Broad — any principal in Account A with AssumeRole permission
"Principal": { "AWS": "arn:aws:iam::111111111111:root" }

// Precise — only this specific role
"Principal": { "AWS": "arn:aws:iam::111111111111:role/PipelineRole" }
```

### 2. Missing External ID for Third-Party Access

If you're granting access to a SaaS or vendor, always require an external ID in the trust policy. Without it, you're vulnerable to the confused deputy attack. The vendor should provide the external ID — if they don't, ask why.

### 3. Not Restricting Role Sessions by Source

For sensitive roles, add conditions to restrict where assume-role calls can originate:

```json
"Condition": {
  "IpAddress": {
    "aws:SourceIp": ["203.0.113.0/24"]
  }
}
```

Or restrict to calls originating from within your VPC (via a VPC endpoint):
```json
"Condition": {
  "StringEquals": {
    "aws:SourceVpc": "vpc-0123456789abcdef0"
  }
}
```

### 4. Forgetting the Identity Policy in the Calling Account

A trust policy is necessary but not sufficient. If the calling principal doesn't have an identity policy allowing `sts:AssumeRole` on the target role ARN, the call fails with `AccessDenied`. Debugging tip: check both accounts.

### 5. Role Chaining in Time-Sensitive Workflows

Role chaining caps sessions at 1 hour. If your workflow runs longer — a long batch job, a multi-stage pipeline — design around this. Options: assume the final-destination role directly (without chaining), or schedule credential refresh.

### 6. Storing Assumed Role Credentials in Code or Secrets Manager

Temporary credentials expire. Code that stores them as static values will break. Use the SDK's credential provider chain (`fromTemporaryCredentials`) which handles refresh automatically, or re-assume the role at the start of each invocation.

### 7. CloudTrail Attribution in Role Chains

When Role A assumes Role B, CloudTrail in Account B records the session as the assumed role — not the original caller. To maintain audit trails, set a meaningful `RoleSessionName` that identifies the original caller:

```typescript
RoleSessionName: `pipeline-${process.env.CI_JOB_ID}-${Date.now()}`
```

This value appears in CloudTrail as `userIdentity.sessionContext.sessionIssuer` and in the assumed-role ARN: `arn:aws:sts::ACCOUNT_B:assumed-role/RoleName/your-session-name`.
