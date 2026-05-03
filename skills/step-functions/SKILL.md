---
name: step-functions
description: AWS Step Functions guidance — workflow orchestration, state machines, Express vs Standard, parallel execution, error handling, service integrations. Use when building multi-step workflows or orchestrating AWS services.
metadata:
  priority: 6
  docs:
    - "https://docs.aws.amazon.com/step-functions/latest/dg/"
  pathPatterns:
    - 'stepfunctions/**'
    - 'workflows/**'
    - 'state-machines/**'
    - 'asl/**'
    - '**/*.asl.json'
  bashPatterns:
    - '\baws\s+stepfunctions\b'
    - '\baws\s+sfn\b'
  importPatterns:
    - "@aws-sdk/client-sfn"
    - "aws-cdk-lib/aws-stepfunctions"
    - "aws-cdk-lib/aws-stepfunctions-tasks"
  promptSignals:
    phrases:
      - "step functions"
      - "state machine"
      - "workflow orchestration"
      - "step function"
      - "asl"
      - "parallel execution"
      - "workflow"
      - "saga pattern"
      - "orchestration"
---

# AWS Step Functions

## What It Is & When to Use It

AWS Step Functions is a fully managed workflow orchestration service. You define state machines using ASL (Amazon States Language) — a JSON-based DSL — or with the CDK's fluent TypeScript API. Step Functions coordinates calls to Lambda, DynamoDB, SQS, ECS, Bedrock, and 200+ other services, handling retries, error catching, branching, and parallel execution as first-class primitives rather than application logic.

**Use Step Functions when:**
- Your process has 3+ sequential or conditional steps that need retry/rollback logic
- You want visual execution history and per-step debugging in the console
- You're implementing a saga pattern (distributed transaction with compensating steps)
- You need a human approval gate (wait for callback pattern)
- You want to fan out over a list and collect all results before continuing
- You're calling multiple AWS services and want to avoid writing Lambda glue code

**Use alternatives instead when:**

| Scenario | Better choice |
|---|---|
| Single-step event triggered processing | Lambda directly |
| Simple event routing between services | EventBridge |
| Queue-based load leveling | SQS |
| High-volume, sub-second coordination (>10k/sec) | Custom application logic or Kinesis |
| You need < 5-minute short burst orchestration at high volume | Express Workflows |

---

## Service Surface

### Standard vs. Express Workflows

| Attribute | Standard | Express |
|---|---|---|
| **Max duration** | 1 year | 5 minutes |
| **Execution semantics** | Exactly-once | At-least-once |
| **Pricing unit** | Per state transition | Per duration + memory (GB-seconds) |
| **Pricing** | $0.025 per 1,000 state transitions | $0.00001 per GB-second + $0.000001 per invocation |
| **Execution history** | Full history in console (unlimited) | No console history — must use CloudWatch Logs |
| **Max concurrency** | Soft limit (default 1M concurrent) | Soft limit (default 1M concurrent) |
| **Use case** | Order processing, approvals, sagas, anything long-running | High-volume IoT ingestion, event processing, short ETL |

Pricing verified May 2026 against https://aws.amazon.com/step-functions/pricing/

### State Types

| State | Purpose |
|---|---|
| **Task** | Do work — call a Lambda, SDK integration, or activity |
| **Choice** | Branch on a condition — evaluates rules in order, routes to matching state |
| **Parallel** | Fan out — run multiple branches simultaneously, collect all outputs |
| **Map** | Iterate — run the same workflow steps over each item in an array |
| **Wait** | Pause — sleep for a duration or until a timestamp |
| **Pass** | Transform — inject or reshape data without calling anything |
| **Succeed** | Terminal success |
| **Fail** | Terminal failure with error and cause |

### Direct SDK Integrations (Optimistic Integrations)

Step Functions can call 200+ AWS services directly from ASL — no Lambda wrapper needed. Examples:

