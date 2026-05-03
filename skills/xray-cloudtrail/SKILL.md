---
name: xray-cloudtrail
description: AWS X-Ray and CloudTrail guidance — distributed tracing, service maps, audit logging, event history, compliance. Use when debugging distributed systems or auditing AWS API activity.
metadata:
  priority: 4
  docs:
    - "https://docs.aws.amazon.com/xray/latest/devguide/"
    - "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/"
  pathPatterns:
    - 'tracing/**'
    - 'audit/**'
  bashPatterns:
    - '\baws\s+xray\b'
    - '\baws\s+cloudtrail\b'
  importPatterns:
    - "@aws-sdk/client-xray"
    - "@aws-sdk/client-cloudtrail"
    - "aws-xray-sdk"
  promptSignals:
    phrases:
      - "x-ray"
      - "xray"
      - "cloudtrail"
      - "distributed tracing"
      - "service map"
      - "audit log"
      - "api activity"
      - "trace"
---

# AWS X-Ray and CloudTrail

## What It Is & When to Use It

X-Ray and CloudTrail are both observability tools, but they answer completely different questions.

**X-Ray = "Where is my request slow?"**
X-Ray traces the journey of a single request as it moves through your distributed system — Lambda to API Gateway to DynamoDB to SQS and back. It builds service maps, measures latency at each hop, surfaces errors, and helps you find the bottleneck. It is a developer-facing, application-layer tool. It sees what your code does.

**CloudTrail = "Who changed my infrastructure?"**
CloudTrail records every AWS API call made in your account — who called it, when, from which IP, with what parameters, and whether it succeeded. CreateBucket, DeleteFunction, AssumeRole — every control-plane action is logged. It is a security and compliance tool. It sees what humans and services do to AWS itself.

Use X-Ray when a request is taking too long or failing intermittently and you need to find why. Use CloudTrail when a resource was modified unexpectedly, credentials may have been misused, or you need an audit trail for compliance.

They are complementary. A production incident often requires both: X-Ray to find the failing service, CloudTrail to see if someone recently changed its IAM role or configuration.

---

## Service Surface

### Traces, Segments, and Subsegments

A **trace** is the complete record of a single request end-to-end. It has a unique trace ID that propagates through every service via the `X-Amzn-Trace-Id` HTTP header.

A **segment** is the record produced by one service in that journey. If your request hits API Gateway, Lambda, and DynamoDB, you get three segments.

A **subsegment** is a finer-grained unit within a segment. Inside your Lambda function you might create subsegments for each downstream HTTP call, each database query, or each logical block you want to time independently.

**Annotations** are key-value pairs indexed for filtering. They are how you search traces: `annotation.userId = "u_123"` or `annotation.environment = "production"`. Limit: 50 annotations per trace. Use them for high-cardinality identifiers you will actually filter on.

**Metadata** is key-value data stored with the trace but not indexed. Use it for large payloads, debugging context, or anything you want to inspect but not search. No practical size limit beyond the overall segment size cap.

### Service Maps

X-Ray builds an interactive service map from trace data — a graph showing every node in your architecture and the edges between them. Each edge shows request rate, error rate, and latency percentiles. Nodes turn red when error rates spike. This is the fastest way to visually identify which service in a chain is introducing latency or errors.

Service maps are generated automatically from traces. You do not configure them — they emerge from your instrumentation.

### Sampling Rules

X-Ray does not record every request by default. Sampling is the mechanism that controls what percentage of requests generate a full trace. This is a critical operational fact: **you will miss requests**. This is by design and necessary at scale — full tracing of every request at high throughput is expensive and often unnecessary.

Default rule: 1 request per second + 5% of additional requests.

Custom rules let you override by service name, HTTP method, URL path, host, resource ARN, or annotation. You can set a fixed rate (e.g., 10% of all POST requests to `/checkout`) or a reservoir (e.g., always trace the first 50 requests per second, then 1% beyond that).

For critical low-traffic paths (payment processing, auth flows), increase sampling to 100%. For high-traffic health checks or static assets, reduce to near zero.

---

## Mental Model

### Event Types

