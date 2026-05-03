---
name: eventbridge
description: Amazon EventBridge guidance — event bus, rules, event patterns, scheduler, pipes, schema registry, archive/replay. Use when building event-driven architectures or scheduling tasks.
metadata:
  priority: 6
  docs:
    - "https://docs.aws.amazon.com/eventbridge/latest/userguide/"
  pathPatterns:
    - 'events/**'
    - 'eventbridge/**'
  bashPatterns:
    - '\baws\s+events\b'
    - '\baws\s+scheduler\b'
  importPatterns:
    - "@aws-sdk/client-eventbridge"
    - "@aws-sdk/client-scheduler"
    - "aws-cdk-lib/aws-events"
    - "aws-cdk-lib/aws-events-targets"
  promptSignals:
    phrases:
      - "eventbridge"
      - "event bus"
      - "event pattern"
      - "event rule"
      - "eventbridge scheduler"
      - "event-driven"
      - "cron schedule"
      - "event pipe"
      - "schema registry"
---

## What It Is & When to Use It

Amazon EventBridge is a serverless event bus that routes events from sources to targets based on rules. Sources can be AWS services (100+ emit to the default bus automatically), SaaS applications via partner integrations, or your own custom applications publishing to a custom event bus. Targets receive matching events and can be Lambda functions, SQS queues, SNS topics, Step Functions state machines, API Gateway endpoints, ECS tasks, Kinesis streams, and more.

EventBridge has expanded into a suite of related services:
- **Event Bus** — the original routing engine with content-based filtering
- **EventBridge Scheduler** — fully managed one-time and recurring schedule execution
- **EventBridge Pipes** — point-to-point integrations with source polling, optional filtering, optional enrichment, and target delivery
- **Schema Registry** — auto-discovers event schemas and generates code bindings

### When to use EventBridge vs. alternatives

| Need | Recommended service | Reason |
|---|---|---|
| Route events by content to multiple targets | **EventBridge rules** | Content-based filtering, fan-out, 100+ AWS sources |
| Simple fan-out to multiple subscribers | **SNS** | Lower latency, cheaper at high volume, no pattern matching needed |
| Point-to-point buffered messaging | **SQS** | Consumer controls pace, durable queue, retries built in |
| Complex multi-step workflows with state | **Step Functions** | Branching, error handling, wait states, human approval |
| Recurring or one-time scheduled tasks | **EventBridge Scheduler** | More flexible than cron rules, one-time schedules, flexible time windows |
| Poll a source, optionally enrich, push to target | **EventBridge Pipes** | No-code glue layer, built-in filtering and batching |
| Async service-to-service decoupling | **EventBridge custom bus** | Explicit publisher/subscriber contract via schema, cross-account capable |

### EventBridge Scheduler vs. CloudWatch scheduled rules

CloudWatch Events (now the EventBridge rules UI) supports `rate()` and `cron()` expressions but only targets EventBridge targets and has limited scheduling semantics. EventBridge Scheduler adds:
- One-time `at()` schedules (fire once at a specific UTC datetime)
- Flexible time windows (allow ± N minutes to spread load)
- Timezone-aware cron expressions
- A dedicated schedule group concept for lifecycle management
- Direct SDK/API integration — no event bus involved, payload goes straight to the target

Use **Scheduler** for time-triggered work. Use **Rules** only when time-based triggers also need content-based routing, or when an AWS service event should trigger based on schedule metadata.

---

## Service Surface

### Core components

| Component | What it is | Key characteristic |
|---|---|---|
| Default event bus | Receives all AWS service events for the account/region | Cannot be deleted; rules here match AWS service events |
| Custom event bus | Receives events you publish via `PutEvents` | Isolated namespace; cross-account resource policy supported |
| Partner event bus | Receives events from SaaS partners (Datadog, Zendesk, etc.) | Configured via AWS partner network |
| Rule | Pattern matcher + target list attached to a bus | Up to 300 rules per bus, 5 targets per rule |
| Target | Destination that receives matched events | Lambda, SQS, SNS, Step Functions, Kinesis, API GW, ECS, more |
| Scheduler | Fully managed schedule service | One-time, rate, and cron; not tied to a bus |
| Schedule group | Logical grouping of schedules | Tag-based management, bulk delete |
| Pipe | Source → [Filter] → [Enrich] → Target | Sources: SQS, Kinesis, DynamoDB Streams, Kafka, MQ |
| Schema Registry | Stores event schemas; auto-discovery optional | Generates TypeScript/Java/Python bindings |
| Archive | Captures all or filtered events from a bus | Used with Replay for reprocessing |
| Replay | Re-publishes archived events to a bus | Triggers all currently matching rules |