| Service | What you can do directly |
|---|---|
| **DynamoDB** | GetItem, PutItem, UpdateItem, DeleteItem, Query |
| **SQS** | SendMessage |
| **SNS** | Publish |
| **ECS** | RunTask (wait for completion) |
| **Bedrock** | InvokeModel, InvokeModelWithResponseStream |
| **S3** | GetObject, PutObject |
| **EventBridge** | PutEvents |
| **Lambda** | Invoke (sync or async) |
| **Glue** | StartJobRun |
| **SageMaker** | CreateTrainingJob, CreateTransformJob |

Using direct integrations cuts cost (no Lambda invocation + duration charges), reduces latency (one fewer network hop), and removes code to maintain.

### Integration Patterns

| Pattern | How it works | Use when |
|---|---|---|
| **Request/Response** | Call the service, get synchronous response | Fast SDK calls, DynamoDB reads/writes |
| **Sync (`.sync:2`)** | Start a long job, Step Functions polls until complete | ECS tasks, Glue jobs, SageMaker training |
| **Wait for Task Token (`.waitForTaskToken`)** | Pause execution until external callback resumes it | Human approval, external system confirmation |

---

## Mental Model

Five primitives to understand before writing any Step Functions workflow:

**1. Every state receives input JSON and produces output JSON.**

The execution starts with an initial input object. Each state receives JSON, does something (or nothing), and passes JSON to the next state. This JSON flows through the entire workflow. Understanding this is the foundation of everything else.

**2. The Input/Output pipeline transforms data at each step — without Lambda.**

Each Task state runs this pipeline:
```
Raw input
  → InputPath (select a sub-object to work with)
  → Parameters (reshape or add fields before calling the service)
  → [Task executes]
  → ResultSelector (pick fields out of the raw task result)
  → ResultPath (merge task output back into state input)
  → OutputPath (select what to pass to the next state)
  → Next state input
```

Most workflows only need `Parameters` (to build the service call) and `ResultPath` (to store the result without discarding the rest of the input). The others handle edge cases.

**3. Error handling replaces try/catch in distributed systems.**

Any Task state can have `Retry` and `Catch` blocks:
- `Retry` — automatically retry the state N times with configurable backoff. Use for transient failures (throttling, network errors).
- `Catch` — if retries are exhausted or a non-retried error occurs, route to a fallback state. Use for compensation (saga rollback) or graceful degradation.

This means your Lambda or service call doesn't need its own retry logic — Step Functions handles it.

**4. Standard = durable; Express = cheap and fast.**

Standard workflows maintain full execution history in the console, are exactly-once, and can run for a year. Use them for business processes where auditability matters. Express workflows are at-least-once, max 5 minutes, and have no console history — you must configure CloudWatch Logs. Use them for high-volume, short-lived coordination where the execution record isn't important.

**5. Map and Parallel are different fan-out tools.**

`Parallel` runs a fixed set of branches you define in ASL — you know the branches at design time. Good for "do A and B and C simultaneously, then continue." `Map` iterates over an array in your state — you know the work unit pattern but not how many items at runtime. Good for "process all items in this list concurrently, then aggregate." For massive parallelism (millions of items), use Distributed Map which can spin up 10,000 concurrent child executions.

---

## Common Patterns

### Pattern 1: Order Processing Workflow (Sequential Steps with Error Handling)

