---
name: lambda
description: AWS Lambda guidance — serverless compute, event-driven functions, runtimes, cold starts, layers, concurrency. Use when building, debugging, or optimizing Lambda functions.
metadata:
  priority: 8
  docs:
    - "https://docs.aws.amazon.com/lambda/latest/dg/"
    - "https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html"
  pathPatterns:
    - 'serverless.yml'
    - 'serverless.yaml'
    - 'serverless.ts'
    - 'template.yaml'
    - 'template.yml'
    - 'samconfig.toml'
    - 'samconfig.yaml'
    - 'lambda/**'
    - 'functions/**'
    - 'src/functions/**'
    - 'src/lambda/**'
    - 'src/handlers/**'
    - 'handlers/**'
    - 'cdk.json'
    - 'lib/*-stack.ts'
    - 'lib/*-stack.js'
    - 'stacks/**'
  bashPatterns:
    - '\baws\s+lambda\b'
    - '\bsam\s+(build|deploy|local|invoke|start-api)\b'
    - '\bcdk\s+(deploy|synth|diff|destroy)\b'
    - '\bsls\s+(deploy|invoke|offline)\b'
    - '\bserverless\s+(deploy|invoke|offline)\b'
  importPatterns:
    - "@aws-sdk/client-lambda"
    - "@middy/core"
  promptSignals:
    phrases:
      - "lambda function"
      - "cold start"
      - "serverless function"
      - "aws lambda"
      - "lambda handler"
      - "lambda layer"
      - "provisioned concurrency"
      - "lambda timeout"
      - "lambda memory"
validate:
  - pattern: 'import.*from.*[''"]aws-sdk[''"]'
    message: 'AWS SDK v2 detected — use @aws-sdk/client-lambda (v3) for tree-shaking and modular imports'
    severity: error
  - pattern: 'require\s*\(\s*[''"]aws-sdk[''"]\s*\)'
    message: 'AWS SDK v2 detected — use @aws-sdk/client-lambda (v3) for tree-shaking and modular imports'
    severity: error
  - pattern: 'callback\s*\(\s*null'
    message: 'Callback-style handler detected — use async/await pattern instead'
    severity: recommended
---

# AWS Lambda

## What It Is & When to Use It

AWS Lambda runs code in response to events without provisioning servers. You pay only for compute time consumed (per-ms billing). Use Lambda for event-driven workloads, API backends, data processing, and scheduled tasks under 15 minutes. Avoid Lambda for long-running processes, stateful workloads, or sub-100ms latency requirements where cold starts matter.

## Service Surface

| Property | Value |
|----------|-------|
| **Runtimes** | Node.js 22, Python 3.13, Java 21, .NET 8, Go (provided.al2023), Ruby 3.3, custom (container or runtime API) |
| **Memory** | 128 MB – 10,240 MB (1 MB increments). CPU scales linearly with memory. |
| **Timeout** | Max 15 minutes (900 seconds) |
| **Package size** | 50 MB zipped, 250 MB unzipped, 10 GB container image |
| **Ephemeral storage** | 512 MB default /tmp, configurable up to 10 GB |
| **Payload limits** | Sync invoke: 6 MB request + 6 MB response. Async: 1 MB. |
| **Concurrency** | 1,000 default per region (soft limit, requestable to 10,000+) |
| **Architecture** | x86_64 or arm64 (Graviton2) — ARM is 20% cheaper |
| **Pricing** | $0.20 per 1M requests + $0.0000166667/GB-s (x86) or $0.0000133334/GB-s (ARM) |
| **Free tier** | 1M requests + 400,000 GB-seconds per month |
| **SnapStart** | Java only — pre-initializes snapshots for <200ms cold starts |
| **Provisioned Concurrency** | Pre-warmed instances — eliminates cold starts but charges $0.0000041667/GB-s while provisioned |
| **Lambda@Edge** | Runs at CloudFront edge locations (viewer/origin request/response) |
| **Function URLs** | Built-in HTTPS endpoint, no API Gateway needed |

## Mental Model

**5 conceptual primitives:**

1. **Execution model**: Each invocation gets an isolated execution environment. The handler function is the entry point. Between invocations, the environment *may* be reused (warm start) — global scope persists, so initialize DB connections and SDK clients outside the handler.

2. **Invocation types**:
   - **Synchronous** (API Gateway, Function URL, SDK invoke) — caller waits for response
   - **Asynchronous** (S3 events, SNS, EventBridge) — Lambda queues internally, retries 2x on failure
   - **Event source mapping** (SQS, DynamoDB Streams, Kinesis) — Lambda polls the source

