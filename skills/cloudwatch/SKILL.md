---
name: cloudwatch
description: Amazon CloudWatch guidance — metrics, logs, alarms, dashboards, Logs Insights, custom metrics, anomaly detection. Use when setting up monitoring, debugging with logs, or creating alerts.
metadata:
  priority: 6
  docs:
    - "https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/"
  pathPatterns:
    - 'monitoring/**'
    - 'observability/**'
    - 'dashboards/**'
    - 'alarms/**'
  bashPatterns:
    - '\baws\s+cloudwatch\b'
    - '\baws\s+logs\b'
  importPatterns:
    - "@aws-sdk/client-cloudwatch"
    - "@aws-sdk/client-cloudwatch-logs"
  promptSignals:
    phrases:
      - "cloudwatch"
      - "cloudwatch logs"
      - "cloudwatch alarm"
      - "cloudwatch metric"
      - "logs insights"
      - "custom metric"
      - "cloudwatch dashboard"
      - "log group"
      - "metric filter"
      - "cloudwatch anomaly"
---

## What It Is & When to Use It

CloudWatch is AWS's built-in observability platform — it covers metrics, logs, alarms, dashboards, and synthetic monitoring across every AWS service. Every managed service (Lambda, ECS, RDS, API Gateway, DynamoDB, etc.) emits metrics to CloudWatch automatically with zero configuration. You pay only for what you use, but the cost model has several sharp edges (see Gotchas).

**Use CloudWatch when you need to:**
- Monitor AWS service health via built-in metrics (CPU, latency, error rates, throttling)
- Collect application logs from Lambda, ECS, EC2, or on-premises servers via the CloudWatch Agent
- Alert on threshold breaches, anomalies, or composite conditions via Alarms
- Query and analyze logs interactively or programmatically via Logs Insights
- Emit custom business metrics (orders placed, payment failures, queue depth) from application code
- Build operational dashboards for teams or stakeholders
- Verify endpoint availability with synthetic canaries (CloudWatch Synthetics)

**Prefer a different tool when:**
- You need full-text search across logs with rich filtering — OpenSearch is better suited
- You need distributed tracing across service boundaries — use X-Ray (though CloudWatch Service Lens integrates both)
- You need long-term metric storage beyond 15 months — export to S3 and query with Athena

---

## Service Surface

| Component | What It Does | Pricing (us-east-1) |
|---|---|---|
| **Metrics** | Time-series data points for AWS services and custom sources. 1-second to 1-day granularity. Free tier: 10 custom metrics, 1M API requests/month. | First 10k custom metrics: $0.30/metric/month. High-resolution (1s): $0.30/metric/month additional. AWS namespace metrics: free. |
| **Logs** | Log Groups → Log Streams → Log Events. Centralized storage for application, infrastructure, and audit logs. | Ingestion: $0.50/GB. Storage: $0.03/GB/month. No charge for AWS service log delivery (e.g., VPC Flow Logs → CW). |
| **Alarms** | Threshold or anomaly-based alerting on any metric. SNS, Lambda, EC2 Auto Scaling, or Systems Manager actions. | Standard: $0.10/alarm/month. High-resolution: $0.30/alarm/month. Composite alarms: $0.50/alarm/month. |
| **Dashboards** | Managed, shareable operational dashboards. Up to 500 metrics per dashboard. | $3.00/dashboard/month. First 3 dashboards: free. |
| **Logs Insights** | SQL-like interactive query language for logs. Scans compressed data — much faster than iterating streams. | $0.005/GB scanned. |
| **Contributor Insights** | Identifies top contributors to traffic or errors (e.g., top 10 IPs causing 5xx errors). | $0.90/rule/month + $0.02/1M log events matched. |
| **Metric Streams** | Real-time metric streaming to Kinesis Data Firehose → S3, Datadog, Splunk, New Relic. | $0.003/1k metric updates streamed. |
| **Synthetics** | Headless Chromium canaries that run scripted checks on your endpoints. Detects availability and broken flows before users do. | $0.0012/canary run. A 1-minute canary = ~$52/month. |
| **RUM (Real User Monitoring)** | JavaScript snippet captures real user performance data (Core Web Vitals, JS errors, HTTP failures). | $1.00/100k RUM events. |
| **Evidently** | Feature flagging and A/B experimentation with CloudWatch metrics integration. | $5.00/100k feature evaluations. |
| **Anomaly Detection** | ML band applied to any metric. Alarm triggers when metric falls outside predicted band. | $0.10/model/month (each metric + stat combination = 1 model). |
| **CloudWatch Agent** | Daemon for EC2/on-premises. Collects custom metrics (disk, memory — not built-in) and ships logs. | Free (pay for metrics and logs ingested). |

