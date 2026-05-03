---
name: secrets-kms
description: AWS Secrets Manager and KMS guidance — secret rotation, encryption keys, envelope encryption, key policies, secret versioning. Use when managing secrets, API keys, database credentials, or encryption.
metadata:
  priority: 5
  docs:
    - "https://docs.aws.amazon.com/secretsmanager/latest/userguide/"
    - "https://docs.aws.amazon.com/kms/latest/developerguide/"
  pathPatterns:
    - 'secrets/**'
    - 'encryption/**'
    - 'kms/**'
  bashPatterns:
    - '\baws\s+secretsmanager\b'
    - '\baws\s+kms\b'
  importPatterns:
    - "@aws-sdk/client-secrets-manager"
    - "@aws-sdk/client-kms"
    - "aws-cdk-lib/aws-secretsmanager"
    - "aws-cdk-lib/aws-kms"
  promptSignals:
    phrases:
      - "secrets manager"
      - "kms"
      - "encryption key"
      - "secret rotation"
      - "api key storage"
      - "database credentials"
      - "envelope encryption"
      - "cmk"
      - "customer managed key"
      - "aws secret"
---

## What It Is & When to Use It

**AWS Secrets Manager** stores, rotates, and audits secrets — database credentials, API keys, OAuth tokens, SSH keys, and any other secret your application needs at runtime. It is the right tool when the secret must rotate on a schedule, when you need audit logs of every access, or when you need to share a secret across accounts.

**AWS KMS (Key Management Service)** creates and manages cryptographic keys. It does not store secrets — it stores keys used to encrypt secrets (and data). KMS is the right tool when you need to control who can decrypt data, when you need envelope encryption for large payloads, or when compliance requires customer-managed keys.

**When to use what:**

| Need | Right Tool |
|---|---|
| Database credentials that rotate | Secrets Manager |
| API keys for third-party services | Secrets Manager |
| Config values that never change | SSM Parameter Store SecureString |
| Encryption keys for application data | KMS Customer-Managed Key |
| Encrypting S3 objects, EBS volumes, RDS | KMS (AWS-managed or CMK) |
| Temporary delegated decryption access | KMS Grants |
| Secrets shared across AWS accounts | Secrets Manager with resource policy |

**SSM Parameter Store vs Secrets Manager — the cost decision:**

- SSM Parameter Store Standard: free. SecureString (KMS-backed): $0.05 per 10k API calls.
- Secrets Manager: $0.40/secret/month + $0.05 per 10k API calls.
- Rule of thumb: if you don't need rotation and don't need cross-account sharing, use Parameter Store SecureString. If the secret rotates or requires audit trails with per-secret granularity, use Secrets Manager.

---

## Service Surface

### Secrets Manager

| Property | Value |
|---|---|
| Pricing | $0.40 per secret per month + $0.05 per 10,000 API calls |
| Secret size limit | 64 KB |
| Max secrets per account | 500,000 (soft limit, can be raised) |
| Rotation mechanism | Lambda function (AWS-provided templates or custom) |
| Rotation schedules | Fixed rate (e.g., every 30 days) or cron expression |
| Versioning labels | `AWSCURRENT`, `AWSPREVIOUS`, `AWSPENDING` (plus custom labels) |
| Replication | Cross-region replica secrets (rotation only in primary region) |
| Cross-account access | Via resource-based policy on the secret |
| Encryption | Always encrypted at rest using KMS (AWS-managed key by default, or CMK) |
| Recovery window | 7–30 days after deletion (default 30 days). Still billed during window. |

**Rotation Lambda lifecycle:**

1. `createSecret` — Lambda creates a new credential in the target service and stores it as `AWSPENDING`.
2. `setSecret` — Lambda sets the new credential on the target (e.g., updates DB password).
3. `testSecret` — Lambda verifies the `AWSPENDING` version works.
4. `finishSecret` — Secrets Manager promotes `AWSPENDING` to `AWSCURRENT` and demotes old `AWSCURRENT` to `AWSPREVIOUS`.

Applications that handle both `AWSCURRENT` and `AWSPREVIOUS` during the overlap window experience zero-downtime rotation.

### KMS