**Management events** (control plane): Actions on AWS resources — creating, modifying, deleting. CreateBucket, RunInstances, PutRolePolicy, DeleteFunction. These are enabled by default and free for the first copy of events in each region delivered to CloudWatch Logs or S3.

**Data events** (data plane): Actions on data within resources — S3 object reads and writes (GetObject, PutObject), Lambda function invocations, DynamoDB item-level operations. These are high-volume and must be explicitly enabled. They cost $0.10 per 100,000 events.

**Insights events**: Anomaly detection. CloudTrail Insights watches your management event volume and alerts when API call rates deviate significantly from baseline. Useful for detecting credential abuse (sudden spike in DescribeInstances calls) or misconfigurations. Costs $0.35 per 100,000 events analyzed.

### Trails vs Event History

**Event History** is free, automatic, and always on. It stores the last 90 days of management events for your account in each region. Accessible from the CloudTrail console. Not configurable, not queryable with custom filters beyond basic search.

**Trails** are what you create to get events into S3, CloudWatch Logs, or CloudTrail Lake for long-term retention, cross-account aggregation, or complex querying. A trail can be regional or multi-region. An **organization trail** captures all accounts in your AWS Organization from the management account.

For compliance, create a multi-region organization trail that writes to a dedicated logging account's S3 bucket with object lock enabled. This prevents tampering even if the workload account is compromised.

### CloudTrail Lake

CloudTrail Lake is a managed event data store that lets you run SQL queries against CloudTrail events without managing Athena + S3 yourself. Retention is configurable (7 days to 7 years). Queries are charged by data scanned — be precise with your WHERE clauses. A broad query against a large organization trail can cost real money.

---

## Common Patterns

### Lambda + X-Ray (Active Tracing)

Enable active tracing on a Lambda function so it automatically creates a trace for every invocation:

```typescript
// CDK
import { Function, Tracing } from "aws-cdk-lib/aws-lambda";

const fn = new Function(this, "MyFunction", {
  tracing: Tracing.ACTIVE,
  // ... other props
});
```

```bash
# CLI
aws lambda update-function-configuration \
  --function-name my-function \
  --tracing-config Mode=Active
```

Active tracing gives you automatic segments for the Lambda invocation itself, including initialization time vs handler time. It does not automatically instrument your downstream calls — for those you need the X-Ray SDK.

**Cold start overhead:** Active tracing adds approximately 35ms to cold starts due to the X-Ray daemon initializing. This is a real cost for latency-sensitive APIs. Consider PassThrough tracing mode for functions where cold start latency is critical and you have other observability.

### Custom Subsegments with the SDK

```typescript
import AWSXRay from "aws-xray-sdk";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

// Wrap the entire AWS SDK client to auto-instrument all calls
const dynamodb = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));

async function getUserRecord(userId: string) {
  // Create a manual subsegment for a logical block
  const segment = AWSXRay.getSegment();
  const subsegment = segment?.addNewSubsegment("getUserRecord");

  try {
    // Add searchable annotation
    subsegment?.addAnnotation("userId", userId);
    // Add non-indexed metadata
    subsegment?.addMetadata("requestContext", { source: "api", version: 2 });

    const result = await dynamodb.send(
      new GetItemCommand({
        TableName: "Users",
        Key: { PK: { S: `USER#${userId}` } },
      })
    );

    subsegment?.close();
    return result.Item;
  } catch (err) {
    subsegment?.addError(err as Error);
    subsegment?.close();
    throw err;
  }
}
```

`captureAWSv3Client` wraps an AWS SDK v3 client so every command it sends automatically creates a subsegment with the service name, operation, response status, and latency. This is the highest-leverage instrumentation you can do — one line gives you visibility into all DynamoDB, S3, SQS, SNS, and other SDK calls.

### Querying Traces with the SDK

```typescript
import {
  XRayClient,
  GetTraceSummariesCommand,
  BatchGetTracesCommand,
  GetServiceGraphCommand,
} from "@aws-sdk/client-xray";

const xray = new XRayClient({ region: "us-east-1" });