```typescript
import * as cdk from "aws-cdk-lib";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export class OrderWorkflowStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lambda functions for each step
    const validateFn = new NodejsFunction(this, "ValidateOrder", {
      entry: "src/handlers/validate-order.ts",
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
    });

    const chargeFn = new NodejsFunction(this, "ChargePayment", {
      entry: "src/handlers/charge-payment.ts",
      handler: "handler",
      timeout: cdk.Duration.seconds(60),
    });

    const fulfillFn = new NodejsFunction(this, "FulfillOrder", {
      entry: "src/handlers/fulfill-order.ts",
      handler: "handler",
      timeout: cdk.Duration.seconds(120),
    });

    const notifyFn = new NodejsFunction(this, "NotifyCustomer", {
      entry: "src/handlers/notify-customer.ts",
      handler: "handler",
      timeout: cdk.Duration.seconds(10),
    });

    // Failure state
    const orderFailed = new sfn.Fail(this, "OrderFailed", {
      error: "OrderProcessingFailed",
      cause: "One or more steps in the order workflow failed after retries",
    });

    // Notify on failure — send to dead letter topic before failing
    const notifyFailure = new tasks.LambdaInvoke(this, "NotifyFailure", {
      lambdaFunction: notifyFn,
      payload: sfn.TaskInput.fromObject({
        status: "FAILED",
        "orderId.$": "$.orderId",
        "error.$": "$.error",
      }),
    }).next(orderFailed);

    // Step 1: Validate
    const validateOrder = new tasks.LambdaInvoke(this, "ValidateOrder", {
      lambdaFunction: validateFn,
      resultPath: "$.validation",          // Merge result into state, don't replace it
      resultSelector: {
        "valid.$": "$.Payload.valid",
        "reason.$": "$.Payload.reason",
      },
    }).addRetry({
      errors: ["Lambda.ServiceException", "Lambda.TooManyRequestsException"],
      maxAttempts: 3,
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
    }).addCatch(notifyFailure, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    // Branch on validation result
    const isValid = new sfn.Choice(this, "IsOrderValid")
      .when(
        sfn.Condition.booleanEquals("$.validation.valid", false),
        new sfn.Fail(this, "ValidationFailed", {
          error: "ValidationFailed",
          cause: "Order failed validation",
        })
      )
      .otherwise(
        // Step 2: Charge
        new tasks.LambdaInvoke(this, "ChargePayment", {
          lambdaFunction: chargeFn,
          resultPath: "$.payment",
          resultSelector: {
            "chargeId.$": "$.Payload.chargeId",
            "status.$": "$.Payload.status",
          },
        }).addRetry({
          errors: ["PaymentThrottled"],
          maxAttempts: 2,
          interval: cdk.Duration.seconds(5),
          backoffRate: 1.5,
        }).addCatch(notifyFailure, {
          errors: ["States.ALL"],
          resultPath: "$.error",
        }).next(
          // Step 3: Fulfill
          new tasks.LambdaInvoke(this, "FulfillOrder", {
            lambdaFunction: fulfillFn,
            resultPath: "$.fulfillment",
          }).addRetry({
            errors: ["States.TaskFailed"],
            maxAttempts: 3,
            interval: cdk.Duration.seconds(10),
            backoffRate: 2,
          }).addCatch(notifyFailure, {
            errors: ["States.ALL"],
            resultPath: "$.error",
          }).next(
            // Step 4: Notify success
            new tasks.LambdaInvoke(this, "NotifyCustomer", {
              lambdaFunction: notifyFn,
              resultPath: sfn.JsonPath.DISCARD, // Don't care about notify result
            }).next(new sfn.Succeed(this, "OrderComplete"))
          )
        )
      );

    validateOrder.next(isValid);

    const stateMachine = new sfn.StateMachine(this, "OrderStateMachine", {
      definition: validateOrder,
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(1),
      tracingEnabled: true, // X-Ray tracing
    });
  }
}
```

### Pattern 2: Parallel Fan-Out with Map State

Process a batch of items concurrently and aggregate results. Uses a direct DynamoDB integration to avoid Lambda.