**Key service limits:**
- 10 dimensions per metric (each unique combination = a distinct metric — watch cardinality)
- 5,000 alarms per account per region (request increase via Service Quotas)
- 150 metrics per dashboard widget
- 10,000 log groups per region
- PutMetricData: 1 MB payload limit, 20 metrics per call, max 40,000 TPS
- Logs Insights: max 20 concurrent queries, 10,000 log groups per query, results capped at 10,000 rows
- Metric retention: 1-second resolution kept 3 hours; 1-minute kept 15 days; 5-minute kept 63 days; 1-hour kept 15 months

---

## Mental Model

CloudWatch has five core primitives. Internalize these before writing any code.

### 1. Metrics: Namespace → Metric → Dimensions → Statistics

A metric is a time-series identified by three coordinates:

```
Namespace: "MyApp/Orders"
MetricName: "PaymentFailures"
Dimensions: [{ Name: "Environment", Value: "prod" }, { Name: "Region", Value: "us-east-1" }]
```

Every unique namespace + metric name + dimension set is a **separate metric** that incurs its own $0.30/month charge. High cardinality dimensions (user IDs, request IDs, transaction IDs) will explode your bill — never use them as dimensions.

Statistics you can request: `Average`, `Sum`, `Minimum`, `Maximum`, `SampleCount`, and percentiles (`p50`, `p95`, `p99`, `p99.9`). Percentiles require at least 10 data points in the evaluation period to be statistically valid.

### 2. Logs: Log Groups → Log Streams → Log Events

```
Log Group:  /aws/lambda/my-function       ← retention set here
  Log Stream: 2024/01/15/[$LATEST]abc123  ← one per Lambda instance
    Log Event: { timestamp, message }     ← individual log line
```

Retention is configured at the **Log Group** level and defaults to **Never expire**. This means logs accumulate indefinitely at $0.03/GB/month. Always set retention explicitly. Lambda creates Log Groups automatically on first invocation — they inherit the default (never expire) unless you pre-create them with a retention policy.

### 3. Alarms: 3 States, Evaluation Windows, Datapoints-to-Alarm

An alarm has exactly three states: `OK`, `ALARM`, and `INSUFFICIENT_DATA`. The evaluation logic is:

```
Period: 60 seconds          ← granularity of each data point
EvaluationPeriods: 5        ← window size (5 × 60s = 5 minutes)
DatapointsToAlarm: 3        ← how many of those 5 must breach threshold
Threshold: 10
ComparisonOperator: GreaterThanThreshold
TreatMissingData: notBreaching  ← critical for low-traffic services
```

The `DatapointsToAlarm` parameter implements an M-of-N evaluation — 3 out of 5 periods must breach before the alarm fires. This reduces noise from transient spikes. Without it (default: all periods must breach), a single noisy period can flip the alarm.

`TreatMissingData` options: `notBreaching` (safe default for most alarms), `breaching` (useful for heartbeat/canary patterns), `ignore` (keep alarm in current state), `missing` (alarm enters INSUFFICIENT_DATA).

### 4. Logs Insights: Learn This Before grep

Logs Insights is an interactive query engine that scans compressed log data orders of magnitude faster than iterating log streams via the API. The query language resembles SQL with a pipe syntax:

```
fields @timestamp, @message
| filter @message like /ERROR/
| stats count() as errorCount by bin(5m)
| sort @timestamp desc
| limit 100
```

Core commands: `fields`, `filter`, `stats`, `sort`, `limit`, `parse`, `pattern`, `dedup`, `display`.

`parse` extracts fields from unstructured text using glob or regex:
```
parse @message "* duration=* ms" as requestId, duration
```