// Find traces with errors in the last hour
async function getErrorTraces() {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);

  const summaries = await xray.send(
    new GetTraceSummariesCommand({
      StartTime: start,
      EndTime: end,
      FilterExpression: 'error = true AND annotation.environment = "production"',
      Sampling: false, // get all matching traces, not a sample
    })
  );

  return summaries.TraceSummaries ?? [];
}

// Fetch full trace details for specific trace IDs
async function getTraceDetails(traceIds: string[]) {
  const result = await xray.send(
    new BatchGetTracesCommand({ TraceIds: traceIds })
  );
  return result.Traces ?? [];
}

// Get service map for the last 30 minutes
async function getServiceMap() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60 * 1000);

  const graph = await xray.send(
    new GetServiceGraphCommand({ StartTime: start, EndTime: end })
  );

  return graph.Services ?? [];
}
```

Filter expressions support boolean logic, comparison operators, and functions: `responsetime > 2`, `service("my-function")`, `http.status = 500`, `annotation.key = "value"`.

### CloudTrail Queries with the SDK

```typescript
import {
  CloudTrailClient,
  LookupEventsCommand,
  GetTrailStatusCommand,
  DescribeTrailsCommand,
} from "@aws-sdk/client-cloudtrail";

const cloudtrail = new CloudTrailClient({ region: "us-east-1" });

// Look up recent events for a specific resource
async function getEventsForResource(resourceArn: string) {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days

  const events = await cloudtrail.send(
    new LookupEventsCommand({
      StartTime: start,
      EndTime: end,
      LookupAttributes: [
        {
          AttributeKey: "ResourceName",
          AttributeValue: resourceArn,
        },
      ],
      MaxResults: 50,
    })
  );

  return events.Events ?? [];
}

// Look up events by a specific IAM user or role
async function getEventsByPrincipal(username: string) {
  const events = await cloudtrail.send(
    new LookupEventsCommand({
      LookupAttributes: [
        {
          AttributeKey: "Username",
          AttributeValue: username,
        },
      ],
      MaxResults: 100,
    })
  );

  return (events.Events ?? []).map((e) => ({
    eventName: e.EventName,
    eventTime: e.EventTime,
    sourceIPAddress: e.CloudTrailEvent
      ? JSON.parse(e.CloudTrailEvent).sourceIPAddress
      : null,
    errorCode: e.CloudTrailEvent
      ? JSON.parse(e.CloudTrailEvent).errorCode
      : null,
  }));
}

// Check trail health
async function checkTrailHealth(trailArn: string) {
  const status = await cloudtrail.send(
    new GetTrailStatusCommand({ Name: trailArn })
  );

  return {
    isLogging: status.IsLogging,
    latestDeliveryTime: status.LatestDeliveryTime,
    latestDeliveryError: status.LatestDeliveryError,
    latestDigestDeliveryTime: status.LatestDigestDeliveryTime,
  };
}
```

`LookupEvents` covers the last 90 days of management events and supports one filter attribute at a time. For multi-attribute filtering or longer retention, use CloudTrail Lake or Athena against your S3 trail bucket.

---



Custom sampling rules let you tune observability cost vs coverage. Manage them as code rather than via the console to keep configuration reproducible.

```typescript
import {
  XRayClient,
  CreateSamplingRuleCommand,
  UpdateSamplingRuleCommand,
  GetSamplingRulesCommand,
  DeleteSamplingRuleCommand,
} from "@aws-sdk/client-xray";

const xray = new XRayClient({ region: "us-east-1" });

// Create a rule that always traces payment endpoint calls
async function createPaymentTracingRule() {
  await xray.send(
    new CreateSamplingRuleCommand({
      SamplingRule: {
        RuleName: "PaymentEndpoints",
        Priority: 100, // lower number = higher priority; default rule is 10000
        ReservoirSize: 10, // always trace first 10 req/sec unconditionally
        FixedRate: 1.0, // then trace 100% of remaining requests
        URLPath: "/payments/*",
        HTTPMethod: "POST",
        Host: "*",
        ServiceName: "*",
        ServiceType: "*",
        ResourceARN: "*",
        Version: 1,
      },
    })
  );
}