```typescript
import * as cdk from "aws-cdk-lib";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export class BatchProcessingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const resultsTable = new dynamodb.Table(this, "ResultsTable", {
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "itemId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const processItemFn = new NodejsFunction(this, "ProcessItem", {
      entry: "src/handlers/process-item.ts",
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
    });

    // Step 1: Process each item using Map state
    const processItems = new sfn.Map(this, "ProcessItems", {
      itemsPath: "$.items",              // Array in state to iterate over
      itemSelector: {
        "jobId.$": "$.jobId",           // Pass jobId from parent state
        "item.$": "$$.Map.Item.Value",  // $$.Map.Item.Value = current array element
        "index.$": "$$.Map.Item.Index", // $$.Map.Item.Index = current index
      },
      resultPath: "$.results",
      maxConcurrency: 10,               // IMPORTANT: always cap this
    });

    // What to do for each item
    const processAndStore = new tasks.LambdaInvoke(this, "ProcessAndTransform", {
      lambdaFunction: processItemFn,
      resultSelector: {
        "itemId.$": "$.Payload.itemId",
        "result.$": "$.Payload.result",
        "status.$": "$.Payload.status",
      },
      resultPath: "$.processed",
    }).addRetry({
      maxAttempts: 2,
      interval: cdk.Duration.seconds(1),
    }).next(
      // Direct DynamoDB write — no Lambda needed for this step
      new tasks.DynamoPutItem(this, "StoreResult", {
        table: resultsTable,
        item: {
          jobId: tasks.DynamoAttributeValue.fromString(
            sfn.JsonPath.stringAt("$.jobId")
          ),
          itemId: tasks.DynamoAttributeValue.fromString(
            sfn.JsonPath.stringAt("$.processed.itemId")
          ),
          result: tasks.DynamoAttributeValue.fromString(
            sfn.JsonPath.stringAt("$.processed.result")
          ),
          status: tasks.DynamoAttributeValue.fromString(
            sfn.JsonPath.stringAt("$.processed.status")
          ),
          processedAt: tasks.DynamoAttributeValue.fromString(
            sfn.JsonPath.stringAt("$$.Execution.StartTime")
          ),
        },
        resultPath: sfn.JsonPath.DISCARD, // Don't include DynamoDB response in output
      })
    );

    processItems.iterator(processAndStore);

    // Step 2: Parallel cleanup — run two independent branches simultaneously
    const parallel = new sfn.Parallel(this, "FinalizeJob");

    parallel.branch(
      new tasks.DynamoPutItem(this, "MarkJobComplete", {
        table: resultsTable,
        item: {
          jobId: tasks.DynamoAttributeValue.fromString(
            sfn.JsonPath.stringAt("$[0].jobId") // Parallel output is an array
          ),
          itemId: tasks.DynamoAttributeValue.fromString("_meta"),
          status: tasks.DynamoAttributeValue.fromString("COMPLETE"),
        },
        resultPath: sfn.JsonPath.DISCARD,
      })
    );

    parallel.branch(
      new tasks.SqsSendMessage(this, "NotifyCompletion", {
        queue: new cdk.aws_sqs.Queue(this, "CompletionQueue"),
        messageBody: sfn.TaskInput.fromObject({
          "jobId.$": "$[0].jobId",
          "totalItems.$": "States.ArrayLength($[0].results)",
          status: "COMPLETE",
        }),
        resultPath: sfn.JsonPath.DISCARD,
      })
    );

    processItems.next(parallel).next(new sfn.Succeed(this, "Done"));

    new sfn.StateMachine(this, "BatchStateMachine", {
      definition: processItems,
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
    });
  }
}
```

### Pattern 3: Saga Pattern with Compensation

Distributed transaction with rollback. Each step has a compensating action that runs if a later step fails.