### Pricing (us-east-1, 2024)

| Service | Price |
|---|---|
| Custom events published | $1.00 / million events |
| AWS service events | Free |
| Third-party / SaaS events | $1.00 / million events |
| Schema discovery | $0.10 / million events |
| Scheduler invocations | $1.00 / million invocations (first 14M/mo free) |
| Pipes | $0.40 / million + $0.40 / million for enrichment step |
| Archive storage | $0.10 / GB / month |
| Replay | $0.10 / million replayed events |

### Key limits

| Limit | Value |
|---|---|
| Rules per event bus | 300 (soft, increasable) |
| Targets per rule | 5 |
| Event buses per account per region | 2,000 |
| Event size | 64 KB max |
| `PutEvents` batch size | 10 events per call |
| Invocation rate per rule | 400 concurrent invocations (soft) |
| Schedules per account per region | 1,000,000 |
| Schema registry schemas | 1,500 per registry |
| Pipes per account per region | 1,000 |

### Built-in AWS service sources (selected)

Over 100 AWS services emit events to the default event bus automatically. Notable sources: EC2 (instance state changes), S3 (notifications via EventBridge notification config), CodePipeline (stage transitions), CodeBuild (build state), ECS (task state), RDS (snapshots, maintenance), CloudTrail (API calls via CloudWatch Events bridge), Health (account health events), Config (compliance changes), Glue (job state), SageMaker (training job state).

---

## Mental Model

EventBridge has five distinct primitives. Understanding which one to reach for determines whether your solution is clean or a mess.

### 1. Event Bus — the highway

Events travel on a bus. The **default bus** is a global receiver for all AWS service events in your account and region. **Custom buses** are isolated namespaces you publish to with `PutEvents`. Think of a bus as a named channel: it has no inherent subscribers, just rules that observe it.

An event on a bus is a JSON document with a fixed envelope:

```json
{
  "version": "0",
  "id": "abc123",
  "source": "my.app",
  "account": "123456789012",
  "time": "2026-05-01T12:00:00Z",
  "region": "us-east-1",
  "detail-type": "OrderPlaced",
  "detail": {
    "orderId": "ord-789",
    "amount": 149.99,
    "customerId": "cust-456"
  }
}
```

`source`, `detail-type`, and `detail` are yours to define. The rest is set by EventBridge.

### 2. Event Pattern — the content-based filter

A rule has an event pattern. The pattern is a JSON structure that describes what an event must look like to match. It is **not** a regex or query language — it is **structural**: every key in the pattern must be present in the event with a matching value.

```json
{
  "source": ["my.app"],
  "detail-type": ["OrderPlaced"],
  "detail": {
    "amount": [{ "numeric": [">=", 100] }]
  }
}
```

This matches only events from `my.app` where `detail-type` is exactly `OrderPlaced` and `amount` is 100 or more. All conditions are AND. Values in arrays are OR alternatives.

Match operators: exact value, prefix, suffix, equals-ignore-case, numeric range, IP CIDR, exists/not-exists, anything-but, wildcard.

### 3. Targets — what runs when a rule fires

Each rule routes matching events to up to 5 targets simultaneously. Targets receive the full event by default, but you can configure an **input transformer** to reshape the JSON before delivery — useful for APIs that expect a different payload shape.

EventBridge handles retries for failed target invocations: up to 24 hours with exponential backoff for most targets. A dead-letter queue (SQS) on the rule captures events that exhaust retries.

### 4. Scheduler — cron on steroids

Scheduler is a separate service that does not use a bus at all. You create a schedule, give it an expression and a target, and it fires at the defined time(s). Expressions:

| Type | Syntax | Example |
|---|---|---|
| One-time | `at(yyyy-mm-ddThh:mm:ss)` | `at(2026-05-02T09:00:00)` |
| Rate | `rate(value unit)` | `rate(15 minutes)` |
| Cron | `cron(min hr day mon dow yr)` | `cron(0 9 ? * MON-FRI *)` |

Flexible time windows let Scheduler fire the invocation within a ± window (e.g., any time within 10 minutes of the scheduled time), spreading burst load.

### 5. Pipes — the no-code integration layer

A Pipe has four stages, only source and target are required:

```
Source (poll) → [Filter] → [Enrich] → Target
```

Sources are polled services: SQS, Kinesis Data Streams, DynamoDB Streams, Amazon MQ, MSK (Kafka), self-managed Kafka. Pipes handles batching, checkpointing, and error handling that you'd otherwise code in Lambda. Enrichment can call Lambda, Step Functions, API Gateway, or an API destination. Target is any EventBridge target type.

Use Pipes when you want to consume from a stream/queue and push to a destination without writing polling code. Avoid Pipes when you need complex branching, retries with backoff, or enrichment logic that doesn't fit the four available enrichment targets.

---

## Common Patterns

### Pattern 1: Custom event bus with rule routing to multiple targets

Publish application events to a custom bus and route them to Lambda and SQS simultaneously.

```typescript
// CDK — TypeScript
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

export class OrderEventsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Custom event bus
    const orderBus = new events.EventBus(this, "OrderBus", {
      eventBusName: "order-events",
    });

    // Lambda target — processes high-value orders
    const processorFn = lambda.Function.fromFunctionArn(
      this,
      "Processor",
      "arn:aws:lambda:us-east-1:123456789012:function:order-processor"
    );

    // DLQ for failed deliveries
    const dlq = new sqs.Queue(this, "FailedOrdersDLQ", {
      queueName: "failed-orders-dlq",
    });

    // Audit queue — receives all order events
    const auditQueue = new sqs.Queue(this, "AuditQueue", {
      queueName: "order-audit",
    });

    // Rule: high-value orders (>= $500) → Lambda + audit queue
    new events.Rule(this, "HighValueOrderRule", {
      eventBus: orderBus,
      ruleName: "high-value-orders",
      eventPattern: {
        source: ["my.ecommerce"],
        detailType: ["OrderPlaced"],
        detail: {
          amount: [{ numeric: [">=", 500] }],
        },
      },
      targets: [
        new targets.LambdaFunction(processorFn, {
          deadLetterQueue: dlq,
          maxEventAge: cdk.Duration.hours(2),
          retryAttempts: 3,
        }),
        new targets.SqsQueue(auditQueue),
      ],
    });

    // Rule: all orders → audit queue (separate rule, no content filter)
    new events.Rule(this, "AllOrdersAuditRule", {
      eventBus: orderBus,
      ruleName: "all-orders-audit",
      eventPattern: {
        source: ["my.ecommerce"],
        detailType: ["OrderPlaced"],
      },
      targets: [new targets.SqsQueue(auditQueue)],
    });
  }
}
```

Publishing events from application code using SDK v3:

```typescript
import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsRequestEntry,
} from "@aws-sdk/client-eventbridge";

const client = new EventBridgeClient({ region: "us-east-1" });

async function publishOrderEvent(order: {
  orderId: string;
  amount: number;
  customerId: string;
}): Promise<void> {
  const entry: PutEventsRequestEntry = {
    EventBusName: "order-events",
    Source: "my.ecommerce",
    DetailType: "OrderPlaced",
    Detail: JSON.stringify(order),
    Time: new Date(),
  };

  const response = await client.send(
    new PutEventsCommand({ Entries: [entry] })
  );

  // PutEvents never throws on partial failure — always check FailedEntryCount
  if (response.FailedEntryCount && response.FailedEntryCount > 0) {
    const failed = response.Entries?.filter((e) => e.ErrorCode);
    throw new Error(
      `EventBridge PutEvents partial failure: ${JSON.stringify(failed)}`
    );
  }
}
```