// Create a rule that suppresses tracing for health checks
async function createHealthCheckRule() {
  await xray.send(
    new CreateSamplingRuleCommand({
      SamplingRule: {
        RuleName: "HealthCheckSuppression",
        Priority: 50,
        ReservoirSize: 0,
        FixedRate: 0.0, // never trace health checks
        URLPath: "/health",
        HTTPMethod: "GET",
        Host: "*",
        ServiceName: "*",
        ServiceType: "*",
        ResourceARN: "*",
        Version: 1,
      },
    })
  );
}

// List all rules to audit current configuration
async function listSamplingRules() {
  const result = await xray.send(new GetSamplingRulesCommand({}));
  return (result.SamplingRuleRecords ?? [])
    .map((r) => r.SamplingRule)
    .sort((a, b) => (a?.Priority ?? 0) - (b?.Priority ?? 0));
}
```

Rules are evaluated in priority order (lowest number first). The first matching rule wins. The built-in Default rule (priority 10000) catches everything not matched by a custom rule. Always leave the Default rule in place — removing it disables tracing for unmatched requests entirely.

---

## Gotchas

CloudTrail Lake stores events in a managed event data store and lets you run SQL against them. This is significantly faster and easier than Athena + S3 for ad-hoc investigations, but costs more per query.

```typescript
import {
  CloudTrailClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  DescribeQueryCommand,
} from "@aws-sdk/client-cloudtrail";

const cloudtrail = new CloudTrailClient({ region: "us-east-1" });

const EVENT_DATA_STORE_ARN =
  "arn:aws:cloudtrail:us-east-1:123456789012:eventdatastore/EXAMPLE-f852-4e8f-8bd1-EXAMPLE";

// Find all DeleteFunction calls in the last 24 hours
async function findRecentDeletions() {
  const query = await cloudtrail.send(
    new StartQueryCommand({
      QueryStatement: `
        SELECT
          eventTime,
          userIdentity.arn,
          requestParameters,
          sourceIPAddress,
          errorCode,
          errorMessage
        FROM ${EVENT_DATA_STORE_ARN}
        WHERE
          eventName = 'DeleteFunction'
          AND eventTime > '2026-05-01 00:00:00'
        ORDER BY eventTime DESC
        LIMIT 100
      `,
    })
  );

  return pollQueryResults(query.QueryId!);
}

// Detect potential credential abuse: find principals making unusual numbers of Describe calls
async function detectDescribeSpike(principalArn: string) {
  const query = await cloudtrail.send(
    new StartQueryCommand({
      QueryStatement: `
        SELECT
          eventName,
          COUNT(*) as callCount,
          MIN(eventTime) as firstSeen,
          MAX(eventTime) as lastSeen
        FROM ${EVENT_DATA_STORE_ARN}
        WHERE
          userIdentity.arn = '${principalArn}'
          AND eventName LIKE 'Describe%'
          AND eventTime > '2026-05-01 00:00:00'
        GROUP BY eventName
        ORDER BY callCount DESC
      `,
    })
  );

  return pollQueryResults(query.QueryId!);
}

