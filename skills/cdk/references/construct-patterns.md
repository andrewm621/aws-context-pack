# CDK Construct Patterns

## Construct Taxonomy: L1, L2, L3

CDK constructs are organized into three levels, each adding progressively more abstraction.

### L1 — CloudFormation Resources (Cfn*)

L1 constructs are auto-generated, one-to-one mappings from CloudFormation resource types. Every property is available, nothing is inferred.

- Naming convention: `Cfn` prefix (e.g., `CfnBucket`, `CfnFunction`, `CfnTable`)
- Use when: an L2 doesn't expose the property you need, or no L2 exists yet
- Props map directly to CloudFormation schema — camelCase versions of CF property names

```typescript
import { aws_s3 as s3 } from 'aws-cdk-lib';

// L1 — full control, no defaults
const cfnBucket = new s3.CfnBucket(this, 'RawBucket', {
  bucketName: 'my-raw-bucket',
  versioningConfiguration: { status: 'Enabled' },
  lifecycleConfiguration: {
    rules: [{ status: 'Enabled', expirationInDays: 90 }],
  },
});
```

### L2 — Curated Constructs

L2 constructs wrap L1s with sensible defaults, helper methods, and type safety. They are the primary building block for most CDK code.

- No `Cfn` prefix — just the resource name (e.g., `Bucket`, `Function`, `Table`)
- Include grant methods (`grantRead`, `grantWrite`, `grantInvoke`)
- Expose convenience attributes (`.bucketArn`, `.functionName`, `.tableStreamArn`)
- Enforce secure defaults (encryption on by default for some resource types)

```typescript
import { aws_s3 as s3, aws_lambda as lambda, aws_dynamodb as dynamodb } from 'aws-cdk-lib';

// L2 — sensible defaults, helper methods
const bucket = new s3.Bucket(this, 'DataBucket', {
  versioned: true,
  encryption: s3.BucketEncryption.S3_MANAGED,
  removalPolicy: RemovalPolicy.RETAIN,
});

const table = new dynamodb.Table(this, 'RecordsTable', {
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
});

// Grant methods handle IAM automatically
bucket.grantRead(myLambda);
table.grantReadWriteData(myLambda);
```

### L3 — Patterns (Higher-Order Constructs)

L3 constructs wire multiple L2s together into a complete pattern. They live in `aws-cdk-lib/aws-*-patterns` or in third-party/custom libraries.

- Examples from CDK itself: `ApplicationLoadBalancedFargateService`, `QueueProcessingFargateService`, `LambdaRestApi`
- Accept high-level intent, make opinionated choices about supporting resources
- Best for: standard architectures that you want to deploy consistently

```typescript
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';

// L3 — creates ALB, ECS cluster, Fargate service, target group, listener, IAM roles
const service = new ApplicationLoadBalancedFargateService(this, 'WebService', {
  cluster,
  taskImageOptions: { image: ecs.ContainerImage.fromRegistry('nginx') },
  desiredCount: 2,
  publicLoadBalancer: true,
});
```

---

## When to Write Custom Constructs

Write a custom construct when:

- The same group of resources appears in multiple stacks or teams
- You want to encode organizational best practices (tagging, encryption, logging) that shouldn't be optional
- You need to bundle a resource with its monitoring, IAM, and configuration as a single deployable unit
- You're building an internal platform layer that application teams consume

Do not write custom constructs for:

- One-off resources that appear in a single stack
- Thin wrappers that only rename a prop
- Cases where an existing L3 pattern already fits

---

## Custom L2 Construct Pattern

A custom L2 wraps one primary resource with defaults, expose key attributes, and provides grant methods. It extends `Construct` directly — not the specific resource class.

### Why extend Construct, not the resource?

Extending `Construct` keeps composition explicit. It signals that this is a wrapper, not a subtype of the resource. It also lets you add supporting resources (KMS keys, log groups, SSM parameters) without fighting the parent class's constructor.