```typescript
import * as cdk from "aws-cdk-lib";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export class TravelBookingSagaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const makeHelper = (name: string, entry: string) =>
      new NodejsFunction(this, name, {
        entry,
        handler: "handler",
        timeout: cdk.Duration.seconds(30),
      });

    const bookFlightFn       = makeHelper("BookFlight",       "src/handlers/book-flight.ts");
    const cancelFlightFn     = makeHelper("CancelFlight",     "src/handlers/cancel-flight.ts");
    const bookHotelFn        = makeHelper("BookHotel",        "src/handlers/book-hotel.ts");
    const cancelHotelFn      = makeHelper("CancelHotel",      "src/handlers/cancel-hotel.ts");
    const bookCarFn          = makeHelper("BookCar",          "src/handlers/book-car.ts");
    const cancelCarFn        = makeHelper("CancelCar",        "src/handlers/cancel-car.ts");

    // Terminal failure state
    const bookingFailed = new sfn.Fail(this, "BookingFailed", {
      error: "BookingFailed",
      cause: "Saga rolled back all completed steps",
    });

    // Compensating steps (run in reverse order during rollback)
    const cancelFlight = new tasks.LambdaInvoke(this, "CancelFlight", {
      lambdaFunction: cancelFlightFn,
      payload: sfn.TaskInput.fromJsonPathAt("$.bookings.flight"),
      resultPath: sfn.JsonPath.DISCARD,
    }).next(bookingFailed);

    const cancelHotelThenFlight = new tasks.LambdaInvoke(this, "CancelHotel", {
      lambdaFunction: cancelHotelFn,
      payload: sfn.TaskInput.fromJsonPathAt("$.bookings.hotel"),
      resultPath: sfn.JsonPath.DISCARD,
    }).next(cancelFlight);

    const cancelCarThenHotelThenFlight = new tasks.LambdaInvoke(this, "CancelCar", {
      lambdaFunction: cancelCarFn,
      payload: sfn.TaskInput.fromJsonPathAt("$.bookings.car"),
      resultPath: sfn.JsonPath.DISCARD,
    }).next(cancelHotelThenFlight);

    // Forward steps — each catches failure and rolls back what's been done
    const bookFlight = new tasks.LambdaInvoke(this, "BookFlight", {
      lambdaFunction: bookFlightFn,
      resultPath: "$.bookings.flight",
      resultSelector: { "confirmationId.$": "$.Payload.confirmationId" },
    }).addCatch(bookingFailed, {          // Flight failure: nothing to roll back yet
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    const bookHotel = new tasks.LambdaInvoke(this, "BookHotel", {
      lambdaFunction: bookHotelFn,
      resultPath: "$.bookings.hotel",
      resultSelector: { "confirmationId.$": "$.Payload.confirmationId" },
    }).addCatch(cancelFlight, {           // Hotel failure: cancel the flight
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    const bookCar = new tasks.LambdaInvoke(this, "BookCar", {
      lambdaFunction: bookCarFn,
      resultPath: "$.bookings.car",
      resultSelector: { "confirmationId.$": "$.Payload.confirmationId" },
    }).addCatch(cancelHotelThenFlight, {  // Car failure: cancel hotel + flight
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    bookFlight
      .next(bookHotel)
      .next(bookCar)
      .next(new sfn.Succeed(this, "BookingComplete"));

    new sfn.StateMachine(this, "TravelBookingSaga", {
      definition: bookFlight,
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(10),
      tracingEnabled: true,
    });
  }
}
```

### Pattern 4: Human Approval Workflow (Wait for Task Token)

Pause execution indefinitely until an external actor calls `SendTaskSuccess` or `SendTaskFailure` with the task token.

```typescript
// CDK stack
import * as cdk from "aws-cdk-lib";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export class ApprovalWorkflowStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const sendApprovalEmailFn = new NodejsFunction(this, "SendApprovalEmail", {
      entry: "src/handlers/send-approval-email.ts",
      handler: "handler",
      timeout: cdk.Duration.seconds(10),
    });

    const approveCallbackFn = new NodejsFunction(this, "ApproveCallback", {
      entry: "src/handlers/approve-callback.ts",
      handler: "handler",
      timeout: cdk.Duration.seconds(10),
    });

    // Send email with task token embedded in approve/reject links
    const sendEmail = new tasks.LambdaInvoke(this, "SendApprovalEmail", {
      lambdaFunction: sendApprovalEmailFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        "requestId.$": "$.requestId",
        "requester.$": "$.requester",
        "amount.$": "$.amount",
        "taskToken.$": "$$.Task.Token",  // $$.Task.Token injects the token
      }),
      heartbeat: cdk.Duration.hours(48), // Fail if no callback within 48h
      resultPath: "$.approval",
    });

    const approved = new sfn.Choice(this, "WasApproved")
      .when(
        sfn.Condition.stringEquals("$.approval.decision", "APPROVED"),
        new sfn.Succeed(this, "RequestApproved")
      )
      .otherwise(
        new sfn.Fail(this, "RequestRejected", {
          error: "RequestRejected",
          cause: "Approver rejected the request",
        })
      );

    sendEmail.next(approved);

    const stateMachine = new sfn.StateMachine(this, "ApprovalWorkflow", {
      definition: sendEmail,
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.days(7),
    });

    // Grant the callback Lambda permission to call SendTaskSuccess/Failure
    stateMachine.grantTaskResponse(approveCallbackFn);
  }
}
```