`stats` aggregates: `count()`, `sum(field)`, `avg(field)`, `min(field)`, `max(field)`, `pct(field, 95)`, `stddev(field)`.

Important: Logs Insights **cannot** scan log events older than the log group's retention period. If you need historical analysis, export to S3 first.

### 5. Embedded Metric Format (EMF): Metrics Without API Calls

EMF lets you emit custom metrics as structured JSON log lines. CloudWatch automatically extracts the metrics without any `PutMetricData` API calls. This is the preferred approach for Lambda and containers:

```json
{
  "_aws": {
    "Timestamp": 1704067200000,
    "CloudWatchMetrics": [{
      "Namespace": "MyApp/Orders",
      "Dimensions": [["Environment", "Service"]],
      "Metrics": [
        { "Name": "OrderValue", "Unit": "None" },
        { "Name": "ProcessingTime", "Unit": "Milliseconds" }
      ]
    }]
  },
  "Environment": "prod",
  "Service": "checkout",
  "OrderValue": 149.99,
  "ProcessingTime": 42,
  "requestId": "abc-123",
  "userId": "u-456"
}
```

Any fields NOT listed in `Metrics` are stored as log dimensions or plain log data — you get structured logs and metrics from a single `console.log()` call. The `aws-embedded-metrics` npm package handles the JSON structure automatically.

---

## Common Patterns

### Pattern 1: Lambda Structured Logging with EMF (Auto-Metrics from Logs)

Install the official EMF library:

```bash
npm install @aws-lambda-powertools/metrics
# or the lower-level EMF library:
npm install aws-embedded-metrics
```

**Using AWS Lambda Powertools (recommended for Lambda):**

```typescript
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';

const metrics = new Metrics({
  namespace: 'MyApp/Orders',
  serviceName: 'checkout-service',
});

export const handler = async (event: APIGatewayEvent) => {
  const start = Date.now();

  try {
    const result = await processOrder(event.body);

    metrics.addMetric('OrdersProcessed', MetricUnit.Count, 1);
    metrics.addMetric('OrderValue', MetricUnit.None, result.amount);
    metrics.addMetric('ProcessingTime', MetricUnit.Milliseconds, Date.now() - start);
    metrics.addDimension('PaymentMethod', result.paymentMethod);

    metrics.publishStoredMetrics(); // flushes EMF JSON to stdout
    return { statusCode: 200, body: JSON.stringify(result) };

  } catch (error) {
    metrics.addMetric('OrderFailures', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();
    throw error;
  }
};
```

**Using the low-level `aws-embedded-metrics` library:**

```typescript
import { createMetricsLogger, Unit } from 'aws-embedded-metrics';

export const handler = async (event: any) => {
  const logger = createMetricsLogger();

  logger.setNamespace('MyApp/Payments');
  logger.putDimensions({ Environment: process.env.ENVIRONMENT ?? 'dev' });

  const start = Date.now();

  try {
    await processPayment(event);
    logger.putMetric('PaymentSuccess', 1, Unit.Count);
  } catch (err) {
    logger.putMetric('PaymentFailure', 1, Unit.Count);
    logger.setProperty('error', (err as Error).message);
    throw err;
  } finally {
    logger.putMetric('PaymentLatency', Date.now() - start, Unit.Milliseconds);
    await logger.flush(); // writes EMF JSON; in Lambda, use synchronous flush
  }
};
```

**Setting log group retention in CDK (always do this):**

```typescript
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';

const fn = new Function(this, 'CheckoutFn', {
  runtime: Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: Code.fromAsset('dist'),
  logRetention: RetentionDays.THIRTY_DAYS, // CDK creates/updates the log group
});

// Or explicitly:
new LogGroup(this, 'CheckoutLogs', {
  logGroupName: `/aws/lambda/${fn.functionName}`,
  retention: RetentionDays.THIRTY_DAYS,
  removalPolicy: RemovalPolicy.DESTROY,
});
```

### Pattern 2: Composite Alarm (Multiple Conditions + CDK)

A composite alarm combines multiple metric alarms with boolean logic. It only triggers actions when the composite condition is true — reducing alert fatigue significantly.

