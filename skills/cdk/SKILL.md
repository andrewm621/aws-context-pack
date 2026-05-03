---
name: cdk
description: AWS CDK guidance — infrastructure as code with TypeScript/Python, construct patterns, L1/L2/L3 constructs, stacks, deployment, testing. Use when building or configuring AWS infrastructure with CDK.
metadata:
  priority: 7
  docs:
    - "https://docs.aws.amazon.com/cdk/v2/guide/"
  pathPatterns:
    - 'cdk.json'
    - 'cdk.out/**'
    - 'lib/*-stack.ts'
    - 'lib/*-stack.js'
    - 'bin/*.ts'
    - 'bin/*.js'
    - 'stacks/**'
    - 'constructs/**'
    - 'cdk.context.json'
  bashPatterns:
    - '\bcdk\s+(deploy|synth|diff|destroy|bootstrap|ls|list|watch)\b'
    - '\bnpx\s+cdk\b'
  importPatterns:
    - "aws-cdk-lib"
    - "constructs"
  promptSignals:
    phrases:
      - "cdk"
      - "cdk deploy"
      - "cdk synth"
      - "cdk stack"
      - "cdk construct"
      - "infrastructure as code"
      - "cloudformation stack"
      - "cdk bootstrap"
      - "l2 construct"
      - "cdk pipeline"
---

## What It Is & When to Use It

AWS CDK (Cloud Development Kit) is an open-source infrastructure-as-code framework that lets you define cloud infrastructure using familiar programming languages — TypeScript, Python, Java, C#, and Go. CDK synthesizes your code into CloudFormation templates and manages deployment. The CloudFormation layer handles state tracking, rollback, drift detection, and resource ordering automatically.

**Use CDK when:**
- You are already in the AWS ecosystem and want the highest-productivity IaC tool available
- Your infrastructure has programmatic logic — loops, conditionals, computed values, shared abstractions
- You want to share infrastructure patterns as reusable components (custom constructs, published on Construct Hub)
- You need to manage cross-stack dependencies, multi-account deployments, or self-mutating pipelines
- Your team already knows TypeScript or Python and wants infrastructure to live in the same codebase as application code

**Do not reach for CDK when:**
- You need to manage existing manually-created resources without importing them (use `cdk import` carefully)
- You have a Terraform-first organization with established state management (migration cost is real)
- Your infrastructure is extremely simple and a single CloudFormation template or SAM template is more readable

**TypeScript is the recommended language.** The CDK team writes in TypeScript first; all other language bindings are generated via jsii. TypeScript gives you the best autocomplete, the most up-to-date L2 constructs, and access to all community libraries on Construct Hub.


## Service Surface

### Construct Levels

| Level | Name | Description | When to Use |
|-------|------|-------------|-------------|
| L1 | `Cfn*` (CloudFormation resources) | One-to-one mapping to CloudFormation resource types. No defaults, no opinions. | When a service has no L2, or when you need a property that the L2 doesn't expose yet |
| L2 | Standard constructs | High-level abstractions with secure defaults, grant methods, metric helpers, and event bindings | Default choice for most resources (Lambda, S3, DynamoDB, RDS, etc.) |
| L3 | Patterns | Multi-resource patterns that encode an architecture (e.g., `LambdaRestApi`, `ApplicationLoadBalancedFargateService`) | When the pattern matches your architecture exactly — saves significant boilerplate |

### Supported Languages

| Language | Status | Notes |
|----------|--------|-------|
| TypeScript | Recommended | First-class, used internally by CDK team |
| Python | Stable | Strong community adoption, good for data/ML teams |
| Java | Stable | Verbose but fully supported |
| C# | Stable | Strong in enterprise .NET shops |
| Go | Stable | Less community library coverage |

### Key Packages