### Pattern 2: EventBridge Scheduler for one-time future execution

Schedule a Lambda invocation 24 hours from now (e.g., send a follow-up reminder).

```typescript
import {
  SchedulerClient,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
} from "@aws-sdk/client-scheduler";

const scheduler = new SchedulerClient({ region: "us-east-1" });

async function scheduleReminder(params: {
  userId: string;
  message: string;
  sendAt: Date; // when to fire
}): Promise<string> {
  const scheduleName = `reminder-${params.userId}-${Date.now()}`;

  // Format: at(yyyy-mm-ddThh:mm:ss) — must be UTC, no milliseconds
  const atExpression = `at(${params.sendAt.toISOString().slice(0, 19)})`;

  const response = await scheduler.send(
    new CreateScheduleCommand({
      Name: scheduleName,
      GroupName: "reminders", // schedule group for lifecycle management
      ScheduleExpression: atExpression,
      ScheduleExpressionTimezone: "UTC",
      // Flexible window: fire within 5 minutes of scheduled time
      FlexibleTimeWindow: {
        Mode: FlexibleTimeWindowMode.FLEXIBLE,
        MaximumWindowInMinutes: 5,
      },
      // Auto-delete after it fires (one-time schedule)
      ActionAfterCompletion: "DELETE",
      Target: {
        Arn: "arn:aws:lambda:us-east-1:123456789012:function:send-reminder",
        RoleArn: "arn:aws:iam::123456789012:role/scheduler-invoke-lambda",
        Input: JSON.stringify({
          userId: params.userId,
          message: params.message,
        }),
        // Retry policy for failed invocations
        RetryPolicy: {
          MaximumRetryAttempts: 3,
          MaximumEventAgeInSeconds: 3600,
        },
      },
    })
  );

  return response.ScheduleArn ?? scheduleName;
}
```

The IAM role (`scheduler-invoke-lambda`) needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "arn:aws:lambda:us-east-1:123456789012:function:send-reminder"
    }
  ]
}
```

With trust policy allowing `scheduler.amazonaws.com` to assume it.

### Pattern 3: Cross-account event forwarding

Forward events from a producer account's custom bus to a consumer account's bus.

In the **consumer account** — add a resource policy to allow the producer to send events:

```typescript
import {
  EventBridgeClient,
  PutPermissionCommand,
} from "@aws-sdk/client-eventbridge";

const client = new EventBridgeClient({ region: "us-east-1" });

// Run this in the CONSUMER account
await client.send(
  new PutPermissionCommand({
    EventBusName: "consumer-shared-bus",
    Action: "events:PutEvents",
    Principal: "111122223333", // producer account ID
    StatementId: "AllowProducerAccount",
  })
);
```

In the **producer account** — add a rule that routes to the consumer bus:

```typescript
// CDK in producer account
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";

const producerBus = events.EventBus.fromEventBusName(
  this,
  "ProducerBus",
  "producer-app-events"
);

const consumerBusArn =
  "arn:aws:events:us-east-1:999988887777:event-bus/consumer-shared-bus";

new events.Rule(this, "ForwardToConsumer", {
  eventBus: producerBus,
  eventPattern: {
    source: ["producer.app"],
    detailType: ["SharedEvent"],
  },
  targets: [
    new targets.EventBus(
      events.EventBus.fromEventBusArn(
        this,
        "ConsumerBus",
        consumerBusArn
      )
    ),
  ],
});
```

### Pattern 4: Content-based routing with input transformer

Route S3 object creation events to different Lambda functions based on file prefix, and reshape the payload before delivery.

```typescript
// CDK
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";