| Property | Value |
|---|---|
| Pricing (symmetric CMK) | $1.00 per key per month |
| Pricing (asymmetric CMK) | $1.00 per key per month |
| Pricing (HMAC key) | $1.00 per key per month |
| API call pricing | $0.03 per 10,000 cryptographic requests |
| AWS-managed keys | Free (e.g., `aws/s3`, `aws/rds`) — you cannot control the key policy |
| Request quotas | 5,500–30,000 requests/second per Region per account (key-type dependent) |
| Key deletion waiting period | 7–30 days (minimum, cannot be shortened below 7 days) |
| Automatic key rotation | Annual rotation for symmetric CMKs (optional; AWS rotates backing material, key ID unchanged) |
| Data key size | 256-bit AES (GenerateDataKey) |
| Maximum data encrypted directly | 4 KB. Larger data requires envelope encryption. |

**Key types:**

| Type | Use case |
|---|---|
| Symmetric (AES-256-GCM) | Default. Encryption/decryption of data, data keys, and secrets. |
| RSA asymmetric | Public-key encryption or digital signing. Key pair: public encrypts, private decrypts. |
| ECC asymmetric | Digital signing only (ECDSA). Smaller signatures than RSA. |
| HMAC | Message authentication codes. Verifiable without asymmetric infrastructure. |

**Key policy vs IAM policy:**

KMS uses a double-gate model. A KMS API call is authorized only when BOTH conditions are true:
1. The KMS key policy permits the action for the principal (or the key policy delegates to IAM).
2. The caller's IAM policy permits the action on the key.

If a key policy contains the default `"Principal": {"AWS": "arn:aws:iam::ACCOUNT_ID:root"}` statement, then IAM policies alone can grant access. If that root statement is absent, the key policy must explicitly name every principal — IAM policies alone are insufficient.

### Parameter Store SecureString vs Secrets Manager

| Feature | Parameter Store SecureString | Secrets Manager |
|---|---|---|
| Cost | Free (Standard tier) + $0.05/10k calls | $0.40/secret/month + $0.05/10k calls |
| Automatic rotation | No | Yes (Lambda-backed) |
| Cross-account sharing | No (use resource policy workaround) | Yes (native resource policy) |
| Max value size | 4 KB (Standard), 8 KB (Advanced) | 64 KB |
| Versioning | By version number | By label (AWSCURRENT, etc.) |
| Audit trail | CloudTrail (API-level) | CloudTrail + Secrets Manager console |
| Best for | Non-rotating config, feature flags, connection strings | Credentials that rotate, cross-account secrets |

---

## Mental Model

Five primitives underpin everything in Secrets Manager and KMS:

**1. Secrets Manager = secret store + rotation engine.**

A secret is a name (e.g., `prod/myapp/db`) that points to a versioned value (typically a JSON object like `{"username":"admin","password":"...","host":"..."}`). The SDK retrieves the latest value by name. Secrets Manager can call a Lambda on a schedule to generate a new credential, test it, and promote it — without your application being aware of the swap.

**2. KMS = key hierarchy.**

Three tiers of keys:

- **AWS-managed keys** (free, shared): created automatically when you enable encryption on S3, RDS, etc. You cannot see or change the key policy. Identified by aliases like `aws/s3`.
- **Customer-managed keys (CMKs)** ($1/month): you create these, you control the key policy, you can restrict usage to specific principals, you can enable/disable them. Use CMKs when you need fine-grained access control or compliance audit requirements.
- **Data keys** (ephemeral, free): generated by KMS on demand via `GenerateDataKey`. Used to encrypt your actual data locally. The data key is then encrypted by the CMK and stored alongside the encrypted data. Data keys are never stored in KMS — they exist only in memory while in use.

**3. Envelope encryption: the pattern for encrypting data larger than 4 KB.**

Direct KMS encryption is limited to 4 KB and requires sending your data to AWS over the network. Envelope encryption avoids both:

```
1. Call KMS GenerateDataKey → receive plaintext data key + encrypted data key
2. Encrypt your data locally using the plaintext data key (AES-GCM)
3. Discard the plaintext data key from memory
4. Store: [encrypted data] + [encrypted data key]

To decrypt:
1. Call KMS Decrypt with the encrypted data key → receive plaintext data key
2. Decrypt your data locally
3. Discard the plaintext data key from memory
```