```typescript
// src/handlers/approve-callback.ts — called by the approver clicking a link
import {
  SFNClient,
  SendTaskSuccessCommand,
  SendTaskFailureCommand,
} from "@aws-sdk/client-sfn";

const sfnClient = new SFNClient({});

interface ApprovalEvent {
  taskToken: string;
  decision: "APPROVED" | "REJECTED";
  approverComment?: string;
}

export const handler = async (event: ApprovalEvent) => {
  if (event.decision === "APPROVED") {
    await sfnClient.send(
      new SendTaskSuccessCommand({
        taskToken: event.taskToken,
        output: JSON.stringify({
          decision: "APPROVED",
          approverComment: event.approverComment ?? "",
          approvedAt: new Date().toISOString(),
        }),
      })
    );
  } else {
    await sfnClient.send(
      new SendTaskFailureCommand({
        taskToken: event.taskToken,
        error: "RequestRejected",
        cause: event.approverComment ?? "No reason provided",
      })
    );
  }

  return { statusCode: 200 };
};
```

### Pattern 5: Starting and Querying Executions (SDK v3)

```typescript
import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
  ListExecutionsCommand,
  ExecutionStatus,
} from "@aws-sdk/client-sfn";
import { randomUUID } from "crypto";

const sfnClient = new SFNClient({ region: process.env.AWS_REGION ?? "us-east-1" });

const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

// Start a new execution
export async function startWorkflow(input: unknown): Promise<string> {
  const command = new StartExecutionCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    name: `exec-${randomUUID()}`,  // Must be unique per state machine
    input: JSON.stringify(input),
  });

  const result = await sfnClient.send(command);
  return result.executionArn!;
}

// Poll for completion (simple polling — use EventBridge or callbacks for production)
export async function waitForCompletion(
  executionArn: string,
  timeoutMs = 300_000,
  pollIntervalMs = 2_000
): Promise<{ status: string; output: unknown }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await sfnClient.send(
      new DescribeExecutionCommand({ executionArn })
    );

    if (result.status === ExecutionStatus.RUNNING) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }

    return {
      status: result.status!,
      output: result.output ? JSON.parse(result.output) : null,
    };
  }

  throw new Error(`Execution timed out after ${timeoutMs}ms: ${executionArn}`);
}

// List recent executions for a state machine
export async function listRecentExecutions(statusFilter?: ExecutionStatus) {
  const command = new ListExecutionsCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    statusFilter,
    maxResults: 20,
  });

  const result = await sfnClient.send(command);
  return result.executions ?? [];
}
```

---

## Gotchas

**1. State transition cost compounds fast on Standard workflows.**

Every state a Standard workflow visits costs $0.025 per 1,000 transitions. A 10-state workflow processing 1 million items per day = 10M transitions = $250/day = $7,500/month. For high-volume short processes, use Express Workflows — they charge per GB-second of duration, not per state.

**2. Express workflows produce no execution history in the console.**

By default, Express workflow executions are invisible after they complete — you cannot inspect inputs, outputs, or per-state data in the console. You must configure CloudWatch Logs on the state machine (`logs` property in CDK, or via the console). Always do this before going to production with Express workflows.

**3. Payload size is hard-limited at 256 KB per state input/output.**

The 256 KB limit applies to the data passed between states. It catches most people when Map state collects all child outputs into an array — if you process 100 items and each returns 5 KB of output, your Map output is 500 KB and the execution fails. Use the claim check pattern: store large data in S3, pass S3 keys through the workflow. Use `ResultPath: "$.result"` to selectively merge task output rather than replacing the whole state.

**4. Map state MaxConcurrency defaults to 0 — which means unlimited.**

`maxConcurrency: 0` in ASL means "run all iterations as fast as possible." If your array has 10,000 items and MaxConcurrency is 0, Step Functions will attempt to invoke your downstream Lambda or service 10,000 times simultaneously. This will likely throttle Lambda, overwhelm DynamoDB, or hit service quotas. Always set `MaxConcurrency` to a value your downstream services can handle.

**5. Task tokens expire and you must handle the timeout.**