// Rule matching S3 events for uploads/ prefix
new events.Rule(this, "S3UploadRule", {
  // S3 events use the default bus (EventBridge S3 notifications must be enabled on the bucket)
  eventPattern: {
    source: ["aws.s3"],
    detailType: ["Object Created"],
    detail: {
      bucket: {
        name: ["my-upload-bucket"],
      },
      object: {
        key: [{ prefix: "uploads/" }],
      },
    },
  },
  targets: [
    new targets.LambdaFunction(processUploadFn, {
      // Input transformer: extract only what Lambda needs
      event: events.RuleTargetInput.fromObject({
        bucket: events.EventField.fromPath("$.detail.bucket.name"),
        key: events.EventField.fromPath("$.detail.object.key"),
        size: events.EventField.fromPath("$.detail.object.size"),
        eventTime: events.EventField.fromPath("$.time"),
      }),
    }),
  ],
});
```

Using SDK v3 to describe rules and list targets for debugging:

```typescript
import {
  EventBridgeClient,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  DescribeRuleCommand,
} from "@aws-sdk/client-eventbridge";

const client = new EventBridgeClient({ region: "us-east-1" });

async function inspectBus(busName: string): Promise<void> {
  const rules = await client.send(
    new ListRulesCommand({ EventBusName: busName })
  );

  for (const rule of rules.Rules ?? []) {
    const detail = await client.send(
      new DescribeRuleCommand({
        Name: rule.Name!,
        EventBusName: busName,
      })
    );

    const ruleTargets = await client.send(
      new ListTargetsByRuleCommand({
        Rule: rule.Name!,
        EventBusName: busName,
      })
    );

    console.log({
      rule: rule.Name,
      state: detail.State,
      pattern: detail.EventPattern,
      targets: ruleTargets.Targets?.map((t) => ({ id: t.Id, arn: t.Arn })),
    });
  }
}
```

---

## Gotchas

### 1. The default bus receives everything — be specific with patterns

Every AWS service event in your account hits the default bus. If you create a rule on the default bus without a `source` filter, it evaluates against all AWS service events. This is rarely what you want and can generate unexpected Lambda invocations. Always specify `source` and `detail-type` at minimum on default bus rules.

### 2. Event pattern matching is case-sensitive and structural

`"source": ["My.App"]` will not match an event with `"source": "my.app"`. EventBridge pattern matching is exact-match by default (except for operators like `equals-ignore-case`). The pattern is also structural — only fields present in the pattern are evaluated. Extra fields in the event are ignored. An empty pattern `{}` matches everything.

### 3. PutEvents never throws on partial batch failure

`PutEvents` accepts up to 10 events per call and returns HTTP 200 even when some events failed. Always inspect `FailedEntryCount` and the `ErrorCode` / `ErrorMessage` on individual entries. Failed entries must be retried by your code — EventBridge does not retry `PutEvents` failures.

```typescript
const response = await client.send(new PutEventsCommand({ Entries: batch }));
if (response.FailedEntryCount && response.FailedEntryCount > 0) {
  const failed = response.Entries?.filter((e) => e.ErrorCode) ?? [];
  // retry or DLQ failed entries
}
```

### 4. At-least-once delivery — targets must be idempotent

EventBridge guarantees at-least-once delivery, not exactly-once. Under failure conditions (network partitions, target throttling), the same event may be delivered more than once. Design Lambda handlers and downstream consumers to be idempotent — use the event `id` field as an idempotency key.

### 5. Rule evaluation order is not defined

When multiple rules match the same event, their targets fire in no guaranteed order. Do not architect systems that assume rule A fires before rule B. If ordering matters, use a single rule with a Step Functions target and encode the ordering in the state machine.

### 6. Scheduler one-time schedules need ActionAfterCompletion: DELETE

One-time (`at()`) schedules stay in the Disabled state after firing unless you set `ActionAfterCompletion: "DELETE"`. Left undeleted they accumulate toward the 1M schedule limit. Always set `ActionAfterCompletion` to `"DELETE"` for one-time schedules, or implement a cleanup routine that deletes disabled schedules in your schedule groups.

### 7. Archive/Replay re-triggers all currently active rules

When you replay archived events, EventBridge publishes them to the bus and all currently matching rules evaluate them — not the rules that were active when the events were originally received. This means rule changes between archive time and replay time will produce different routing. For safe replay, use a separate "replay bus" with controlled rules and replay into that bus rather than the production bus.

### 8. 64KB event size limit — use S3 reference pattern

EventBridge rejects events larger than 64KB. For payloads like document content or large JSON blobs, store the payload in S3 and include only a reference in the event:

```json
{
  "source": "my.app",
  "detail-type": "LargeDocumentProcessed",
  "detail": {
    "documentId": "doc-123",
    "s3Bucket": "my-payloads",
    "s3Key": "documents/doc-123.json",
    "contentType": "application/json"
  }
}
```

The target Lambda fetches the actual payload from S3.

### 9. Scheduler IAM role must be in the same account as the schedule

The execution role attached to a Scheduler schedule must exist in the same account as the schedule. Cross-account scheduling requires the schedule to invoke a resource (like an SNS topic or SQS queue) that the other account can consume — you cannot directly cross-account invoke Lambda via Scheduler from a different account.

### 10. Cross-account event forwarding requires resource policies on both ends

Sending events cross-account requires: (a) a resource-based policy on the target bus allowing `events:PutEvents` from the source account principal, and (b) the forwarding rule's target in the source account must reference the full ARN of the destination bus. The rule execution role needs `events:PutEvents` on the destination bus ARN.

### 11. Pipes enrichment options are limited

Pipes enrichment (the middle stage) only supports four destinations: Lambda, Step Functions (synchronous express workflow), API Gateway, and API destinations (any HTTP endpoint). If your enrichment logic needs to call SQS, DynamoDB, or other services, wrap it in a Lambda function. Enrichment receives the filtered/batched source records and must return a transformed payload within 29 seconds.

### 12. Schema Registry adds latency to new schemas

When schema discovery is enabled, the first event with a previously unseen schema shape incurs additional processing time as EventBridge infers and registers the schema. This is imperceptible in practice but means schema discovery should not be enabled in latency-sensitive paths. Disable discovery and manually register schemas in production; use discovery only in dev/staging environments.

### 13. Input transformers have limited transformation power

Input transformers let you reshape event JSON before it reaches a target using a template language — but this language is not JSONPath or JMESPath. It only supports extracting values from the event using `$.field.path` syntax and inserting them into a JSON or string template. You cannot do conditionals, array operations, or arithmetic. If you need real transformation, use a Lambda enrichment step or an EventBridge Pipe with a transformation stage.

### 14. EventBridge does not emit CloudWatch Metrics per rule by default

EventBridge emits aggregate metrics (MatchedEvents, TriggeredRules, FailedInvocations) at the bus level. Per-rule or per-target metrics are not available natively. To monitor individual rule health, instrument your Lambda targets with custom metrics or use X-Ray tracing on the target functions. Set a CloudWatch alarm on `FailedInvocations` at the bus level as a catch-all signal.

---

## Official Documentation

- [EventBridge User Guide](https://docs.aws.amazon.com/eventbridge/latest/userguide/) — event buses, rules, event patterns, targets, archive/replay, schema registry
- [EventBridge Scheduler User Guide](https://docs.aws.amazon.com/scheduler/latest/UserGuide/) — schedule types, flexible time windows, target configuration, IAM requirements
- [EventBridge Pipes User Guide](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes.html) — source/filter/enrichment/target configuration, batching, error handling
- [Event Pattern Reference](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html) — all match operators: prefix, suffix, numeric range, IP CIDR, exists, anything-but, wildcard
- [AWS SDK v3 — @aws-sdk/client-eventbridge](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/eventbridge/) — PutEvents, ListRules, ListTargetsByRule, DescribeRule, PutRule, PutTargets
- [AWS SDK v3 — @aws-sdk/client-scheduler](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/scheduler/) — CreateSchedule, UpdateSchedule, DeleteSchedule, ListSchedules, GetSchedule
- [EventBridge Pricing](https://aws.amazon.com/eventbridge/pricing/) — custom events, Scheduler invocations, Pipes, archive storage
- [Service Quotas — EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-quota.html) — rules per bus, targets per rule, event size, buses per account
- [EventBridge CDK constructs (aws-cdk-lib/aws-events)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_events-readme.html) — EventBus, Rule, RuleTargetInput, EventField
- [EventBridge CDK targets (aws-cdk-lib/aws-events-targets)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_events_targets-readme.html) — LambdaFunction, SqsQueue, SnsTopic, SfnStateMachine, EventBus