| Package | Purpose |
|---------|---------|
| `aws-cdk-lib` | All AWS L2 constructs (single package in CDK v2) |
| `constructs` | Base `Construct` class — required peer dependency |
| `aws-cdk` | CDK CLI (install globally or use npx) |
| `cdk-nag` | Security and compliance rule packs (NIST, CIS, HIPAA, PCI) |
| `@aws-cdk/integ-tests-alpha` | Integration test framework |
| `@aws-cdk/aws-lambda-nodejs` | Node.js Lambda with esbuild bundling (alpha, but widely used) |

### CLI Commands

| Command | Description |
|---------|-------------|
| `cdk bootstrap` | Provision CDK toolkit resources in account/region — required once before first deploy |
| `cdk synth` | Synthesize CloudFormation templates (writes to `cdk.out/`) |
| `cdk diff` | Show infrastructure changes before deploying |
| `cdk deploy` | Deploy one or more stacks |
| `cdk deploy --hotswap` | Skip CloudFormation for Lambda/ECS changes (dev only, never production) |
| `cdk watch` | Watch for changes and auto-deploy (uses hotswap by default) |
| `cdk destroy` | Delete a stack and its resources (respects removal policies) |
| `cdk ls` | List all stacks in the app |
| `cdk doctor` | Check environment for common configuration issues |
| `cdk import` | Import existing resources into CDK management |

### Pricing and Limits

CDK itself is free and open source. You pay for the AWS resources CDK provisions. CloudFormation (the underlying engine) is also free.

| Limit | Value |
|-------|-------|
| Resources per stack | 500 |
| Stacks per account per region | 2,000 (soft) |
| Outputs per stack | 200 |
| CloudFormation template size (inline) | 51,200 bytes |
| CloudFormation template size (S3) | 1 MB |
| Nested stack depth | 10 levels |
| Parameters per stack | 200 |


## Mental Model

### 1. App → Stack → Construct Hierarchy

Think of CDK like a React component tree, but for infrastructure. Every CDK entity is a `Construct`. Constructs compose into trees. The root is the `App`. `Stack` is a deployable unit (one CloudFormation stack). Everything else lives inside stacks.

```
App
├── Stack (MyApp-Dev)
│   ├── VPC (L2)
│   ├── ECS Cluster (L2)
│   │   └── FargateService (L3 pattern)
│   └── RDS Instance (L2)
└── Stack (MyApp-Prod)
    └── ...
```

Every construct receives three arguments: `scope` (parent), `id` (logical name within parent), and `props` (configuration). The `id` must be unique within its scope. The full tree path becomes the logical ID used in CloudFormation.

### 2. L1 / L2 / L3 Construct Layers

- **L1 (`CfnBucket`, `CfnFunction`, etc.):** Raw CloudFormation. Every property is optional and unvalidated. Property names match CloudFormation exactly. Use when you need a resource or property that has no L2 yet.
- **L2 (`s3.Bucket`, `lambda.Function`, etc.):** Opinionated wrappers with secure defaults, type-safe props, `.grant*()` IAM helpers, `.metric*()` CloudWatch helpers, and `.on*()` event source methods. This is where you spend most of your time.
- **L3 (`apigateway.LambdaRestApi`, `ecs_patterns.ApplicationLoadBalancedFargateService`, etc.):** Multi-resource patterns. They create several L2 constructs internally and wire them together. Convenient when the pattern matches your architecture; restrictive when you need to deviate.

### 3. Synthesis Flow

```
CDK TypeScript/Python code
        ↓  cdk synth
CloudFormation templates (cdk.out/)
        ↓  cdk deploy
CloudFormation service
        ↓
AWS resources (EC2, Lambda, S3, ...)
```

Synthesis is a pure local operation — it runs your code, resolves tokens, and writes JSON templates. No AWS API calls happen during synth (except context lookups). This means `cdk synth` is fast and safe to run in CI without credentials (if you avoid context lookups).

### 4. Environments: Account/Region Binding

A stack can be environment-agnostic or environment-aware.

