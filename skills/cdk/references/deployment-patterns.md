# CDK Deployment Patterns

## CDK Pipelines: Self-Mutating CI/CD

CDK Pipelines is a high-level construct library for building CI/CD pipelines that deploy your CDK applications. The defining feature is **self-mutation**: when you change the pipeline's own code, the pipeline updates itself before deploying your application.

### How self-mutation works

1. The pipeline synthesizes on every commit
2. If the synthesized pipeline definition differs from the deployed pipeline, it updates itself first
3. Only after the pipeline is current does it proceed to deploy application stages
4. This means you never need to manually update the pipeline — pushing to main is sufficient

### Pipeline structure

A CDK Pipeline has a fixed stage sequence:

```
Source → Synth → UpdatePipeline → Assets → Deploy Stages
```

- **Source:** Connects to your source repository (CodeStar connection to GitHub, CodeCommit, etc.)
- **Synth:** Runs `cdk synth` to produce the cloud assembly
- **UpdatePipeline:** Self-mutation step — applies any changes to the pipeline itself
- **Assets:** Publishes Docker images and Lambda zip files to ECR/S3
- **Deploy Stages:** One or more `StageDeployment` stages (dev, staging, prod)

```typescript
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines';
import { App, Stack, Stage } from 'aws-cdk-lib';

// Define your application stage
class MyAppStage extends Stage {
  constructor(scope: Construct, id: string, props?: StageProps) {
    super(scope, id, props);
    new MyApplicationStack(this, 'App');
  }
}

// Define the pipeline stack
class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: 'MyAppPipeline',
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.connection('my-org/my-repo', 'main', {
          connectionArn: 'arn:aws:codestar-connections:...',
        }),
        commands: [
          'npm ci',
          'npm run build',
          'npx cdk synth',
        ],
      }),
    });

    // Add dev stage — deploys immediately
    pipeline.addStage(new MyAppStage(this, 'Dev', {
      env: { account: '111111111111', region: 'us-east-1' },
    }));

    // Add prod stage with manual approval gate
    pipeline.addStage(new MyAppStage(this, 'Prod', {
      env: { account: '222222222222', region: 'us-east-1' },
    }), {
      pre: [new ManualApprovalStep('PromoteToProd')],
    });
  }
}
```

### Cross-account deployment

To deploy from a pipeline account to a target account:

1. **Bootstrap the target account** with a trust relationship to the pipeline account:
   ```bash
   # Bootstrap target account, trusting the pipeline account
   cdk bootstrap \
     --profile target-account \
     --trust 111111111111 \
     --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
     aws://222222222222/us-east-1
   ```

2. **Specify the target environment** in the stage definition (shown above)

3. The CDK toolkit creates cross-account IAM roles during bootstrap. The pipeline assumes these roles when deploying to the target account. No manual role configuration is needed.

### Manual approvals between stages

```typescript
import { ManualApprovalStep } from 'aws-cdk-lib/pipelines';

pipeline.addStage(new MyAppStage(this, 'Prod', { env: prodEnv }), {
  pre: [
    new ManualApprovalStep('SecurityReview', {
      comment: 'Review security scan results before promoting to production',
    }),
  ],
  post: [
    // Run integration tests after deploy
    new ShellStep('IntegrationTest', {
      commands: ['npm run test:integration'],
      envFromCfnOutputs: {
        API_URL: prodStack.apiUrl, // pass outputs to the test step
      },
    }),
  ],
});
```

---

## Stack Organization Patterns

### Pattern 1: Single Stack (Small Apps)

Everything in one stack. Simple, no cross-stack reference issues.

- Use when: fewer than ~100 resources, single team, single deployment unit
- Limit: CloudFormation stacks cap at 500 resources

```typescript
class MyApp extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    // All resources here
  }
}
```

### Pattern 2: Multi-Stack with Cross-Stack References (Medium Apps)

Stacks reference each other's outputs directly. CDK handles the CloudFormation export/import wiring automatically.

- Use when: natural boundaries exist (data layer, compute layer, API layer)
- Caution: creates tight coupling — you cannot delete an exporting stack while the importing stack exists

```typescript
class DataStack extends Stack {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    this.table = new dynamodb.Table(this, 'Table', { /* ... */ });
  }
}

class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & {
    table: dynamodb.ITable;
  }) {
    super(scope, id, props);
    // CDK automatically creates CloudFormation exports/imports
    const fn = new lambda.Function(this, 'Handler', { /* ... */ });
    props.table.grantReadWriteData(fn);
    fn.addEnvironment('TABLE_NAME', props.table.tableName); // creates cross-stack ref
  }
}

// In your App:
const dataStack = new DataStack(app, 'Data');
new ApiStack(app, 'Api', { table: dataStack.table });
```

### Pattern 3: Multi-Stack with SSM Parameters (Decoupled)