```typescript
import {
  Alarm,
  CompositeAlarm,
  AlarmRule,
  AlarmState,
  ComparisonOperator,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Topic } from 'aws-cdk-lib/aws-sns';

// Individual metric alarms
const errorRateAlarm = new Alarm(this, 'ErrorRateAlarm', {
  alarmName: 'checkout-error-rate-high',
  metric: checkoutFn.metricErrors({
    period: Duration.minutes(5),
    statistic: 'Sum',
  }),
  threshold: 10,
  evaluationPeriods: 3,
  datapointsToAlarm: 2,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: TreatMissingData.NOT_BREACHING,
});

const latencyAlarm = new Alarm(this, 'LatencyAlarm', {
  alarmName: 'checkout-p99-latency-high',
  metric: checkoutFn.metricDuration({
    period: Duration.minutes(5),
    statistic: 'p99',
  }),
  threshold: 5000, // 5 seconds
  evaluationPeriods: 3,
  datapointsToAlarm: 2,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: TreatMissingData.NOT_BREACHING,
});

const throttleAlarm = new Alarm(this, 'ThrottleAlarm', {
  alarmName: 'checkout-throttles',
  metric: checkoutFn.metricThrottles({
    period: Duration.minutes(1),
    statistic: 'Sum',
  }),
  threshold: 5,
  evaluationPeriods: 1,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: TreatMissingData.NOT_BREACHING,
});

// Composite: alert only when errors AND (latency is high OR throttling)
const onCallTopic = new Topic(this, 'OnCallTopic');

const compositeAlarm = new CompositeAlarm(this, 'CheckoutDegraded', {
  alarmName: 'checkout-service-degraded',
  alarmRule: AlarmRule.allOf(
    AlarmRule.fromAlarm(errorRateAlarm, AlarmState.ALARM),
    AlarmRule.anyOf(
      AlarmRule.fromAlarm(latencyAlarm, AlarmState.ALARM),
      AlarmRule.fromAlarm(throttleAlarm, AlarmState.ALARM),
    ),
  ),
  actionsEnabled: true,
});

compositeAlarm.addAlarmAction(new SnsAction(onCallTopic));
```

**Using the SDK directly for alarm management:**

```typescript
import {
  CloudWatchClient,
  PutMetricAlarmCommand,
  DescribeAlarmsCommand,
} from '@aws-sdk/client-cloudwatch';

const cw = new CloudWatchClient({ region: 'us-east-1' });

// Create or update an alarm
await cw.send(new PutMetricAlarmCommand({
  AlarmName: 'api-5xx-error-rate',
  AlarmDescription: 'API Gateway 5xx error rate > 1% for 5 minutes',
  Namespace: 'AWS/ApiGateway',
  MetricName: '5XXError',
  Dimensions: [
    { Name: 'ApiName', Value: 'my-api' },
    { Name: 'Stage', Value: 'prod' },
  ],
  Period: 60,
  EvaluationPeriods: 5,
  DatapointsToAlarm: 3,
  Threshold: 1,
  ComparisonOperator: 'GreaterThanThreshold',
  Statistic: 'Average',
  TreatMissingData: 'notBreaching',
  AlarmActions: ['arn:aws:sns:us-east-1:123456789012:oncall-topic'],
  OKActions: ['arn:aws:sns:us-east-1:123456789012:oncall-topic'],
}));

// Check alarm states
const { MetricAlarms } = await cw.send(new DescribeAlarmsCommand({
  AlarmNames: ['api-5xx-error-rate', 'checkout-error-rate-high'],
}));

for (const alarm of MetricAlarms ?? []) {
  console.log(`${alarm.AlarmName}: ${alarm.StateValue} — ${alarm.StateReason}`);
}
```

### Pattern 3: Logs Insights Queries

**Using the SDK to run queries programmatically:**