```typescript
import { Construct } from 'constructs';
import {
  aws_s3 as s3,
  aws_kms as kms,
  aws_iam as iam,
  RemovalPolicy,
  Duration,
} from 'aws-cdk-lib';

export interface SecureDataBucketProps {
  /** Retention policy — defaults to RETAIN for safety */
  removalPolicy?: RemovalPolicy;
  /** Lifecycle expiration in days — defaults to 365 */
  expirationDays?: number;
  /** Optional KMS key — creates a new one if omitted */
  encryptionKey?: kms.IKey;
}

export class SecureDataBucket extends Construct {
  /** The underlying S3 bucket */
  public readonly bucket: s3.Bucket;
  /** ARN of the bucket */
  public readonly bucketArn: string;
  /** Name of the bucket */
  public readonly bucketName: string;
  /** KMS key used for encryption */
  public readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props: SecureDataBucketProps = {}) {
    super(scope, id);

    const {
      removalPolicy = RemovalPolicy.RETAIN,
      expirationDays = 365,
    } = props;

    this.encryptionKey = props.encryptionKey ?? new kms.Key(this, 'Key', {
      enableKeyRotation: true,
      description: `${id} encryption key`,
    });

    this.bucket = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy,
      lifecycleRules: [{
        expiration: Duration.days(expirationDays),
        noncurrentVersionExpiration: Duration.days(30),
      }],
      serverAccessLogsPrefix: 'access-logs/',
    });

    // Expose the most commonly needed attributes
    this.bucketArn = this.bucket.bucketArn;
    this.bucketName = this.bucket.bucketName;
  }

  /** Grant read access to an IAM principal */
  grantRead(grantee: iam.IGrantable): iam.Grant {
    this.encryptionKey.grantDecrypt(grantee);
    return this.bucket.grantRead(grantee);
  }

  /** Grant write access to an IAM principal */
  grantWrite(grantee: iam.IGrantable): iam.Grant {
    this.encryptionKey.grantEncryptDecrypt(grantee);
    return this.bucket.grantWrite(grantee);
  }

  /** Grant read/write access to an IAM principal */
  grantReadWrite(grantee: iam.IGrantable): iam.Grant {
    this.encryptionKey.grantEncryptDecrypt(grantee);
    return this.bucket.grantReadWrite(grantee);
  }
}
```

**Usage:**

```typescript
const dataBucket = new SecureDataBucket(this, 'Reports', {
  expirationDays: 90,
});

dataBucket.grantRead(reportingLambda);
dataBucket.grantWrite(ingestionLambda);
```

---

## Custom L3 (Pattern) Construct

A custom L3 wires multiple L2 constructs — and often custom L2s — into a complete, deployable pattern. The classic example is a queue-backed worker.

```typescript
import { Construct } from 'constructs';
import {
  aws_sqs as sqs,
  aws_lambda as lambda,
  aws_lambda_event_sources as sources,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cw_actions,
  aws_sns as sns,
  Duration,
} from 'aws-cdk-lib';

export interface QueuedWorkerProps {
  handler: lambda.IFunction;
  /** Visibility timeout — must exceed Lambda timeout */
  visibilityTimeout?: Duration;
  /** Batch size for SQS trigger */
  batchSize?: number;
  /** Alert when DLQ message count exceeds this threshold */
  dlqAlarmThreshold?: number;
  alarmTopic?: sns.ITopic;
}

export class QueuedWorker extends Construct {
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly dlqAlarm: cw.Alarm;

  constructor(scope: Construct, id: string, props: QueuedWorkerProps) {
    super(scope, id);

    const {
      handler,
      visibilityTimeout = Duration.minutes(5),
      batchSize = 10,
      dlqAlarmThreshold = 1,
    } = props;

    // DLQ
    this.deadLetterQueue = new sqs.Queue(this, 'DLQ', {
      retentionPeriod: Duration.days(14),
    });

    // Main queue
    this.queue = new sqs.Queue(this, 'Queue', {
      visibilityTimeout,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // Wire Lambda to queue
    handler.addEventSource(new sources.SqsEventSource(this.queue, {
      batchSize,
      reportBatchItemFailures: true,
    }));

    // DLQ alarm
    this.dlqAlarm = new cw.Alarm(this, 'DLQAlarm', {
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: dlqAlarmThreshold,
      evaluationPeriods: 1,
      alarmDescription: `${id} dead-letter queue has messages`,
    });

    if (props.alarmTopic) {
      this.dlqAlarm.addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));
    }
  }
}
```

**Usage:**

```typescript
const worker = new QueuedWorker(this, 'OrderProcessor', {
  handler: orderProcessorFn,
  visibilityTimeout: Duration.minutes(6), // > Lambda timeout
  dlqAlarmThreshold: 5,
  alarmTopic: opsTopic,
});
```

---

## Composition vs Inheritance

**Always prefer composition (has-a) over inheritance (is-a).**

The CDK construct tree is already a composition model — constructs contain other constructs. Fighting this by subclassing resource types leads to fragile code.

| Approach | When appropriate |
|----------|-----------------|
| `class MyBucket extends Construct` (has-a `s3.Bucket`) | Almost always — wrap, don't extend |
| `class MyBucket extends s3.Bucket` | Rarely — only when adding methods to the resource itself and you fully understand the parent class |

Composition benefits:
- You can add multiple supporting resources (KMS, log groups, SSM) without constructor conflicts
- The public interface is explicit — you expose only what you intend to
- Easier to test in isolation — construct props are a clean contract

---

## Aspects: Cross-Cutting Concerns