Your data never leaves your process. Only the small encrypted data key travels to KMS for decryption. This is how AWS services (S3, EBS, RDS) encrypt your data internally.

**4. Key policies + IAM = double gate.**

Neither key policy alone nor IAM policy alone is sufficient. You need both to open. This means:

- Adding a principal to IAM gives nothing if the key policy doesn't allow it (unless the key policy has the root account delegation).
- Removing a principal from IAM immediately blocks access even if the key policy still allows it.
- For cross-account access: the external account's principal must be listed in the key policy AND the external IAM policy must grant access.

**5. Secret rotation lifecycle and the dual-version window.**

During rotation, two versions are live simultaneously: `AWSCURRENT` (old credential) and `AWSPENDING` (new credential, being tested). After successful testing, `AWSPENDING` becomes `AWSCURRENT` and the old `AWSCURRENT` becomes `AWSPREVIOUS`. Applications that cache credentials should accept both `AWSCURRENT` and `AWSPREVIOUS` during the window. `AWSPREVIOUS` persists until the next rotation cycle or until explicitly removed.

---

## Common Patterns

### Pattern 1: Store and retrieve a secret

**CDK — create a secret with auto-generated value:**

```typescript
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

const dbSecret = new secretsmanager.Secret(stack, 'DbSecret', {
  secretName: 'prod/myapp/db',
  description: 'RDS credentials for myapp production',
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: 'myapp_user' }),
    generateStringKey: 'password',
    excludeCharacters: '"@/\\',
    passwordLength: 32,
  },
  // Use a CMK instead of the default aws/secretsmanager key
  encryptionKey: myKmsKey,
  // Keep 7-day deletion window (minimum)
  removalPolicy: cdk.RemovalPolicy.DESTROY, // only for dev; use RETAIN in prod
});
```

**SDK v3 — retrieve and parse a secret at runtime:**

```typescript
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: 'us-east-1' });

async function getDbCredentials(): Promise<{ username: string; password: string; host: string }> {
  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: 'prod/myapp/db',
      // Omit VersionStage to get AWSCURRENT (default)
      // VersionStage: 'AWSPREVIOUS', // use during rotation if connection fails
    })
  );

  if (!response.SecretString) {
    throw new Error('Secret has no string value');
  }

  return JSON.parse(response.SecretString);
}
```

**SDK v3 — retrieve a specific version during rotation-aware access:**

```typescript
async function getCredentialsWithFallback() {
  try {
    return await getSecret('AWSCURRENT');
  } catch (err) {
    // If AWSCURRENT was just rotated and cached connections are stale,
    // AWSPREVIOUS may still be valid. Try it once.
    console.warn('AWSCURRENT failed, trying AWSPREVIOUS');
    return await getSecret('AWSPREVIOUS');
  }
}

async function getSecret(versionStage: string) {
  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: 'prod/myapp/db',
      VersionStage: versionStage,
    })
  );
  return JSON.parse(response.SecretString!);
}
```