async function pollQueryResults(queryId: string): Promise<unknown[]> {
  // Poll until complete
  while (true) {
    const status = await cloudtrail.send(
      new DescribeQueryCommand({ QueryId: queryId })
    );

    if (status.QueryStatus === "FINISHED") break;
    if (status.QueryStatus === "FAILED" || status.QueryStatus === "CANCELLED") {
      throw new Error(`Query ${status.QueryStatus}: ${status.ErrorMessage}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const results: unknown[] = [];
  let nextToken: string | undefined;

  do {
    const page = await cloudtrail.send(
      new GetQueryResultsCommand({ QueryId: queryId, NextToken: nextToken })
    );
    results.push(...(page.QueryResultRows ?? []));
    nextToken = page.NextToken;
  } while (nextToken);

  return results;
}
```

Cost warning: CloudTrail Lake charges by data scanned. Always filter by `eventTime` first — it is the partition key and dramatically reduces scan volume. Adding `eventSource` or `eventName` filters further narrows the scan. Avoid `SELECT *` on large event stores without tight time bounds.

---

## Gotchas

**X-Ray sampling gaps are normal and expected.** If you are debugging a specific failing request and cannot find its trace, it may have been sampled out. For investigation, temporarily set a 100% sampling rule scoped to the relevant service and path, reproduce the issue, then revert. Never run 100% sampling on high-traffic production services indefinitely — it will generate significant cost and load on the X-Ray service.

**Lambda X-Ray cold start overhead (~35ms) is real but often acceptable.** The X-Ray daemon runs as a separate process in the Lambda execution environment and initializes on cold start. For a function called rarely or on background tasks, this is irrelevant. For a latency-sensitive API where p99 cold start is a product metric, set tracing to PassThrough and use structured logging + CloudWatch for observability instead.

**CloudTrail has a 15-minute delivery delay.** Events are not real-time. The trail delivers log files to S3 in batches, typically within 15 minutes but sometimes longer. Do not use CloudTrail for real-time alerting without CloudWatch Events integration — subscribe your trail to a CloudWatch Logs log group, then create metric filters and alarms on that log group for near-real-time detection of specific events.

**X-Ray traces have a 30-day retention period.** You cannot extend this. If you need traces for longer (post-incident review weeks later, compliance), export relevant trace summaries or use a third-party APM tool (Datadog, Honeycomb, Grafana Tempo) that ingests X-Ray data and provides configurable retention.

**CloudTrail event history covers only 90 days.** For compliance requirements that mandate longer retention (PCI DSS, SOC 2, HIPAA often require 1-7 years), you must create a trail writing to S3 with appropriate lifecycle policies and bucket versioning. Do not rely on event history for compliance evidence.

**CloudTrail Lake queries are priced per byte scanned, not per query.** A single poorly-written query against a large event data store can cost $10-50+. Scope all queries with `eventTime` ranges as tight as possible. Test against a small time window before widening. For recurring queries, consider scheduled Athena queries against your S3 trail bucket instead — Athena can be cheaper at scale if you partition the S3 data correctly.

**Multi-region trails capture global service events automatically.** IAM, STS, and Route 53 are global services whose events are always logged to us-east-1 regardless of where you operate. When you create a multi-region trail, it automatically includes global service events. When you create regional trails, you may miss IAM events unless you specifically enable global service event logging on your us-east-1 trail.

**X-Ray service maps can show stale edges after deployments.** Service map data is cached and aggregated. After a significant architectural change (removing a downstream dependency, renaming a service), old edges may persist in the service map for up to an hour. Do not use the service map as a definitive record of your current architecture — use it for operational debugging, not documentation.

**Propagate trace context across async boundaries manually.** When a Lambda function publishes to SQS and another Lambda consumes it, X-Ray can link the traces automatically only if the trace header is preserved in the message attributes. The X-Ray SDK does this automatically for SNS and some SQS patterns, but for manual SQS sends, include the `X-Amzn-Trace-Id` message attribute explicitly:

```typescript
import AWSXRay from "aws-xray-sdk";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = AWSXRay.captureAWSv3Client(new SQSClient({}));

await sqs.send(
  new SendMessageCommand({
    QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/my-queue",
    MessageBody: JSON.stringify(payload),
    MessageAttributes: {
      "X-Amzn-Trace-Id": {
        DataType: "String",
        StringValue: AWSXRay.getSegment()?.trace_id ?? "",
      },
    },
  })
);
```

Without this, the consumer trace will start a fresh root trace with no connection to the producer — your service map will show two disconnected invocations instead of a connected flow.
## Official Documentation

| Resource | URL |
|---|---|
| X-Ray Developer Guide | https://docs.aws.amazon.com/xray/latest/devguide/ |
| CloudTrail User Guide | https://docs.aws.amazon.com/awscloudtrail/latest/userguide/ |
| X-Ray SDK v3 | https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/xray/ |
| CloudTrail SDK v3 | https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cloudtrail/ |
| X-Ray Pricing | https://aws.amazon.com/xray/pricing/ |
| CloudTrail Pricing | https://aws.amazon.com/cloudtrail/pricing/ |