```typescript
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  QueryStatus,
} from '@aws-sdk/client-cloudwatch-logs';

const cwLogs = new CloudWatchLogsClient({ region: 'us-east-1' });

async function runInsightsQuery(
  logGroupName: string,
  queryString: string,
  startTime: Date,
  endTime: Date,
): Promise<Record<string, string>[]> {
  const { queryId } = await cwLogs.send(new StartQueryCommand({
    logGroupName,
    startTime: Math.floor(startTime.getTime() / 1000),
    endTime: Math.floor(endTime.getTime() / 1000),
    queryString,
    limit: 1000,
  }));

  // Poll until the query completes
  while (true) {
    await new Promise(r => setTimeout(r, 1000));

    const result = await cwLogs.send(new GetQueryResultsCommand({ queryId }));

    if (result.status === QueryStatus.Complete) {
      return (result.results ?? []).map(row =>
        Object.fromEntries(row.map(f => [f.field!, f.value!]))
      );
    }

    if (result.status === QueryStatus.Failed || result.status === QueryStatus.Cancelled) {
      throw new Error(`Query ${result.status}: ${queryId}`);
    }
  }
}

// --- Useful query library ---

// 1. Error rate by function over last hour
const errorsByFunction = `
  filter @message like /ERROR/
  | stats count() as errorCount by @log
  | sort errorCount desc
  | limit 20
`;

// 2. P50/P95/P99 Lambda duration
const latencyPercentiles = `
  filter @type = "REPORT"
  | parse @message "Duration: * ms" as duration
  | stats
      avg(duration) as p50,
      pct(duration, 95) as p95,
      pct(duration, 99) as p99,
      max(duration) as maxDuration
    by bin(5m)
  | sort @timestamp desc
`;

// 3. Cold start analysis
const coldStarts = `
  filter @type = "REPORT"
  | parse @message "Init Duration: * ms" as initDuration
  | filter ispresent(initDuration)
  | stats
      count() as coldStarts,
      avg(initDuration) as avgInitMs,
      max(initDuration) as maxInitMs
    by bin(1h)
`;

// 4. Top error messages with count
const topErrors = `
  filter @message like /ERROR|Exception|Error/
  | parse @message "* Error: *" as level, message
  | stats count(*) as occurrences by message
  | sort occurrences desc
  | limit 25
`;

// 5. Request tracing by correlation ID
const buildTraceQuery = (requestId: string) => `
  filter @requestId = "${requestId}" or @message like /${requestId}/
  | fields @timestamp, @message, @logStream
  | sort @timestamp asc
`;

// 6. Memory utilization (Lambda)
const memoryUsage = `
  filter @type = "REPORT"
  | parse @message "Memory Used: * MB" as memUsed
  | parse @message "Memory Size: * MB" as memSize
  | stats
      avg(memUsed / memSize * 100) as avgUtilPct,
      max(memUsed) as maxUsedMB
    by bin(1h)
`;
```

### Pattern 4: Custom Dashboard with CDK

```typescript
import {
  Dashboard,
  GraphWidget,
  SingleValueWidget,
  AlarmStatusWidget,
  TextWidget,
  Color,
  Stats,
  PeriodOverride,
} from 'aws-cdk-lib/aws-cloudwatch';

const dashboard = new Dashboard(this, 'ServiceDashboard', {
  dashboardName: 'checkout-service-prod',
  defaultInterval: Duration.hours(3),
  periodOverride: PeriodOverride.AUTO,
});

// Header row
dashboard.addWidgets(
  new TextWidget({
    markdown: '# Checkout Service — Production\nUpdated automatically.',
    width: 24,
    height: 2,
  }),
);

// KPI row: single values
dashboard.addWidgets(
  new SingleValueWidget({
    title: 'Orders (1h)',
    metrics: [
      new Metric({
        namespace: 'MyApp/Orders',
        metricName: 'OrdersProcessed',
        statistic: Stats.SUM,
        period: Duration.hours(1),
      }),
    ],
    width: 6,
  }),
  new SingleValueWidget({
    title: 'Error Rate (5m)',
    metrics: [checkoutFn.metricErrors({ statistic: Stats.SUM, period: Duration.minutes(5) })],
    width: 6,
  }),
  new SingleValueWidget({
    title: 'P99 Latency (5m)',
    metrics: [checkoutFn.metricDuration({ statistic: 'p99', period: Duration.minutes(5) })],
    width: 6,
  }),
  new AlarmStatusWidget({
    title: 'Alarm Status',
    alarms: [errorRateAlarm, latencyAlarm, throttleAlarm],
    width: 6,
  }),
);

// Time-series graphs
dashboard.addWidgets(
  new GraphWidget({
    title: 'Lambda Invocations & Errors',
    left: [checkoutFn.metricInvocations({ statistic: Stats.SUM })],
    right: [checkoutFn.metricErrors({ statistic: Stats.SUM, color: Color.RED })],
    width: 12,
    height: 6,
    leftYAxis: { label: 'Invocations', min: 0 },
    rightYAxis: { label: 'Errors', min: 0 },
  }),
  new GraphWidget({
    title: 'Duration Percentiles',
    left: [
      checkoutFn.metricDuration({ statistic: 'p50', label: 'P50', color: Color.GREEN }),
      checkoutFn.metricDuration({ statistic: 'p95', label: 'P95', color: Color.ORANGE }),
      checkoutFn.metricDuration({ statistic: 'p99', label: 'P99', color: Color.RED }),
    ],
    width: 12,
    height: 6,
    leftYAxis: { label: 'Duration (ms)', min: 0 },
  }),
);
```