Aspects implement the visitor pattern — they traverse the entire construct tree and can inspect or modify any node. Use them for concerns that must apply everywhere without burdening every construct author.

### Common uses

- **Tagging:** Apply cost center, environment, and owner tags to every resource
- **Compliance validation:** Enforce that all S3 buckets have versioning, all Lambdas have X-Ray tracing
- **Security checks:** Ensure no security groups allow unrestricted ingress on port 22

```typescript
import { IAspect, Annotations } from 'aws-cdk-lib';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

class RequireVersioningAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof s3.CfnBucket) {
      if (!node.versioningConfiguration) {
        Annotations.of(node).addError(
          'S3 buckets must have versioning enabled (compliance requirement)'
        );
      }
    }
  }
}

// Apply to an entire stack or a subtree
import { Aspects } from 'aws-cdk-lib';
Aspects.of(app).add(new RequireVersioningAspect());
Aspects.of(app).add(new cdk.Tag('CostCenter', 'platform-team'));
```

Aspects run after the construct tree is fully assembled, during synthesis — so they see the final state of all resources.

---

## CDK Nag: Automated Compliance Checking

CDK Nag is an open-source Aspect library that checks your stacks against compliance rule packs. Integrate it early — it's much easier to fix violations before a stack is deployed than after.

**Rule packs available:**
- `AwsSolutions` — AWS best practices (most commonly used)
- `HIPAASecurityChecks` — HIPAA requirements
- `NIST80053R5Checks` — NIST 800-53 Rev 5
- `PCIDSS321Checks` — PCI DSS 3.2.1

```typescript
import { NagSuppressions, AwsSolutionsChecks } from 'cdk-nag';
import { Aspects } from 'aws-cdk-lib';

// Add to your app or stack
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Suppress a specific rule with justification
NagSuppressions.addResourceSuppressions(myBucket, [
  {
    id: 'AwsSolutions-S1',
    reason: 'Access logging bucket — logging to itself would create a loop',
  },
]);

// Suppress by path for multiple resources
NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'Managed policies used for Lambda basic execution — reviewed and accepted',
  },
]);
```

Run CDK Nag as part of `cdk synth` in CI. A synthesis failure from CDK Nag means the stack does not meet your compliance bar — it will not deploy.

---

## Escape Hatches: Accessing the Underlying L1

When an L2 doesn't expose a property you need, use the escape hatch pattern to access the underlying L1 (`CfnResource`).

```typescript
import { aws_lambda as lambda } from 'aws-cdk-lib';

const fn = new lambda.Function(this, 'MyFunction', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda'),
});

// Access the underlying L1 via .node.defaultChild
const cfnFn = fn.node.defaultChild as lambda.CfnFunction;

// Set a property not exposed by L2
cfnFn.snapStart = {
  applyOn: 'PublishedVersions',
};

// Or use addPropertyOverride for arbitrary CloudFormation properties
cfnFn.addPropertyOverride('SnapStart.ApplyOn', 'PublishedVersions');
```

**Use escape hatches sparingly.** They couple your code to the underlying CloudFormation schema and bypass L2 type safety. Prefer waiting for L2 support or contributing it upstream.

---

## Testing Constructs

### Unit Tests with `Template.fromStack()`

CDK's `assertions` module lets you test that a stack synthesizes to the expected CloudFormation resources without deploying.

```typescript
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SecureDataBucket } from '../lib/secure-data-bucket';

test('creates an encrypted, versioned S3 bucket', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  new SecureDataBucket(stack, 'TestBucket', { expirationDays: 90 });

  const template = Template.fromStack(stack);

  // Assert resource count
  template.resourceCountIs('AWS::S3::Bucket', 1);

  // Assert properties
  template.hasResourceProperties('AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [{
        ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' },
      }],
    },
  });

  // Assert KMS key is created
  template.resourceCountIs('AWS::KMS::Key', 1);
});

test('blocks all public access', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  new SecureDataBucket(stack, 'TestBucket');

  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});
```

### Snapshot Tests for Drift Detection

Snapshot tests capture the full synthesized CloudFormation template and fail when it changes unexpectedly. Use them to catch unintended changes from CDK version upgrades or refactors.

```typescript
test('stack matches snapshot', () => {
  const app = new App();
  const stack = new MyApplicationStack(app, 'SnapshotStack');
  const template = Template.fromStack(stack);

  expect(template.toJSON()).toMatchSnapshot();
});
```

When you intentionally change the stack, update snapshots with `jest --updateSnapshot`. Review the diff carefully — each line represents a real infrastructure change.

### Recommended test coverage

- One unit test per significant behavior (encryption, versioning, IAM grants, alarms)
- One snapshot test per stack to catch drift
- Test grant methods by verifying IAM policy documents synthesize correctly
- For L3 patterns, test that supporting resources (DLQ, alarms) are created alongside the primary resource
