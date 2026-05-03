---
name: sqs-sns
description: Amazon SQS and SNS guidance — message queues, pub/sub, FIFO ordering, dead-letter queues, fan-out patterns, event-driven architecture. Use when building async messaging or event-driven systems.
metadata:
  priority: 6
  docs:
    - "https://docs.aws.amazon.com/sqs/"
    - "https://docs.aws.amazon.com/sns/"
  pathPatterns:
    - 'queues/**'
    - 'messaging/**'
    - 'events/**'
  bashPatterns:
    - '\baws\s+sqs\b'
    - '\baws\s+sns\b'
  importPatterns:
    - "@aws-sdk/client-sqs"
    - "@aws-sdk/client-sns"
  promptSignals:
    phrases:
      - "sqs"
      - "sns"
      - "message queue"
      - "dead letter queue"
      - "fifo queue"
      - "pub sub"
      - "fan-out"
      - "sns topic"
      - "sqs queue"
      - "event-driven"
---

## What It Is & When to Use It

Amazon SQS (Simple Queue Service) and Amazon SNS (Simple Notification Service) are the two foundational AWS services for building async, event-driven architectures.

**SQS** is a fully managed message queue. Producers write messages to a queue; consumers poll and process them. The queue decouples the two sides — if the consumer is slow, down, or being scaled, messages accumulate safely rather than getting dropped. SQS is point-to-point: each message is delivered to exactly one consumer.

**SNS** is a fully managed pub/sub service. A publisher sends one message to a topic; SNS fans it out to all subscribers simultaneously. Subscribers can be SQS queues, Lambda functions, HTTP/HTTPS endpoints, email addresses, SMS numbers, or Kinesis Data Firehose streams. SNS is one-to-many.

**Use SQS when:**
- You need reliable, ordered (FIFO) or high-throughput (Standard) message delivery between two services
- You want to smooth out traffic spikes — queue absorbs bursts, consumers process at their own rate
- You're triggering Lambda from a queue with back-pressure and retry control
- You need dead-letter queues and visibility timeout semantics

**Use SNS when:**
- One event needs to notify multiple downstream systems simultaneously
- You want to decouple event publishers from knowing who cares about the event
- You need message filtering so each subscriber only receives relevant messages

**Use both together (SNS → SQS fan-out) when:**
- You want fan-out delivery AND durable, reliable per-subscriber queuing
- Different subscribers need to process at different rates
- You need per-subscriber DLQs for independent failure handling
- This is the standard pattern for event-driven microservices on AWS

---

## Service Surface

### SQS Queue Types

| Attribute | Standard Queue | FIFO Queue |
|---|---|---|
| **Ordering** | Best-effort (not guaranteed) | Strict per message group ID |
| **Delivery** | At-least-once (duplicates possible) | Exactly-once processing |
| **Throughput** | Nearly unlimited | 300 msg/s (3,000/s with high-throughput + batching) |
| **Pricing** | $0.40 per million requests | $0.50 per million requests |
| **Use case** | High-volume, order-insensitive workloads | Financial transactions, order processing |

### SQS Key Parameters

| Parameter | Range / Default | Notes |
|---|---|---|
| **Message size** | Up to 256 KB | Up to 2 GB with Extended Client Library (payload in S3) |
| **Message retention** | 1 min – 14 days (default: 4 days) | Unprocessed messages deleted permanently at expiry |
| **Visibility timeout** | 0 sec – 12 hours (default: 30 sec) | How long message is hidden after receive. Set to 6x processing time. |
| **Receive wait time** | 0–20 sec (default: 0) | 0 = short polling; 20 = long polling. Always use 20. |
| **Max receive count** | 1–1000 | Failures before routing to DLQ |
| **In-flight messages** | 120,000 (Standard) / 20,000 (FIFO) | Messages received but not deleted |
| **Batch size** | 1–10 messages | Per ReceiveMessage call |
| **Delay queue** | 0–15 min | Delay before message becomes visible |

### SNS Topic Types

| Attribute | Standard Topic | FIFO Topic |
|---|---|---|
| **Ordering** | Best-effort | Strict per message group ID |
| **Delivery** | At-least-once | Exactly-once |
| **Throughput** | ~300 publish/s (higher with quota increase) | 300 msg/s (3,000/s high-throughput) |
| **Subscribers** | SQS, Lambda, HTTP, email, SMS, Firehose | SQS FIFO only |
| **Message filtering** | Yes | Yes |