**Production note:** Use the [AWS Secrets Manager caching client](https://github.com/aws/aws-secretsmanager-caching-java) or implement your own TTL-based cache. Direct API calls on every request add ~50ms latency and will hit rate limits under load.

---

### Pattern 2: Database credential rotation with CDK

**Single-user rotation** (the app user's password is rotated directly):

```typescript
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

// The secret and database are linked so CDK wires the rotation Lambda automatically
const dbInstance = new rds.DatabaseInstance(stack, 'Database', {
  engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
  credentials: rds.Credentials.fromGeneratedSecret('myapp_user', {
    secretName: 'prod/myapp/db',
    encryptionKey: myKmsKey,
  }),
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
});

// Attach single-user rotation — AWS provides the Lambda
dbInstance.addRotationSingleUser({
  automaticallyAfter: cdk.Duration.days(30),
  excludeCharacters: '"@/\\',
});
```

**Multi-user rotation** (uses a separate admin/superuser credential to rotate the app user):

```typescript
// Admin secret must already exist
const adminSecret = secretsmanager.Secret.fromSecretNameV2(
  stack,
  'AdminSecret',
  'prod/myapp/db-admin'
);

dbInstance.addRotationMultiUser('AppUserRotation', {
  secret: appUserSecret, // the secret being rotated
  automaticallyAfter: cdk.Duration.days(30),
  masterSecret: adminSecret, // has CREATE USER / ALTER USER privileges
});
```

Multi-user rotation is safer: it creates a clone user, tests it, then promotes it — the old user account is kept as the "previous" version. Zero connection disruption.

**The rotation Lambda needs network access.** If your RDS instance is in a private subnet, the rotation Lambda must be in the same VPC with a security group that can reach the database port. CDK handles this automatically when using `addRotationSingleUser` / `addRotationMultiUser` — but verify the Lambda's security group is in the VPC's outbound rules, and that Secrets Manager's VPC endpoint (or NAT Gateway) is reachable for the Lambda to call back to Secrets Manager.

---

### Pattern 3: Envelope encryption for application data

**CDK — create a CMK with a key policy:**

```typescript
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';

const encryptionKey = new kms.Key(stack, 'AppDataKey', {
  alias: 'prod/myapp/data',
  description: 'Encrypts myapp user PII data',
  enableKeyRotation: true, // Annual automatic rotation of key material
  removalPolicy: cdk.RemovalPolicy.RETAIN, // NEVER destroy a key with live encrypted data
  policy: new iam.PolicyDocument({
    statements: [
      // Root account retains full admin access
      new iam.PolicyStatement({
        principals: [new iam.AccountRootPrincipal()],
        actions: ['kms:*'],
        resources: ['*'],
      }),
      // App role can generate data keys and decrypt
      new iam.PolicyStatement({
        principals: [new iam.ArnPrincipal(appRole.roleArn)],
        actions: [
          'kms:GenerateDataKey',
          'kms:Decrypt',
          'kms:DescribeKey',
        ],
        resources: ['*'],
      }),
      // Audit role can only describe the key
      new iam.PolicyStatement({
        principals: [new iam.ArnPrincipal(auditRole.roleArn)],
        actions: ['kms:DescribeKey', 'kms:GetKeyPolicy'],
        resources: ['*'],
      }),
    ],
  }),
});
```

**SDK v3 — envelope encrypt a payload:**

```typescript
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const kmsClient = new KMSClient({ region: 'us-east-1' });
const KEY_ID = 'alias/prod/myapp/data';

async function encryptPayload(plaintext: Buffer): Promise<{
  encryptedData: Buffer;
  encryptedDataKey: Buffer;
  iv: Buffer;
}> {
  // 1. Ask KMS for a fresh data key
  const { Plaintext, CiphertextBlob } = await kmsClient.send(
    new GenerateDataKeyCommand({
      KeyId: KEY_ID,
      KeySpec: 'AES_256',
    })
  );

  if (!Plaintext || !CiphertextBlob) throw new Error('KMS returned empty key');

  // 2. Encrypt data locally using the plaintext data key
  const iv = randomBytes(12); // 96-bit IV for AES-256-GCM
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(Plaintext), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // 3. Wipe the plaintext data key from memory (Node doesn't have secure memory clearing,
  //    but overwriting is better than nothing)
  Plaintext.fill(0);

  return {
    encryptedData: Buffer.concat([authTag, encrypted]), // prepend auth tag
    encryptedDataKey: Buffer.from(CiphertextBlob),
    iv,
  };
}

async function decryptPayload(
  encryptedData: Buffer,
  encryptedDataKey: Buffer,
  iv: Buffer
): Promise<Buffer> {
  // 1. Ask KMS to decrypt the data key (KMS enforces key policy here)
  const { Plaintext } = await kmsClient.send(
    new DecryptCommand({
      CiphertextBlob: encryptedDataKey,
      KeyId: KEY_ID, // optional but recommended to prevent confused deputy
    })
  );

  if (!Plaintext) throw new Error('KMS returned no plaintext');

  // 2. Decrypt data locally
  const authTag = encryptedData.subarray(0, 16);
  const ciphertext = encryptedData.subarray(16);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(Plaintext), iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  Plaintext.fill(0);
  return decrypted;
}
```

---

### Pattern 4: Cross-account secret sharing

**Account A (secret owner) — add a resource policy to the secret:**

```typescript
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';

const secret = new secretsmanager.Secret(stack, 'SharedSecret', {
  secretName: 'shared/api-key',
});

// Grant Account B read access via resource policy
secret.addToResourcePolicy(
  new iam.PolicyStatement({
    principals: [new iam.AccountPrincipal('123456789012')], // Account B
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
    resources: ['*'],
    conditions: {
      // Optional: restrict to specific roles in Account B
      StringLike: {
        'aws:PrincipalArn': 'arn:aws:iam::123456789012:role/MyAppRole*',
      },
    },
  })
);

// ALSO: the KMS key encrypting the secret must allow Account B to decrypt
encryptionKey.addToResourcePolicy(
  new iam.PolicyStatement({
    principals: [new iam.AccountPrincipal('123456789012')],
    actions: ['kms:Decrypt', 'kms:DescribeKey'],
    resources: ['*'],
  })
);
```

**Account B (consumer) — IAM policy must also allow the call:**

```typescript
// Account B IAM policy for the role reading the secret
const consumerPolicy = new iam.PolicyStatement({
  actions: ['secretsmanager:GetSecretValue'],
  resources: [
    'arn:aws:secretsmanager:us-east-1:987654321098:secret:shared/api-key-??????',
  ],
});
```

**SDK v3 — retrieve the cross-account secret from Account B:**

```typescript
const response = await client.send(
  new GetSecretValueCommand({
    // Use the full ARN for cross-account access, not the name
    SecretId: 'arn:aws:secretsmanager:us-east-1:987654321098:secret:shared/api-key-AbCdEf',
  })
);
```

Cross-account access requires the full ARN. Secret names are account-scoped; ARNs are globally routable. If the secret is encrypted with a CMK (not the default aws/secretsmanager key), the CMK key policy must also grant `kms:Decrypt` to the external account — this is the #1 missed step.

---

## Gotchas

**1. Secrets Manager billing never stops during the deletion window.**
After calling `DeleteSecret`, the secret enters a recovery window (7–30 days, default 30). You continue paying $0.40/month during that window. If you delete 100 secrets and forget about them, you pay $40 for a month for secrets you aren't using. Use `--force-delete-without-recovery` in CLI or `forceDeleteWithoutRecovery: true` in SDK if you're sure — but this is irreversible with no recovery.

**2. Rotation Lambda must reach both Secrets Manager AND the target service.**
The #1 cause of rotation failures. If your database is in a private subnet with no internet access, your rotation Lambda must:
- Be deployed into the same VPC (or a peered VPC)
- Have a security group allowing outbound to the database port
- Have either a VPC endpoint for Secrets Manager (`com.amazonaws.REGION.secretsmanager`) or NAT Gateway access to call back to Secrets Manager during rotation steps

Without Secrets Manager VPC endpoint access, the Lambda can reach the database but cannot update the secret value — rotation fails silently on the `finishSecret` step.

**3. KMS key deletion is irreversible after the waiting period.**
You can schedule a KMS key for deletion (minimum 7 days, maximum 30 days). After that period, the key is permanently deleted and any data encrypted with it becomes permanently unrecoverable. There is no "AWS please restore it" path. Always set `removalPolicy: cdk.RemovalPolicy.RETAIN` on KMS keys in production CDK stacks. Before deleting, use CloudTrail to verify the key hasn't been used in 30+ days.

**4. Hitting KMS request quotas silently breaks services.**
KMS quotas are per-account per-region and vary by key type: typically 5,500–30,000 requests/second for symmetric keys. If your application calls `Decrypt` on every request (e.g., decrypting a data key per HTTP request), at scale you will throttle KMS and get `ThrottlingException`. The fix is envelope encryption with local data key caching — generate a data key, use it for a batch of operations, then discard. Use `GenerateDataKeyWithoutPlaintext` to pre-cache encrypted data keys and `Decrypt` them only when needed.

**5. Cross-region replicated secrets don't rotate from the replica.**
Secrets Manager supports replicating a secret to multiple regions for disaster recovery. However, rotation Lambdas only run in the primary region. The replica is read-only. If you need rotation in a secondary region, you must manually set up rotation there — it won't happen automatically.

**6. The default aws/secretsmanager key can't be shared cross-account.**
The default encryption key for Secrets Manager is an AWS-managed key. You cannot modify its policy. You cannot grant another account `kms:Decrypt` on it. Cross-account secret sharing requires encrypting the secret with a customer-managed KMS key and explicitly granting the external account access to that key.

**7. Secret rotation creates a new version, not a new secret.**
The secret ARN and name don't change during rotation. Only the version (and the associated credentials) changes. Applications that hardcode the secret ARN will continue to work. Applications that hardcode the secret value (e.g., read credentials at startup and never refresh) will break after rotation. Always retrieve secrets via the SDK at startup and re-fetch on authentication failures.

**8. Lambda environment variables from Secrets Manager — don't use GetSecretValue per invocation.**
A common pattern is to read a secret in every Lambda invocation via `GetSecretValueCommand`. At low volume this works; at high volume it wastes money, adds latency, and risks throttling. Instead:
- Use the [AWS Parameters and Secrets Lambda Extension](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html) (a Lambda layer): it caches secrets in the extension process and refreshes on TTL. Your Lambda reads from `http://localhost:2773/secretsmanager/get?secretId=...`.
- Or implement a module-level cache with a 5-minute TTL and refresh on 401/access denied.

**9. KMS grants vs key policies — use the right mechanism.**
Key policies define permanent access for IAM principals. KMS grants define temporary, delegatable access without modifying the key policy. Use grants when:
- An AWS service (like EBS) needs temporary access to encrypt/decrypt on your behalf
- You want to programmatically grant time-limited access (`CreateGrant` with `RetiringPrincipal` who can revoke it)
- You need to delegate decryption to a service without touching the key policy

Use key policies for: your own application roles, admin access, and any access that should be durable and auditable via key policy reviews.

**10. `DescribeSecret` does not return the secret value — and that's intentional.**
A common mistake is calling `DescribeSecret` expecting to get the secret value. `DescribeSecret` returns metadata (ARN, name, rotation configuration, tags, last changed date) but no value. Use `GetSecretValue` for the actual secret. Audit logs in CloudTrail differentiate between the two — `DescribeSecret` calls don't trigger "secret accessed" alerts in security tooling, but `GetSecretValue` calls do.

**11. Secret name uniqueness and the "secret not found after delete" trap.**
After you delete a secret (even with force delete), you cannot immediately create a new secret with the same name if it's still in the recovery window. If you need to reuse a secret name (e.g., in a redeployment pipeline), either use unique names with timestamps or wait for the full recovery window to elapse. CDK deployments that destroy and recreate secrets will fail on re-deploy until the old secret is fully purged.

**12. Automatic KMS key rotation does not re-encrypt existing data.**
Enabling annual key rotation on a CMK causes KMS to generate new backing key material each year. The old backing material is retained to decrypt data encrypted before the rotation. Your existing encrypted data is NOT re-encrypted. The key ID and ARN stay the same. To actually re-encrypt data with the new key material, you must explicitly decrypt and re-encrypt it yourself.

---

## Official Documentation

- [Secrets Manager User Guide](https://docs.aws.amazon.com/secretsmanager/latest/userguide/) — complete reference including rotation, cross-account, and replication
- [KMS Developer Guide](https://docs.aws.amazon.com/kms/latest/developerguide/) — key concepts, key policies, envelope encryption, grants
- [Rotation Lambda function templates](https://docs.aws.amazon.com/secretsmanager/latest/userguide/reference_available-rotation-templates.html) — AWS-provided templates for RDS, Redshift, DocumentDB, and custom
- [KMS key policy examples](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-overview.html) — canonical policy examples including cross-account
- [Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/)
- [KMS pricing](https://aws.amazon.com/kms/pricing/)
- [AWS Parameters and Secrets Lambda Extension](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html) — caching layer for Lambda
- [Secrets Manager best practices](https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html)
- [KMS best practices](https://docs.aws.amazon.com/kms/latest/developerguide/best-practices.html)
- [Secrets Manager SDK v3 (@aws-sdk/client-secrets-manager)](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/secrets-manager/)
- [KMS SDK v3 (@aws-sdk/client-kms)](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/kms/)
