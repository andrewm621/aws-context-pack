---
name: s3
description: Amazon S3 guidance — object storage, storage classes, access patterns, presigned URLs, event notifications, lifecycle policies. Use when working with S3 buckets, objects, or file uploads.
metadata:
  priority: 8
  docs:
    - "https://docs.aws.amazon.com/AmazonS3/latest/userguide/"
    - "https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html"
  pathPatterns:
    - 's3/**'
    - 'storage/**'
    - 'uploads/**'
    - 'buckets/**'
  bashPatterns:
    - '\baws\s+s3\b'
    - '\baws\s+s3api\b'
    - '\baws\s+s3control\b'
  importPatterns:
    - "@aws-sdk/client-s3"
    - "@aws-sdk/s3-request-presigner"
    - "@aws-sdk/lib-storage"
  promptSignals:
    phrases:
      - "s3 bucket"
      - "s3 upload"
      - "presigned url"
      - "object storage"
      - "storage class"
      - "s3 lifecycle"
      - "s3 event"
      - "s3 transfer"
      - "glacier"
      - "intelligent tiering"
validate:
  - pattern: 'import.*from.*[''"]aws-sdk[''"]'
    message: 'AWS SDK v2 detected — use @aws-sdk/client-s3 (v3) for tree-shaking'
    severity: error
  - pattern: 'new AWS\.S3\('
    message: 'AWS SDK v2 S3 constructor — use new S3Client({}) from @aws-sdk/client-s3'
    severity: error
  - pattern: '\.putObject\('
    message: 'SDK v2 method style — use s3.send(new PutObjectCommand(params)) in v3'
    severity: recommended
---

# Amazon S3

## What It Is & When to Use It

Amazon S3 (Simple Storage Service) is object storage with virtually unlimited capacity, 99.999999999% (11 9s) durability, and strong read-after-write consistency. Use S3 for file storage, static website hosting, data lakes, backups, and as a data source for event-driven processing. It's the universal storage layer of AWS.

## Service Surface

| Property | Value |
|----------|-------|
| **Max object size** | 5 TB (multipart upload required above 5 GB) |
| **Max buckets per account** | 100 (soft limit, requestable to 1,000) |
| **Max object key length** | 1,024 bytes |
| **Consistency** | Strong read-after-write for PUTs and DELETEs (since Dec 2020) |
| **Request rate** | 3,500 PUT/COPY/POST/DELETE + 5,500 GET/HEAD per second per prefix |
| **Bucket names** | Globally unique, 3-63 characters, lowercase + hyphens + dots |

### Storage Classes & Pricing (US East)

| Class | Storage $/GB | PUT $/1K | GET $/1K | Retrieval | Min Duration |
|-------|-------------|----------|----------|-----------|-------------|
| **Standard** | $0.023 | $0.005 | $0.0004 | — | — |
| **Intelligent-Tiering** | $0.023-0.0025 | $0.005 | $0.0004 | — | — |
| **Standard-IA** | $0.0125 | $0.01 | $0.001 | $0.01/GB | 30 days |
| **One Zone-IA** | $0.01 | $0.01 | $0.001 | $0.01/GB | 30 days |
| **Glacier Instant** | $0.004 | $0.02 | $0.01 | $0.03/GB | 90 days |
| **Glacier Flexible** | $0.0036 | $0.03 | $0.0004 | $0.01-0.03/GB | 90 days |
| **Glacier Deep Archive** | $0.00099 | $0.05 | $0.0004 | $0.02/GB | 180 days |
| **Express One Zone** | $0.16 | $0.0025 | $0.0002 | — | — |

**Data transfer**: $0.09/GB out to internet (first 100 GB free). Free within same region to CloudFront. Cross-region: $0.02/GB.

## Mental Model

1. **Object storage, not filesystem**: Objects are stored with a flat key (e.g., `photos/2024/cat.jpg`). The `/` is just a character — there are no real directories. The console shows "folders" as a convenience over key prefixes.

2. **Strong consistency**: As of Dec 2020, S3 provides strong read-after-write consistency for all operations. After a PUT succeeds, a subsequent GET immediately returns the new object. After a DELETE, a GET immediately returns 404. This applies to overwrites too.

3. **Access control layers** (evaluated in order of precedence):
   - **Block Public Access** (account/bucket level) — override that blocks public access regardless of other policies
   - **Bucket policies** (resource-based) — primary way to control access
   - **IAM policies** (identity-based) — who can do what
   - **ACLs** (legacy) — deprecated, use BucketOwnerEnforced ownership
   - **Access Points** — named network endpoints with their own policies