### SNS Key Parameters

| Parameter | Value | Notes |
|---|---|---|
| **Message size** | Up to 256 KB | Larger payloads require pointer pattern (store in S3, send URL) |
| **Pricing** | $0.50 per million publishes | Plus delivery charges per subscriber type |
| **SMS pricing (US)** | ~$0.00645/message | Varies by country — UK ~$0.0346, AU ~$0.0369 |
| **HTTP/HTTPS delivery** | 3 retries (immediate, 20 sec, 1 min) | Then exponential backoff to 20 attempts total |
| **Topics per account** | 100,000 default | Soft limit, can be raised |
| **Subscriptions per topic** | 12,500,000 | Hard limit |

---

## Mental Model

Five primitives to understand before writing any SQS/SNS code:

**1. Point-to-point vs. fan-out**

SQS is point-to-point: a message goes to one consumer. If you have 5 consumers polling, each message is processed by exactly one of them — this is how you scale workers horizontally. SNS is fan-out: one message goes to all subscribers simultaneously. Combine them for fan-out with reliable per-subscriber delivery.

```
Producer → SNS Topic → SQS Queue A → Consumer Group A
                     → SQS Queue B → Consumer Group B
                     → Lambda C
```

**2. Standard vs. FIFO — pick based on ordering and deduplication needs**

Standard queues are faster and cheaper but may deliver duplicates and don't guarantee order. Your consumers MUST be idempotent. FIFO queues guarantee order within a message group and exactly-once processing, but have a hard throughput ceiling. Use FIFO only when ordering actually matters (financial ledgers, order state machines). Use Standard for everything else — it's cheaper and scales better.

**3. Dead Letter Queue (DLQ) — not optional**

A DLQ is a separate queue that receives messages after they've failed `maxReceiveCount` times. Without a DLQ, poison-pill messages loop forever, consuming worker capacity. Always configure a DLQ for every queue. Always set an alarm on the DLQ's ApproximateNumberOfMessagesVisible metric. DLQ messages don't auto-replay — you must manually redrive them or build a redrive Lambda.

**4. Visibility timeout — the most misunderstood setting**

When a consumer receives a message, SQS hides it from other consumers for the visibility timeout period. If the consumer processes and deletes the message before timeout, done. If not — the message reappears and another consumer picks it up. This is how SQS handles consumer crashes. The rule: set visibility timeout to at least 6x your average processing time. Too short → duplicate processing. Too long → slow retries after real failures.

**5. SNS message filtering — route at the topic level**

Instead of subscribing every queue to every topic and filtering in application code, use SNS subscription filter policies. Each subscription gets a JSON filter policy that matches attributes on the message. Only matching messages are delivered to that subscriber. This reduces cost (fewer deliveries), reduces noise (consumers only see relevant events), and keeps routing logic in infrastructure rather than application code.

---

## Common Patterns

### Pattern 1: SQS Producer / Consumer with DLQ

The fundamental SQS pattern: send messages, receive and process them, delete on success, let failures accumulate to a DLQ.

```typescript
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageBatchCommand,
} from "@aws-sdk/client-sqs";

const client = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });

const QUEUE_URL = process.env.SQS_QUEUE_URL!;

// --- Producer: send a single message ---
export async function sendMessage(payload: unknown, deduplicationId?: string) {
  const command = new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify(payload),
    // For FIFO queues only:
    // MessageGroupId: "order-events",
    // MessageDeduplicationId: deduplicationId,
    MessageAttributes: {
      eventType: {
        DataType: "String",
        StringValue: "order.created",
      },
    },
  });

  const result = await client.send(command);
  return result.MessageId;
}

// --- Producer: send a batch (up to 10 messages) ---
export async function sendBatch(payloads: unknown[]) {
  const command = new SendMessageBatchCommand({
    QueueUrl: QUEUE_URL,
    Entries: payloads.map((payload, i) => ({
      Id: String(i),
      MessageBody: JSON.stringify(payload),
    })),
  });

  const result = await client.send(command);

  if (result.Failed && result.Failed.length > 0) {
    console.error("Batch send failures:", result.Failed);
  }

  return result.Successful;
}

// --- Consumer: long-poll, process, delete ---
export async function processMessages() {
  const command = new ReceiveMessageCommand({
    QueueUrl: QUEUE_URL,
    MaxNumberOfMessages: 10,       // Process up to 10 at a time
    WaitTimeSeconds: 20,           // Long polling — always use 20
    VisibilityTimeout: 60,         // 6x expected processing time
    MessageAttributeNames: ["All"],
    AttributeNames: ["All"],
  });

  const { Messages } = await client.send(command);

  if (!Messages || Messages.length === 0) return;

  await Promise.allSettled(
    Messages.map(async (message) => {
      try {
        const body = JSON.parse(message.Body!);
        await processPayload(body);

        // Delete only after successful processing
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle!,
          })
        );
      } catch (err) {
        // Do NOT delete — message will reappear after visibility timeout
        // After maxReceiveCount failures, SQS routes to DLQ automatically
        console.error("Processing failed, message will retry:", err);
      }
    })
  );
}

async function processPayload(body: unknown) {
  // Your business logic here
  console.log("Processing:", body);
}
```