**Using the SDK to put custom metrics (when EMF is not available):**

```typescript
import {
  CloudWatchClient,
  PutMetricDataCommand,
  StandardUnit,
} from '@aws-sdk/client-cloudwatch';

const cw = new CloudWatchClient({ region: 'us-east-1' });

// Batch up to 20 metrics per call
await cw.send(new PutMetricDataCommand({
  Namespace: 'MyApp/Payments',
  MetricData: [
    {
      MetricName: 'PaymentProcessed',
      Dimensions: [
        { Name: 'Environment', Value: 'prod' },
        { Name: 'Provider', Value: 'stripe' },
      ],
      Value: 1,
      Unit: StandardUnit.Count,
      Timestamp: new Date(),
    },
    {
      MetricName: 'PaymentAmount',
      Dimensions: [
        { Name: 'Environment', Value: 'prod' },
        { Name: 'Currency', Value: 'USD' },
      ],
      Value: 149.99,
      Unit: StandardUnit.None,
      Timestamp: new Date(),
    },
  ],
}));
```

**Setting log retention on existing groups with the SDK:**

```typescript
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const cwLogs = new CloudWatchLogsClient({ region: 'us-east-1' });

// Find all log groups with no retention set and fix them
async function enforceRetention(retentionDays: number = 30) {
  let nextToken: string | undefined;

  do {
    const { logGroups, nextToken: next } = await cwLogs.send(
      new DescribeLogGroupsCommand({ nextToken }),
    );

    for (const group of logGroups ?? []) {
      if (!group.retentionInDays) {
        console.log(`Setting ${retentionDays}-day retention on: ${group.logGroupName}`);
        await cwLogs.send(new PutRetentionPolicyCommand({
          logGroupName: group.logGroupName!,
          retentionInDays: retentionDays,
        }));
      }
    }

    nextToken = next;
  } while (nextToken);
}
```

---

## Gotchas

**1. CloudWatch Logs ingestion is your #2 surprise AWS bill after NAT Gateway.**
Lambda verbose logging (debug-level JSON with full request/response bodies) at scale can cost hundreds of dollars per month. A Lambda processing 10M invocations/month logging 5KB per invocation = 50GB = $25/month just in ingestion, plus $1.50/month storage. Audit log volume before enabling debug logging in production.

**2. Default log retention is "Never expire" — this is almost always wrong.**
Every log group created by Lambda auto-invocation, ECS, API Gateway access logging, etc. inherits the account default: never expire. Logs accumulate indefinitely. Run the `enforceRetention()` pattern above as a one-time cleanup, then set retention at provisioning time via CDK's `logRetention` prop or an explicit `LogGroup` construct.

**3. Logs Insights charges $0.005/GB scanned — time range selection matters enormously.**
A 7-day query against a high-volume log group (/aws/lambda/my-function with 500GB/week) costs $17.50 per query. Narrow your time range first. Query specific log groups rather than wildcards. Use `limit` aggressively during exploration.

**4. Each unique dimension combination is a separate billable metric.**
`Namespace: MyApp, MetricName: RequestCount` with dimensions `{Env: prod, Region: us-east-1}` is a different metric from `{Env: prod, Region: us-west-2}`. With 10 environments × 5 regions × 3 services = 150 distinct metrics at $0.30 each = $45/month for a single metric name. Plan your dimension cardinality before rollout.