Stacks communicate through SSM Parameter Store rather than CloudFormation exports. Eliminates hard deployment ordering dependencies.

- Use when: stacks are owned by different teams, or you need to deploy stacks independently
- Trade-off: values are resolved at deploy time (not synth time), so you can't use them in resource names

```typescript
import { StringParameter } from 'aws-cdk-lib/aws-ssm';

class DataStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'Table', { /* ... */ });

    // Publish the table name to SSM
    new StringParameter(this, 'TableNameParam', {
      parameterName: '/myapp/prod/table-name',
      stringValue: table.tableName,
    });
  }
}

class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Read from SSM — no direct stack dependency
    const tableName = StringParameter.valueForStringParameter(
      this, '/myapp/prod/table-name'
    );

    const fn = new lambda.Function(this, 'Handler', { /* ... */ });
    fn.addEnvironment('TABLE_NAME', tableName);
  }
}
```

### Pattern 4: Nested Stacks (Resource Limit Workaround)

Nested stacks are child stacks embedded within a parent stack. They count as a single resource in the parent but can contain up to 500 resources themselves.

- Use when: you hit the 500-resource CloudFormation limit on a single stack
- Also useful for logical grouping within a monolithic deployment
- Nested stacks deploy and roll back atomically with the parent

```typescript
import { NestedStack, NestedStackProps } from 'aws-cdk-lib';

class ComputeNestedStack extends NestedStack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: NestedStackProps & {
    table: dynamodb.ITable;
  }) {
    super(scope, id, props);
    // Resources here count against this nested stack's limit, not the parent's
  }
}

class RootStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const dataNested = new DataNestedStack(this, 'Data');
    const computeNested = new ComputeNestedStack(this, 'Compute', {
      table: dataNested.table,
    });
  }
}
```

---

## Environment Strategies

### Environment-Agnostic Stacks (Portable)

A stack is environment-agnostic when it does not specify `account` or `region`. CDK uses tokens that resolve at deploy time.

```typescript
new MyStack(app, 'MyStack'); // No env: {} — agnostic
```

- Can be deployed to any account/region with `cdk deploy`
- Cannot use environment-specific lookups (VPC lookup by name, certificate lookup, etc.)
- Best for: shared constructs, reusable patterns, apps that must be portable

### Environment-Aware Stacks (Account/Region Locked)

Specify `env` to lock a stack to a specific account and region.

```typescript
new MyStack(app, 'MyStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

// Or fully hardcoded for production:
new MyStack(app, 'ProdStack', {
  env: { account: '123456789012', region: 'us-east-1' },
});
```

- Enables context lookups (VPC, hosted zones, ACM certificates)
- Required for cross-account deployments
- Best for: production workloads, multi-account pipelines

---

## Bootstrapping

`cdk bootstrap` creates the **CDK Toolkit stack** in your AWS account — the infrastructure that CDK needs to deploy your stacks.

### What bootstrapping creates

- An S3 bucket for CloudFormation templates and Lambda assets
- An ECR repository for Docker image assets
- IAM roles that CloudFormation assumes during deployment
- A versioned SSM parameter tracking the bootstrap version

```bash
# Bootstrap the current account/region
cdk bootstrap

# Bootstrap a specific account/region
cdk bootstrap aws://123456789012/us-east-1

# Bootstrap with cross-account trust (target account trusts pipeline account)
cdk bootstrap \
  --trust 111111111111 \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
  aws://222222222222/us-east-1
```

Bootstrap once per account/region pair. Re-run when CDK releases a new bootstrap stack version (CDK will warn you during `cdk deploy` if the bootstrap is outdated).

---

## Deployment Commands

### Standard deploy

```bash
cdk deploy                        # Deploy all stacks
cdk deploy MyStack                # Deploy specific stack
cdk deploy MyStack --require-approval never   # Skip IAM/security prompts (CI)
cdk deploy --outputs-file outputs.json        # Write stack outputs to file
```

### Hotswap (development only)

Hotswap skips CloudFormation for supported resource types (Lambda code, ECS task definitions, Step Functions state machines) and updates them directly via API calls. Much faster for iteration.

```bash
cdk deploy --hotswap              # Hotswap where possible, CloudFormation for the rest
cdk deploy --hotswap-fallback     # Same — fails if any resource can't be hotswapped
```

**Never use `--hotswap` in production.** It bypasses CloudFormation's change tracking and rollback, leaving resources in a state that doesn't match your stack's recorded state.

### Watch mode (development only)

`cdk watch` monitors your source files and automatically deploys on save, using hotswap where possible.

```bash
cdk watch                         # Watch all stacks
cdk watch MyStack                 # Watch specific stack
```

Configure watched file patterns in `cdk.json`:

```json
{
  "watch": {
    "include": ["**"],
    "exclude": ["README.md", "cdk*.json", "**/*.d.ts", "node_modules/**"]
  }
}
```