4. **Event-driven**: S3 can trigger Lambda, SQS, SNS, or EventBridge on object creation, deletion, and other events. Design handlers for idempotency — notifications can be delivered more than once.

5. **Performance by prefix**: S3 partitions data by prefix. Each prefix supports 3,500 writes + 5,500 reads per second. For high-throughput workloads, distribute objects across multiple prefixes (e.g., add hash prefix).

## Common Patterns

### Presigned URL for Direct Upload
```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});

async function generateUploadUrl(key: string, contentType: string) {
  const command = new PutObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  // URL valid for 15 minutes
  return getSignedUrl(s3, command, { expiresIn: 900 });
}
```

### Event-Driven Processing
```typescript
import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

export const handler = async (event: S3Event) => {
  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const response = await s3.send(new GetObjectCommand({
      Bucket: record.s3.bucket.name,
      Key: key,
    }));
    const body = await response.Body?.transformToString();
    // Process the object...
  }
};
```

### Lifecycle Policy (CDK)
```typescript
import { Bucket, StorageClass, LifecycleRule } from 'aws-cdk-lib/aws-s3';

const bucket = new Bucket(this, 'DataBucket', {
  lifecycleRules: [
    {
      transitions: [
        { storageClass: StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) },
        { storageClass: StorageClass.GLACIER, transitionAfter: Duration.days(90) },
      ],
      expiration: Duration.days(365),
      abortIncompleteMultipartUploadAfter: Duration.days(7),
    },
  ],
});
```

### Static Website with CloudFront (CDK)
```typescript
import { Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';

const distribution = new Distribution(this, 'CDN', {
  defaultBehavior: {
    origin: S3BucketOrigin.withOriginAccessControl(bucket),
    viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
  defaultRootObject: 'index.html',
});
```

## Gotchas

1. **LIST requests are expensive**: $5.00 per 1 million LIST requests (10x more than GET). If you're listing buckets with millions of objects frequently, use S3 Inventory instead ($0.0025 per million objects listed).

2. **Data transfer OUT costs**: $0.09/GB to internet adds up fast. Serve through CloudFront ($0.085/GB but with caching) or use VPC Gateway Endpoints (free) for EC2/Lambda access within the same region.

3. **Request rate per prefix**: 3,500 PUT + 5,500 GET per second per prefix. For high-throughput workloads, distribute keys across prefixes. S3 auto-partitions, but initial bursts may get throttled.

4. **Bucket names are global and permanent**: Once created, a bucket name is reserved globally. Deleted bucket names can't be reused immediately. Don't put sensitive info in bucket names.

5. **ACLs are deprecated**: Use `BucketOwnerEnforced` object ownership (the default for new buckets). This disables ACLs entirely. Use bucket policies for all access control.

6. **Event notifications can duplicate**: S3 event notifications deliver at least once. Design consumers to be idempotent (check if already processed before acting).

7. **Incomplete multipart uploads accumulate cost**: If uploads fail midway, parts remain and incur storage charges. Always set an `AbortIncompleteMultipartUpload` lifecycle rule (7 days is common).

8. **KMS encryption adds cost and rate limits**: SSE-KMS adds $0.03 per 10,000 encrypt/decrypt API calls and KMS has rate limits (5,500–30,000 req/s per region). Use SSE-S3 (AES-256) for most use cases — it's free and has no rate limits.

9. **S3 Select/Glacier Select**: Query CSV/JSON/Parquet in place. Can reduce data scanned by 80%+ but has limited SQL support. For complex queries, use Athena.

10. **Cross-region replication latency**: Most objects replicate within 15 minutes, but there's no SLA. Use S3 Replication Time Control (S3 RTC) for 99.99% within 15 minutes ($0.015/GB).

11. **Public access blocks cascade**: Account-level Block Public Access overrides bucket-level settings. Check both levels when debugging access issues.

12. **Versioning can't be disabled**: Once enabled, versioning can only be suspended (not disabled). All previous versions remain and incur storage costs. Use lifecycle rules to expire non-current versions.

## Official Documentation

- [S3 User Guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/)
- [S3 Performance Optimization](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)
- [S3 Pricing](https://aws.amazon.com/s3/pricing/)
- [S3 Storage Classes](https://aws.amazon.com/s3/storage-classes/)