**Environment-agnostic** (no `env` prop): The template uses pseudo-parameters (`AWS::AccountId`, `AWS::Region`). Portable but cannot use environment-specific context lookups (VPC IDs, AZs, etc.).

**Environment-aware** (explicit `env`): Hardcodes account and region into the template. Required for cross-stack references across accounts/regions, and for `Vpc.fromLookup()`.

```typescript
new MyStack(app, 'MyStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
```

**Context values** (in `cdk.context.json`) are cached lookups — VPC IDs, AZ lists, AMI IDs. They are checked into version control intentionally so that synth is reproducible. Delete the file and re-synth to force a refresh from AWS.

### 5. Assets: Code and Docker Bundling

CDK handles bundling and uploading automatically:
- **Lambda code:** CDK uploads a zip to the bootstrap S3 bucket and generates the correct `S3Key` reference in the template.
- **Docker images:** CDK builds the image, tags it, and pushes it to the bootstrap ECR repository.
- **`cdk deploy` with assets requires AWS credentials** even though synth does not (unless using `--asset-metadata false`).

Assets are content-addressed (hash of content). CDK only uploads if the hash changes. This makes deployments fast when Lambda code hasn't changed.


## Common Patterns

### Pattern 1: Basic Stack — Lambda + API Gateway + DynamoDB

```typescript
// lib/api-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB table with explicit removal policy
    const table = new dynamodb.Table(this, 'ItemsTable', {
      tableName: `${id}-items`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Always set this explicitly — default is RETAIN for Table, but be intentional
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // Node.js Lambda with esbuild bundling
    const handler = new nodejs.NodejsFunction(this, 'ApiHandler', {
      entry: 'src/handlers/api.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: {
        TABLE_NAME: table.tableName,
      },
      bundling: {
        // Exclude AWS SDK v3 — it's available in the Lambda runtime
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
      // AWS SDK v3 clients are fine to use — they're in the runtime
    });

    // Grant Lambda read/write on the table
    table.grantReadWriteData(handler);

    // REST API with Lambda proxy integration
    const api = new apigateway.RestApi(this, 'ItemsApi', {
      restApiName: `${id}-api`,
      deployOptions: {
        stageName: 'v1',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const items = api.root.addResource('items');
    items.addMethod('GET', new apigateway.LambdaIntegration(handler));
    items.addMethod('POST', new apigateway.LambdaIntegration(handler));

    const item = items.addResource('{id}');
    item.addMethod('GET', new apigateway.LambdaIntegration(handler));
    item.addMethod('PUT', new apigateway.LambdaIntegration(handler));
    item.addMethod('DELETE', new apigateway.LambdaIntegration(handler));

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
```

Lambda handler using AWS SDK v3:

```typescript
// src/handlers/api.ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const { httpMethod, pathParameters, body } = event;

  if (httpMethod === 'GET' && pathParameters?.id) {
    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: pathParameters.id, sk: 'ITEM' },
    }));
    return { statusCode: 200, body: JSON.stringify(result.Item ?? null) };
  }

  if (httpMethod === 'POST' && body) {
    const item = JSON.parse(body);
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { pk: item.id, sk: 'ITEM', ...item },
    }));
    return { statusCode: 201, body: JSON.stringify({ id: item.id }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Unsupported operation' }) };
};
```

### Pattern 2: Custom L2 Construct (Reusable Pattern)

Encapsulate a Lambda + SQS queue + DLQ pattern into a reusable construct:

```typescript
// constructs/queued-worker.ts
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

export interface QueuedWorkerProps {
  entry: string;
  handler?: string;
  batchSize?: number;
  visibilityTimeout?: cdk.Duration;
  maxReceiveCount?: number;
  environment?: Record<string, string>;
}

export class QueuedWorker extends Construct {
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly workerFn: lambda.Function;

  constructor(scope: Construct, id: string, props: QueuedWorkerProps) {
    super(scope, id);

    const visibilityTimeout = props.visibilityTimeout ?? cdk.Duration.seconds(30);

    this.deadLetterQueue = new sqs.Queue(this, 'DLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    this.queue = new sqs.Queue(this, 'Queue', {
      visibilityTimeout,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: props.maxReceiveCount ?? 3,
      },
    });

    this.workerFn = new nodejs.NodejsFunction(this, 'Worker', {
      entry: props.entry,
      handler: props.handler ?? 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: visibilityTimeout,
      environment: {
        QUEUE_URL: this.queue.queueUrl,
        ...props.environment,
      },
    });

    this.workerFn.addEventSource(new lambdaEventSources.SqsEventSource(this.queue, {
      batchSize: props.batchSize ?? 10,
      reportBatchItemFailures: true,
    }));

    // Expose CloudWatch alarm on DLQ depth as a convenience
    new cdk.CfnOutput(this, 'DLQUrl', { value: this.deadLetterQueue.queueUrl });
  }

  // Allow callers to grant other constructs permission to send to this queue
  public grantSendMessages(grantee: cdk.aws_iam.IGrantable): cdk.aws_iam.Grant {
    return this.queue.grantSendMessages(grantee);
  }
}
```

Usage in a stack:

```typescript
const emailWorker = new QueuedWorker(this, 'EmailWorker', {
  entry: 'src/workers/email.ts',
  batchSize: 5,
  environment: { SES_FROM_ADDRESS: 'noreply@example.com' },
});

// Grant the API Lambda permission to enqueue
emailWorker.grantSendMessages(apiHandler);
```

### Pattern 3: Cross-Stack References

Split infrastructure into separate stacks with typed exports:

```typescript
// lib/data-stack.ts
export class DataStack extends cdk.Stack {
  // Expose as typed properties — not CfnOutput — for cross-stack refs
  public readonly table: dynamodb.Table;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.bucket = new s3.Bucket(this, 'AssetsBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });
  }
}

// lib/api-stack.ts
interface ApiStackProps extends cdk.StackProps {
  dataStack: DataStack;
}

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const handler = new nodejs.NodejsFunction(this, 'Handler', {
      entry: 'src/handlers/api.ts',
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: {
        TABLE_NAME: props.dataStack.table.tableName,
        BUCKET_NAME: props.dataStack.bucket.bucketName,
      },
    });

    // CDK resolves these as CloudFormation cross-stack references automatically
    props.dataStack.table.grantReadWriteData(handler);
    props.dataStack.bucket.grantReadWrite(handler);
  }
}

// bin/app.ts
const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const dataStack = new DataStack(app, 'Data', { env });
new ApiStack(app, 'Api', { env, dataStack });
```

Note: Cross-stack references generate CloudFormation Exports/Imports. Once deployed, the exporting stack cannot be modified to remove an export that another stack imports. Plan your stack boundaries carefully before first deploy.

### Pattern 4: CDK Pipeline (Self-Mutating CI/CD)

```typescript
// lib/pipeline-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as pipelines from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { DataStack } from './data-stack';
import { ApiStack } from './api-stack';

// Wrap stacks into a Stage for environment promotion
class AppStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props?: cdk.StageProps) {
    super(scope, id, props);
    const dataStack = new DataStack(this, 'Data');
    new ApiStack(this, 'Api', { dataStack });
  }
}

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: 'MyAppPipeline',
      synth: new pipelines.ShellStep('Synth', {
        input: pipelines.CodePipelineSource.gitHub('my-org/my-repo', 'main', {
          authentication: cdk.SecretValue.secretsManager('github-token'),
        }),
        commands: [
          'npm ci',
          'npm run build',
          'npx cdk synth',
        ],
      }),
      // Pipeline will update itself when CDK code changes
      selfMutation: true,
    });

    // Add staging environment — deploys automatically
    pipeline.addStage(new AppStage(this, 'Staging', {
      env: { account: '111111111111', region: 'us-east-1' },
    }));

    // Add production with manual approval gate
    pipeline.addStage(new AppStage(this, 'Production', {
      env: { account: '222222222222', region: 'us-east-1' },
    }), {
      pre: [new pipelines.ManualApprovalStep('PromoteToProduction')],
    });
  }
}
```