### Pattern 2: SNS → SQS Fan-Out (CDK)

One SNS topic, multiple SQS subscribers. Each subscriber gets every message. Each has its own DLQ.

```typescript
import * as cdk from "aws-cdk-lib";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";

export class EventFanOutStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Central event topic
    const orderEventsTopic = new sns.Topic(this, "OrderEventsTopic", {
      topicName: "order-events",
      displayName: "Order Events",
    });

    // --- Subscriber A: fulfillment service ---
    const fulfillmentDlq = new sqs.Queue(this, "FulfillmentDlq", {
      queueName: "fulfillment-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    const fulfillmentQueue = new sqs.Queue(this, "FulfillmentQueue", {
      queueName: "fulfillment",
      visibilityTimeout: cdk.Duration.seconds(120),
      deadLetterQueue: {
        queue: fulfillmentDlq,
        maxReceiveCount: 3,
      },
    });

    // --- Subscriber B: analytics service ---
    const analyticsDlq = new sqs.Queue(this, "AnalyticsDlq", {
      queueName: "analytics-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    const analyticsQueue = new sqs.Queue(this, "AnalyticsQueue", {
      queueName: "analytics",
      visibilityTimeout: cdk.Duration.seconds(300),
      deadLetterQueue: {
        queue: analyticsDlq,
        maxReceiveCount: 5,
      },
    });

    // Subscribe both queues to the topic
    orderEventsTopic.addSubscription(
      new subscriptions.SqsSubscription(fulfillmentQueue, {
        rawMessageDelivery: true, // Strip SNS envelope — simpler for consumers
        filterPolicy: {
          // Only deliver order.created and order.updated events
          eventType: sns.SubscriptionFilter.stringFilter({
            allowlist: ["order.created", "order.updated"],
          }),
        },
      })
    );

    orderEventsTopic.addSubscription(
      new subscriptions.SqsSubscription(analyticsQueue, {
        rawMessageDelivery: true,
        // No filter — analytics gets all events
      })
    );

    // Alarm on DLQ depth — alert on any failure
    new cloudwatch.Alarm(this, "FulfillmentDlqAlarm", {
      metric: fulfillmentDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: "Messages in fulfillment DLQ — investigate immediately",
    });

    new cloudwatch.Alarm(this, "AnalyticsDlqAlarm", {
      metric: analyticsDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
    });
  }
}
```

### Pattern 3: Publish to SNS Topic with Message Attributes

```typescript
import { SNSClient, PublishCommand, PublishBatchCommand } from "@aws-sdk/client-sns";

const snsClient = new SNSClient({ region: process.env.AWS_REGION ?? "us-east-1" });

const TOPIC_ARN = process.env.SNS_TOPIC_ARN!;

// Publish a single event with attributes (used for SNS filter policies)
export async function publishOrderEvent(
  eventType: "order.created" | "order.updated" | "order.cancelled",
  orderId: string,
  payload: unknown
) {
  const command = new PublishCommand({
    TopicArn: TOPIC_ARN,
    Message: JSON.stringify(payload),
    Subject: `Order Event: ${eventType}`,
    MessageAttributes: {
      eventType: {
        DataType: "String",
        StringValue: eventType,
      },
      orderId: {
        DataType: "String",
        StringValue: orderId,
      },
      // Number attributes can be used in filter policies with numeric operators
      orderTotal: {
        DataType: "Number",
        StringValue: "149.99",
      },
    },
  });

  const result = await snsClient.send(command);
  return result.MessageId;
}

// Publish a batch (SNS batch, up to 10 messages)
export async function publishBatch(events: Array<{ type: string; payload: unknown }>) {
  const command = new PublishBatchCommand({
    TopicArn: TOPIC_ARN,
    PublishBatchRequestEntries: events.map((event, i) => ({
      Id: String(i),
      Message: JSON.stringify(event.payload),
      MessageAttributes: {
        eventType: {
          DataType: "String",
          StringValue: event.type,
        },
      },
    })),
  });

  const result = await snsClient.send(command);

  if (result.Failed && result.Failed.length > 0) {
    console.error("SNS batch publish failures:", result.Failed);
    throw new Error(`${result.Failed.length} messages failed to publish`);
  }

  return result.Successful;
}
```