3. **Concurrency model**:
   - **Unreserved** — shared pool across all functions (default)
   - **Reserved** — guarantees concurrency for a function, caps it too (free)
   - **Provisioned** — pre-warmed instances, eliminates cold starts (costs money)
   - Burst: 500-3000 immediate (region-dependent), then +500/min

4. **Cold start lifecycle**: `Init` (download code, start runtime, run global scope) -> `Invoke` (run handler) -> ... -> `Shutdown` (after idle timeout ~5-15 min). Init is the cold start. Subsequent invocations skip Init.

5. **Layers**: Shared code/libraries packaged separately. Up to 5 layers per function, 250 MB total unzipped. Good for shared dependencies, but increase cold start time proportionally.

## Common Patterns

### API Backend (API Gateway + Lambda)
```typescript
// handler.ts — API Gateway HTTP API integration
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const { pathParameters, body } = event;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: pathParameters?.id }),
  };
};
```

### Event Processor (S3 trigger)
```typescript
import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

// Initialize outside handler for connection reuse
const s3 = new S3Client({});

export const handler = async (event: S3Event) => {
  for (const record of event.Records) {
    const { bucket, object } = record.s3;
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucket.name,
      Key: object.key,
    }));
    // Process the object...
  }
};
```

### Scheduled Task (EventBridge rule)
```typescript
// Runs on a cron schedule via EventBridge
export const handler = async () => {
  // Cleanup, reporting, data sync, etc.
  console.log('Scheduled task executed at', new Date().toISOString());
};
```

### Middleware Pattern (with Middy)
```typescript
import middy from '@middy/core';
import httpJsonBodyParser from '@middy/http-json-body-parser';
import httpErrorHandler from '@middy/http-error-handler';

const baseHandler = async (event) => {
  // event.body is already parsed JSON
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

export const handler = middy(baseHandler)
  .use(httpJsonBodyParser())
  .use(httpErrorHandler());
```

## Gotchas

1. **Cold starts by runtime**: Node.js ~200-500ms, Python ~200-400ms, Java ~2-8s (without SnapStart), .NET ~400ms-1s. ARM64 (Graviton) cold starts are comparable to x86. SnapStart reduces Java to <200ms.

2. **Memory = CPU**: Lambda allocates CPU proportional to memory. At 1,769 MB you get 1 full vCPU. Below that, CPU-bound tasks run slower. Over-provisioning memory can be *cheaper* if it reduces execution time.

3. **CloudWatch Logs cost**: Lambda auto-logs to CloudWatch. At scale, logs ingestion ($0.50/GB) can exceed Lambda compute cost. Set log retention policies and use structured logging with appropriate log levels.

4. **Handler reuse (warm starts)**: Global scope persists between invocations. Initialize SDK clients, DB connections, and heavy objects outside the handler. But don't cache user-specific data globally — it leaks between requests.

5. **VPC cold starts**: Lambda in a VPC used to add 10-30s. With Hyperplane ENIs (since 2019), first invocation in a new ENI takes ~1-2s, subsequent invocations are fast. Still slower than non-VPC. Use VPC only when you need private resource access.

6. **Payload limits**: 6 MB for synchronous invocation (request AND response), 1 MB for asynchronous. For larger payloads, use S3 presigned URLs or Step Functions.

7. **Recursive invocation protection**: Lambda now detects and stops recursive loops (Lambda -> SQS -> Lambda) after ~16 invocations. This prevents runaway costs but can break legitimate patterns — use dead letter queues.

8. **Provisioned Concurrency costs when idle**: You pay for provisioned instances even with zero traffic. Use Application Auto Scaling to schedule provisioned concurrency for predictable traffic patterns.

9. **ARM64 (Graviton)**: 20% cheaper per GB-second, and often faster for Node.js/Python. No code changes needed for interpreted languages. Compiled languages need ARM builds. Always default to ARM64 unless you have x86 binary dependencies.

10. **10 GB /tmp isn't free**: Ephemeral storage beyond 512 MB costs $0.0000000309/GB-s. At 10 GB, that's ~$0.000000278/s. Small per-invocation but adds up for long-running functions.

11. **1,000 concurrent execution default**: Shared across ALL functions in a region. A traffic spike in one function can throttle all others. Use reserved concurrency for critical functions.

12. **Function URLs vs API Gateway**: Function URLs are free and simpler but lack throttling, request validation, API keys, and usage plans. Use API Gateway for production APIs that need these features.

## Official Documentation

- [Lambda Developer Guide](https://docs.aws.amazon.com/lambda/latest/dg/)
- [Lambda Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)
- [Lambda Quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [Lambda Pricing](https://aws.amazon.com/lambda/pricing/)
- [Serverless Land Patterns](https://serverlessland.com/patterns)