**5. Never use high-cardinality values as dimensions.**
Request IDs, user IDs, session IDs, order IDs — each unique value creates a new metric. CloudWatch will accept the PutMetricData calls and then you will receive a very large AWS bill. Use these values as log properties (via EMF's non-metric fields) or X-Ray trace annotations, not CloudWatch dimensions.

**6. PutMetricData is expensive at volume — use EMF instead.**
PutMetricData costs $0.01/1,000 API calls and has a 1 MB payload limit (~20 data points per call). At 1M metrics/day, that's $10/day in API calls alone. EMF emits metrics as log lines, piggybacks on existing log delivery, and costs nothing extra in API calls. Use EMF for any Lambda or container workload.

**7. Alarms treat missing data as INSUFFICIENT_DATA by default — low-traffic services flip states constantly.**
If your Lambda runs 3 times per hour and your alarm evaluation period is 1 minute, most evaluation periods have no data. Set `TreatMissingData: notBreaching` for error/failure alarms. Use `breaching` only for heartbeat/canary patterns where absence of data is itself a failure signal.

**8. Cross-account metric sharing requires explicit CloudWatch cross-account observability setup.**
Metrics do not flow between AWS accounts automatically. To view metrics from Account A in Account B's dashboard, you must configure CloudWatch cross-account observability (sharing and linking accounts via the CloudWatch console or AWS Organizations). CloudWatch Metric Streams can route to a central account via Kinesis Firehose as an alternative.

**9. CloudWatch Synthetics canaries are deceptively expensive at high frequency.**
The console defaults to 1-minute intervals. One canary at 1-minute frequency = 43,800 runs/month × $0.0012 = $52.56/month. For basic availability checks, 5-minute intervals ($10.51/month) are usually sufficient. For complex multi-step UI canaries, consider 15-minute intervals.

**10. Log Groups cannot be renamed.**
There is no rename operation for Log Groups. If you name it `/aws/lambda/my-dev-function` and later want `/app/checkout/dev`, you must create a new group, migrate retention policies, update all log destinations, and delete the old one. Use a consistent naming convention from day one: `/app/{service}/{environment}` works well.

**11. Metric math expressions are free — use them instead of creating new custom metrics.**
Metric math (FILL, RATE, IF, METRICS, etc.) lets you derive new metrics from existing ones without creating additional billable custom metrics. For example, error rate = errors / invocations using metric math costs nothing beyond the two source metrics. You can reference up to 10 metrics in a single math expression.

**12. Dashboard time range overrides period — short periods on long time ranges cause "too many data points" errors.**
If you set a dashboard to show 7 days and a widget uses 1-minute metric periods, CloudWatch will try to return 10,080 data points per metric — exceeding the 1,440-point limit. CloudWatch auto-aggregates on screen, but the raw API call fails. Use `AUTO` period or set periods appropriate to your default time range (1-hour period for 7-day dashboards).

**13. Anomaly detection bands need 2 weeks of training data to be accurate.**
When you first create an anomaly detection alarm, the ML model has no baseline. Alarms will be noisy for the first 14 days. Do not route anomaly detection alarms to on-call paging until the model has stabilized. Use a staging alarm that routes to a low-priority SNS topic for the first two weeks.

**14. Logs Insights results are capped at 10,000 rows — use `stats` for aggregations, not raw `fields`.**
If your query returns more than 10,000 matching events, only the first 10,000 are returned (after sorting). For volume analysis, always aggregate with `stats count()` or `stats sum()` rather than listing individual events. If you need all raw events, use CloudWatch Logs export to S3 and query with Athena instead.

---

## Official Documentation

- **CloudWatch Monitoring Guide** — https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/
- **CloudWatch Logs User Guide** — https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/
- **Logs Insights Query Syntax** — https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html
- **Embedded Metric Format Specification** — https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
- **CloudWatch Pricing** — https://aws.amazon.com/cloudwatch/pricing/
- **AWS SDK v3 — CloudWatch Client** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cloudwatch/
- **AWS SDK v3 — CloudWatch Logs Client** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cloudwatch-logs/
- **Lambda Powertools Metrics** — https://docs.powertools.aws.dev/lambda/typescript/latest/core/metrics/
- **Cross-Account Observability** — https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Unified-Cross-Account.html