### Pattern 4: Lambda Event Source Mapping for SQS (CDK + Handler)

Wire a Lambda function to consume from an SQS queue with partial batch failure reporting.

**CDK Infrastructure:**

```typescript
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export class SqsLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const dlq = new sqs.Queue(this, "ProcessorDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });

    const queue = new sqs.Queue(this, "ProcessorQueue", {
      visibilityTimeout: cdk.Duration.seconds(180), // Must be >= 6x Lambda timeout
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    const processor = new NodejsFunction(this, "Processor", {
      entry: "src/handlers/processor.ts",
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
      environment: {
        NODE_ENV: "production",
      },
    });

    processor.addEventSource(
      new lambdaEventSources.SqsEventSource(queue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5), // Wait up to 5s to fill batch
        reportBatchItemFailures: true,              // Partial batch failure support
        // maxConcurrency: 5,                       // Limit concurrent Lambda invocations
      })
    );
  }
}
```

**Lambda Handler with Partial Batch Failure Reporting:**

```typescript
import type { SQSHandler, SQSBatchResponse, SQSRecord } from "aws-lambda";

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const failedMessageIds: string[] = [];

  await Promise.allSettled(
    event.Records.map(async (record: SQSRecord) => {
      try {
        const body = JSON.parse(record.body);
        await processRecord(body);
      } catch (err) {
        console.error(`Failed to process message ${record.messageId}:`, err);
        // Report this message as failed — SQS will retry only these
        failedMessageIds.push(record.messageId);
      }
    })
  );

  // Return failed item identifiers — SQS retries only failed messages
  // Without this, SQS retries the entire batch if any message throws
  return {
    batchItemFailures: failedMessageIds.map((id) => ({
      itemIdentifier: id,
    })),
  };
};

async function processRecord(body: unknown) {
  // Business logic here — must be idempotent
  // Standard queues can deliver duplicates
  console.log("Processing record:", body);
}
```

---

## Gotchas

**1. Always use long polling (WaitTimeSeconds: 20)**

Short polling (default, WaitTimeSeconds: 0) returns immediately even when the queue is empty, and you pay per request. Long polling waits up to 20 seconds for a message to arrive before returning. This reduces empty responses — and cost — by up to 90%. There is no reason to use short polling in production.

**2. Standard queues can and will deliver duplicates**

At-least-once delivery means a message may appear more than once. This happens during network issues, consumer crashes, and infrastructure events. Every consumer of a Standard SQS queue MUST be idempotent — processing the same message twice must produce the same result. Common approaches: check a `processedIds` set in Redis/DynamoDB before processing, use upsert semantics, design operations to be naturally repeatable.

**3. FIFO throughput ceiling is real — plan around it**

300 messages/second per queue (3,000 with high-throughput mode enabled + batching). If you need more, you cannot simply raise a limit. You must shard across multiple FIFO queues. Design your message group IDs carefully — all messages with the same group ID are processed sequentially. Use many distinct group IDs (e.g., `order-${customerId}`) to maximize parallelism within the FIFO guarantee.

**4. Visibility timeout: the most common source of duplicate processing**

If your Lambda or consumer takes longer than the visibility timeout, the message reappears in the queue and another consumer picks it up. You now have two workers processing the same message. Rule of thumb: set visibility timeout to 6x your p99 processing time. For Lambda event sources, the queue's visibility timeout must be at least 6x the Lambda function timeout. Extend the visibility timeout mid-processing if needed using `ChangeMessageVisibility`.

**5. Partial batch failures in Lambda — enable ReportBatchItemFailures**

Without `reportBatchItemFailures: true`, if any message in a batch throws an unhandled error, Lambda returns the entire batch to the queue. Every message — including successfully processed ones — gets retried. Enable partial batch failure reporting and return `batchItemFailures` from your handler so only truly failed messages are retried.