The pipeline is self-mutating: when you push changes to the pipeline stack itself, it updates itself before proceeding to deploy application stacks. This means you never need to manually run `cdk deploy` on the pipeline stack after the first time.


## Gotchas

### 1. Bootstrap is Required Before First Deploy

`cdk bootstrap aws://ACCOUNT/REGION` must run once per account/region combination before any `cdk deploy`. Bootstrap creates the CDK toolkit stack: an S3 bucket for assets, an ECR repository for Docker images, and IAM roles for the pipeline. Without it, deploys fail with cryptic permission errors.

For multi-account setups, bootstrap each target account with trust from the pipeline account:

```bash
cdk bootstrap aws://TARGET_ACCOUNT/us-east-1 \
  --trust PIPELINE_ACCOUNT_ID \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

### 2. Context Values Are Cached — Stale Values Cause Drift

`cdk.context.json` caches the results of environment lookups (`Vpc.fromLookup()`, `HostedZone.fromLookup()`, etc.). This file is checked into version control intentionally — it makes synth reproducible without AWS credentials. But if the underlying resource changes (VPC subnets updated, new AZs added), the cached value becomes stale. To refresh:

```bash
# Delete specific key
cdk context --reset aws:vpc:...

# Or delete the whole file and re-synth
rm cdk.context.json && cdk synth
```

### 3. Logical ID Stability — Renaming Destroys Stateful Resources

CDK derives CloudFormation logical IDs from the construct tree path. If you rename a construct ID, CDK sees a deletion of the old resource and creation of a new one. For stateful resources (DynamoDB, RDS, S3), this means data loss.

```typescript
// BEFORE — logical ID includes "UsersTable"
const table = new dynamodb.Table(this, 'UsersTable', { ... });