When using `waitForTaskToken`, the execution pauses indefinitely by default. If the approver never clicks the link, the workflow hangs forever — counting against your concurrent execution limit and accumulating state transition charges. Always set `heartbeat` on wait-for-task-token states. Set the overall state machine `timeout` as a backstop. Handle `States.HeartbeatTimeout` in a `Catch` block.

**6. Execution names must be unique per state machine.**

If you call `StartExecution` with a name that was already used for that state machine (even for a completed execution), you get an `ExecutionAlreadyExists` error. The name uniqueness window is 90 days. Use UUIDs, include a timestamp, or derive the name from idempotency keys in your domain logic.

**7. `ResultPath: null` silently discards all task output.**

`ResultPath: null` tells Step Functions to discard the task result and pass the unchanged input to the next state. This is frequently set by mistake or left as a default, and you lose the task's return value. If you want to keep both the task output and the original input, use `ResultPath: "$.taskResult"` to merge the output under a specific key.

**8. ASL is JSON — no comments, no variables, hard to read at scale.**

Raw ASL state machine definitions get unwieldy fast. Large workflows in raw JSON are nearly impossible to maintain. Use the CDK Step Functions library (`aws-cdk-lib/aws-stepfunctions`, `aws-cdk-lib/aws-stepfunctions-tasks`) which gives you a TypeScript fluent API with autocompletion and type safety. For visualization during development, use Workflow Studio in the console — it renders CDK-generated ASL as a visual graph.

**9. Choice state requires exact type matching.**

A `StringEquals` condition on a field that contains a number will never match, even if the number's string representation equals the comparison value. `NumericEquals` on a string field throws an error. Step Functions is strict about JSON types in Choice rules — ensure your upstream tasks return data with the correct JSON types, not stringified values.

**10. Distributed Map is powerful but adds significant complexity.**

Regular Map runs iterations as child states within the same execution. Distributed Map spawns child executions — up to 10,000 concurrent — to process items from an S3 inventory file or an array. This enables processing millions of records, but child executions have their own costs (Standard: $0.025/1k transitions per child; Express: duration-based), and you need to aggregate results separately. Use Distributed Map only when regular Map concurrency limits are genuinely insufficient, not as a default.

**11. Sync integrations (`.sync:2`) poll and consume state transitions.**

When you use `sfn:startExecution.sync:2` to call a child state machine and wait for it, Step Functions polls the child execution status by consuming state transitions. A long-running child execution is not "free waiting" — it generates polling transitions that count toward your Standard workflow billing. For very long waits, prefer the task token callback pattern instead.

**12. IAM permissions for SDK integrations are not automatic.**

When you call DynamoDB, SQS, or other services directly from ASL using SDK integrations, the state machine's execution role must have IAM permissions for those API calls. CDK grant methods handle this for Lambda (`lambdaFunction.grantInvoke(stateMachine.role)`) but you must add explicit IAM policies for direct service integrations. CDK tasks like `DynamoPutItem` and `SqsSendMessage` automatically add the required permissions to the role — this is another reason to prefer CDK over raw ASL.

---

## Official Documentation

- **Step Functions Developer Guide** — https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html
- **Amazon States Language Reference** — https://docs.aws.amazon.com/step-functions/latest/dg/concepts-amazon-states-language.html
- **SDK Integrations — Supported Services** — https://docs.aws.amazon.com/step-functions/latest/dg/concepts-service-integrations.html
- **Error Handling (Retry and Catch)** — https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html
- **Map State** — https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-map-state.html
- **Distributed Map** — https://docs.aws.amazon.com/step-functions/latest/dg/concepts-asl-use-map-state-distributed.html
- **Wait for Task Token** — https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html#connect-wait-token
- **CDK — aws-stepfunctions** — https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_stepfunctions-readme.html
- **CDK — aws-stepfunctions-tasks** — https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_stepfunctions_tasks-readme.html
- **Workflow Studio** — https://docs.aws.amazon.com/step-functions/latest/dg/workflow-studio.html
- **Step Functions Pricing** — https://aws.amazon.com/step-functions/pricing/
- **AWS SDK v3 — SFN Client** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sfn/
- **Serverless Land — Step Functions Patterns** — https://serverlessland.com/patterns?services=step-functions