**6. DLQ messages don't auto-replay**

Messages routed to a DLQ stay there until you explicitly redrive them. Set a CloudWatch alarm on `ApproximateNumberOfMessagesVisible` for every DLQ — a DLQ with messages means something is broken and needs attention. Use the SQS console redrive feature or build a redrive Lambda that reads from the DLQ and publishes back to the source queue after fixes are deployed.

**7. SNS message filtering saves cost and complexity**

Without filter policies, every subscriber receives every message published to a topic, even if 95% are irrelevant. Use `filterPolicy` on subscriptions to match message attributes — subscribers only receive matching messages. SNS charges per delivery, so filtering at the topic level reduces both cost and the noise your consumers must handle. Filter policies support string matching, allowlists, denylists, numeric ranges, and existence checks.

**8. rawMessageDelivery vs. wrapped SNS envelope**

By default, SQS receives SNS messages wrapped in an SNS envelope: `{ "Type": "Notification", "Message": "...", "MessageAttributes": {...} }`. Your consumer has to unwrap it. Set `rawMessageDelivery: true` on the SQS subscription to receive the raw message body directly. Simpler consumers, less parsing code. The trade-off: you lose the SNS metadata (topic ARN, timestamp) in the message body. Usually worth it.

**9. Message size limit: 256 KB for both SQS and SNS**

For larger payloads, use the Claim Check pattern: store the payload in S3, send an SQS/SNS message containing the S3 key. The consumer reads the key, fetches from S3. The AWS SQS Extended Client Library (Java/Python) does this automatically. For TypeScript, implement it manually or use a community library. Do not try to serialize large objects directly into messages.

**10. SNS SMS costs vary dramatically by country**

US: ~$0.00645/message. UK: ~$0.0346. Australia: ~$0.0369. Germany: ~$0.0751. India: ~$0.0022. If you're building SMS features for international users, model out costs carefully before launch. Set SNS spending limits in the console to avoid runaway bills. Consider using a dedicated SMS provider (Twilio, Vonage) for complex SMS workflows — SNS SMS is convenient but limited on delivery reports and carrier routing control.

**11. SQS delay queues and per-message delays**

You can delay message visibility by up to 15 minutes — either at the queue level (DelaySeconds) or per-message (MessageDeduplicationId for FIFO, DelaySeconds on SendMessage for Standard). Useful for retry-with-backoff patterns, scheduled side effects, or ensuring a record is committed to the database before downstream processing begins. Cannot delay beyond 15 minutes — for longer delays, use EventBridge Scheduler or Step Functions Wait.

**12. IAM permissions: SendMessage, ReceiveMessage, DeleteMessage are separate**

Producers need `sqs:SendMessage`. Consumers need `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, and `sqs:GetQueueAttributes`. Lambda needs the consumer permissions plus `sqs:GetQueueUrl`. SNS needs `sqs:SendMessage` on the target queue to deliver messages — the SQS resource policy must explicitly allow `sns.amazonaws.com` as principal. CDK handles this automatically when you use `addSubscription`, but manual setups often miss this.

**13. FIFO deduplication: content-based vs. explicit**

FIFO queues deduplicate messages within a 5-minute window. You can use content-based deduplication (SHA-256 hash of the body, no extra work) or provide an explicit `MessageDeduplicationId`. Content-based is simpler. Explicit gives you control when two logically distinct messages happen to have the same body. Deduplication applies per message group, not globally across the queue.

---

## Official Documentation

- **SQS Developer Guide** — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html
- **SNS Developer Guide** — https://docs.aws.amazon.com/sns/latest/dg/welcome.html
- **SQS Pricing** — https://aws.amazon.com/sqs/pricing/
- **SNS Pricing** — https://aws.amazon.com/sns/pricing/
- **AWS SDK v3 — SQS Client** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sqs/
- **AWS SDK v3 — SNS Client** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sns/
- **SQS Dead-Letter Queues** — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html
- **SNS Message Filtering** — https://docs.aws.amazon.com/sns/latest/dg/sns-message-filtering.html
- **Lambda + SQS Event Source Mapping** — https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html
- **SQS Extended Client Library** — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-s3-messages.html
- **SNS → SQS Fan-Out Pattern** — https://docs.aws.amazon.com/sns/latest/dg/sns-sqs-as-subscriber.html