// AFTER — renaming to "Users" changes the logical ID → CloudFormation will DELETE and recreate
const table = new dynamodb.Table(this, 'Users', { ... });
```

To rename a construct without replacing its resource, use `overrideLogicalId()`:

```typescript
const table = new dynamodb.Table(this, 'Users', { ... });
(table.node.defaultChild as dynamodb.CfnTable).overrideLogicalId('UsersTable');
```

Plan your construct IDs before first deploy for stateful resources.

### 4. Cross-Stack Reference Locks

Once a CloudFormation Export is consumed by another stack (via cross-stack reference), the exporting stack cannot remove or rename that export until the consumer stack is updated first. This creates an ordering dependency during refactors. If you get `Export cannot be deleted as it is in use by...` errors, update the consuming stack to remove the reference first, deploy it, then update the exporting stack.

### 5. CDK Version Pinning — All Packages Must Match

In CDK v2, `aws-cdk-lib` is a single package, but `aws-cdk` (CLI) and `constructs` (peer dep) must align. Mismatches cause synth failures or subtle runtime errors. Keep all three in sync:

```json
{
  "dependencies": {
    "aws-cdk-lib": "2.170.0",
    "constructs": "^10.0.0"
  },
  "devDependencies": {
    "aws-cdk": "2.170.0"
  }
}
```

Use `npm update aws-cdk-lib aws-cdk` together, never separately.

### 6. `cdk destroy` Does Not Delete Retained Resources

Resources with `removalPolicy: cdk.RemovalPolicy.RETAIN` (the default for stateful resources like S3 buckets and DynamoDB tables) are orphaned — not deleted — when `cdk destroy` runs. The stack deletes, but the resource stays. This is intentional for production safety, but catches people off guard in dev/test environments. Set `removalPolicy: cdk.RemovalPolicy.DESTROY` explicitly for dev stacks:

```typescript
const bucket = new s3.Bucket(this, 'Bucket', {
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  autoDeleteObjects: true, // Required to empty the bucket before deletion
});
```

`autoDeleteObjects: true` deploys a custom Lambda resource that empties the bucket before CloudFormation deletes it. Without it, deleting a non-empty bucket fails.

### 7. CloudFormation 500 Resource Limit Per Stack

CloudFormation hard-limits each stack to 500 resources. L2 constructs generate multiple resources each (a `NodejsFunction` generates a Lambda function, IAM role, and log group — that's 3 resources). Large applications hit this faster than expected. Split large stacks at logical boundaries (data tier, API tier, frontend tier) and use cross-stack references to wire them together.

Check your resource count before hitting the limit:

```bash
cdk synth MyStack | grep -c '"Type": "AWS::'
```

### 8. Hotswap Is for Development Only

`cdk deploy --hotswap` skips CloudFormation and directly updates Lambda code, ECS task definitions, and Step Functions state machines. It is significantly faster (seconds vs. minutes), but it bypasses CloudFormation entirely — no rollback, no drift detection, no consistency with the template. Never use `--hotswap` in staging or production environments. Configure your CI pipeline to always use standard `cdk deploy`.

`cdk watch` uses hotswap by default. It's a local development tool only.

### 9. RemovalPolicy Defaults Vary by Resource — Always Set Explicitly

Different L2 constructs have different `removalPolicy` defaults. DynamoDB tables default to `RETAIN`. S3 buckets default to `RETAIN`. Lambda functions default to `DESTROY`. Relying on implicit defaults leads to surprises. For any stateful resource (database, bucket, queue with important messages), always declare the removal policy explicitly so your intent is visible in the code.

### 10. Tokens Are Not Strings — Don't Manipulate Them at Synth Time

CDK uses "tokens" — lazy placeholders — for values that are only known after deployment (like a resource ARN or logical name). Tokens look like strings but aren't. Operations like `.split()`, `.replace()`, or string template literals produce incorrect results at synth time.

```typescript
// WRONG — this will not work as expected
const bucketName = myBucket.bucketName;
const prefix = bucketName.split('-')[0]; // Returns garbage token, not a real split

// RIGHT — use CDK's Fn functions for token manipulation
const prefix = cdk.Fn.select(0, cdk.Fn.split('-', myBucket.bucketName));
```

Common Fn functions: `Fn.join`, `Fn.split`, `Fn.select`, `Fn.sub`, `Fn.if`, `Fn.conditionEquals`.

### 11. Environment Variables Cannot Reference Tokens at Build Time

Lambda environment variables are resolved at deploy time, not build time. You cannot use a token in bundling configuration or at synthesis time where a real string is needed. For bundling-time configuration (like external module lists), use literal strings only.

### 12. IAM Policies Generated by `grant*` Methods Are Least-Privilege

The `grant*` methods (`grantRead`, `grantReadWriteData`, `grantInvoke`, etc.) generate IAM policies scoped to the specific resource ARN. They are least-privilege by design. When you add a new operation your code performs (e.g., `PutObject` after only granting `GetObject`), the deploy succeeds but the Lambda gets a runtime permission error. Always match your `grant*` calls to the actual DynamoDB/S3/SQS operations your code performs.


## Official Documentation

- **CDK v2 Developer Guide:** https://docs.aws.amazon.com/cdk/v2/guide/
- **CDK v2 API Reference:** https://docs.aws.amazon.com/cdk/api/v2/
- **Construct Hub** (community and AWS constructs): https://constructs.dev
- **CDK Patterns** (architecture patterns library): https://cdkpatterns.com
- **CDK GitHub repository:** https://github.com/aws/aws-cdk
- **CDK Pipelines reference:** https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.pipelines-readme.html
- **cdk-nag** (security compliance packs): https://github.com/cdklabs/cdk-nag
- **AWS CDK Workshop** (hands-on tutorial): https://cdkworkshop.com
- **CDK Migration Guide (v1 → v2):** https://docs.aws.amazon.com/cdk/v2/guide/migrating-v2.html