### Diff before deploy

```bash
cdk diff                          # Show what will change
cdk diff MyStack                  # Diff specific stack
```

Always run `cdk diff` before deploying to production, especially after CDK version upgrades.

---

## Rollback Behavior

CloudFormation rolls back all changes in a stack if any resource update or creation fails. This is the default and correct behavior for production.

```bash
# Default — rolls back on failure
cdk deploy MyStack

# Disable rollback — stack stays in failed state for debugging
cdk deploy MyStack --no-rollback
```

**When to use `--no-rollback`:** Only during development, when you want to inspect a partially deployed stack to understand why a resource failed to create. Fix the issue, then deploy again (CloudFormation will complete the remaining changes).

**Never use `--no-rollback` in production.** A partially deployed stack is in an undefined state and may cause cascading failures.

### Recovering from failed deployments

If a stack gets stuck in `UPDATE_ROLLBACK_FAILED`:

```bash
# Continue rollback, skipping resources that can't be rolled back
aws cloudformation continue-update-rollback \
  --stack-name MyStack \
  --resources-to-skip LogicalResourceId1
```

---

## Feature Flags

CDK uses feature flags in `cdk.json` to opt into behavioral changes between CDK versions. This allows CDK to ship breaking improvements without affecting existing stacks.

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/app.ts",
  "context": {
    "@aws-cdk/aws-lambda:recognizeLayerVersion": true,
    "@aws-cdk/aws-cloudfront:defaultSecurityPolicyTLSv1.2_2021": true,
    "@aws-cdk/core:stackRelativeExports": true,
    "@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy": true
  }
}
```

**Rules for feature flags:**

- New projects (`cdk init`) get all current flags enabled by default
- Existing projects: evaluate each flag's impact on your deployed resources before enabling
- Some flags change synthesized CloudFormation — enabling them on a live stack may trigger resource replacements
- Run `cdk diff` after changing flags, before deploying

Check the CDK migration guide for your version to understand which flags are safe to enable.

---

## Handling Stateful Resources

The most dangerous CDK operations involve stateful resources — databases, S3 buckets, user pools. A misconfigured `RemovalPolicy` can cause permanent data loss.

### RemovalPolicy

Controls what happens to a resource when it is removed from the CDK stack (or when the stack is deleted).

```typescript
import { RemovalPolicy } from 'aws-cdk-lib';

// RETAIN (recommended for production data)
// Resource is orphaned — remains in AWS, must be manually deleted
const prodTable = new dynamodb.Table(this, 'ProdTable', {
  removalPolicy: RemovalPolicy.RETAIN,
  // ...
});

// DESTROY
// Resource is deleted when removed from stack — use for non-critical resources
const tempBucket = new s3.Bucket(this, 'TempBucket', {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true, // required for non-empty buckets
});

// SNAPSHOT (RDS only)
// Takes a final snapshot before deletion
const rdsInstance = new rds.DatabaseInstance(this, 'Database', {
  removalPolicy: RemovalPolicy.SNAPSHOT,
  // ...
});
```

**Default by resource type:**

| Resource | Default RemovalPolicy |
|----------|----------------------|
| DynamoDB Table | RETAIN |
| S3 Bucket | RETAIN |
| RDS Instance | SNAPSHOT |
| Most others | DESTROY |

Always explicitly set `RemovalPolicy` on stateful resources — do not rely on defaults.

### DeletionProtection

A second layer of protection at the resource level (separate from CDK RemovalPolicy). Prevents the resource from being deleted even if CloudFormation tries.

```typescript
const table = new dynamodb.Table(this, 'CriticalTable', {
  deletionProtection: true,  // CloudFormation will error if it tries to delete this
  removalPolicy: RemovalPolicy.RETAIN,
});

const db = new rds.DatabaseInstance(this, 'ProdDB', {
  deletionProtection: true,
  removalPolicy: RemovalPolicy.SNAPSHOT,
  // ...
});
```

Enable both `removalPolicy: RETAIN` and `deletionProtection: true` for production databases and critical data stores.

### Preventing accidental replacements

Some property changes trigger resource replacement rather than in-place updates. CDK will warn about this in `cdk diff` output, marked with `(requires replacement)`.

Common replacement triggers:
- Changing `tableName` or `bucketName` (physical names)
- Changing `partitionKey` on a DynamoDB table
- Changing `databaseName` on an RDS instance

To protect against accidental replacements in production:

```typescript
// Avoid physical names when possible — let CDK generate them
// CDK-generated names include the stack name + random suffix, making them unique

// If you must use a physical name, pin it and never change it
const table = new dynamodb.Table(this, 'Orders', {
  tableName: 'prod-orders-v1', // pin this, never change it
  // ...
});
```

When `cdk diff` shows a replacement for a stateful resource, stop — do not deploy. Rename the new resource, deploy the new alongside the old, migrate data, then remove the old.
