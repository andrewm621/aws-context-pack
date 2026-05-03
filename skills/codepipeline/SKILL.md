---
name: codepipeline
description: AWS CI/CD guidance — CodePipeline, CodeBuild, CodeDeploy, pipeline stages, buildspec, deployment strategies, GitHub Actions integration. Use when building CI/CD pipelines on AWS.
metadata:
  priority: 5
  docs:
    - "https://docs.aws.amazon.com/codepipeline/latest/userguide/"
    - "https://docs.aws.amazon.com/codebuild/latest/userguide/"
  pathPatterns:
    - 'buildspec.yml'
    - 'buildspec.yaml'
    - 'buildspec*.yml'
    - 'appspec.yml'
    - 'appspec.yaml'
    - '.github/workflows/**'
    - 'pipeline/**'
    - 'cicd/**'
  bashPatterns:
    - '\baws\s+codepipeline\b'
    - '\baws\s+codebuild\b'
    - '\baws\s+codedeploy\b'
  importPatterns:
    - "@aws-sdk/client-codepipeline"
    - "@aws-sdk/client-codebuild"
    - "@aws-sdk/client-codedeploy"
    - "aws-cdk-lib/aws-codepipeline"
    - "aws-cdk-lib/aws-codebuild"
    - "aws-cdk-lib/aws-codepipeline-actions"
  promptSignals:
    phrases:
      - "codepipeline"
      - "codebuild"
      - "codedeploy"
      - "buildspec"
      - "ci/cd pipeline"
      - "deployment pipeline"
      - "blue green deploy"
      - "github actions aws"
      - "build project"
      - "appspec"
---

# AWS CI/CD — CodePipeline, CodeBuild, CodeDeploy

## What It Is & When to Use It

AWS's native CI/CD suite consists of three services that work together:

- **CodePipeline** — orchestrates the end-to-end release pipeline. Defines stages (Source, Build, Test, Deploy) and the actions within each stage. It is the conductor; CodeBuild and CodeDeploy are the musicians.
- **CodeBuild** — a managed build server. It spins up a Docker container, clones your source, runs your `buildspec.yml`, and produces artifacts. No EC2 instances to maintain.
- **CodeDeploy** — deploys your built artifacts to EC2, Lambda, or ECS. Handles deployment strategies (in-place, rolling, blue/green, canary, linear) with automatic rollback on failure.

**Use AWS-native CI/CD when:**
- You need cross-account pipelines with fine-grained IAM control at each stage
- You are using CodeDeploy blue/green for ECS Fargate or EC2 and need tight ALB integration
- Enterprise compliance mandates AWS-only tooling (no third-party SaaS in the build chain)
- You are already using CDK Pipelines, which wraps CodePipeline with an excellent developer experience and self-mutation

**Use GitHub Actions instead when:**
- You want better developer experience, faster feedback loops, and a broader ecosystem of community actions
- Your team already lives in GitHub and wants CI/CD visible alongside PRs
- You need flexibility across cloud providers

**GitHub Actions + OIDC + CDK deploy** is the right default for most teams. Use CodePipeline when cross-account deployment, CodeDeploy strategies, or AWS-only compliance are requirements. CDK Pipelines (built on CodePipeline) is the recommended high-level abstraction — it handles cross-account stages, self-mutation, and asset publishing out of the box.


## Service Surface

### CodePipeline

| Property | Value |
|----------|-------|
| Pricing | $1.00 per active pipeline per month (V1). V2: $0.002 per action execution minute. First pipeline free. |
| Pipeline types | V1 (legacy) and V2 (new). Always use V2 — supports triggers, git tags, variables, and per-action timeouts. |
| Stages | Execute sequentially. A stage failure blocks later stages. |
| Actions within a stage | Execute in parallel (unless you set `runOrder` to sequence them). |
| Artifacts | S3 objects passed between actions. Encrypted with KMS. Each action declares `inputArtifacts` and `outputArtifacts`. |
| Approvals | Manual approval action pauses the pipeline until a human approves or rejects (7-day timeout). |
| Cross-account | Supported via separate IAM roles in each account + shared KMS key. |

### CodeBuild

| Property | Value |
|----------|-------|
| Pricing | $0.005/build-minute (general1.small). ARM (graviton3.small) is ~10% cheaper. |
| Build environments | Standard managed images (Amazon Linux, Ubuntu, Windows) or custom Docker images. |
| Timeout | Default 60 minutes. Maximum 8 hours. Always set explicitly — silent failures at timeout. |
| Concurrency | Default 60 concurrent builds per account (soft limit, requestable). |
| Caching | S3 cache or local cache (Docker layer, source, custom). Without caching, every build re-downloads all dependencies. |
| VPC support | Builds can run inside your VPC to access private resources (RDS, internal endpoints). Requires NAT for internet access. |
| Artifacts | Uploaded to S3 at end of build. Can also push Docker images to ECR. |

### CodeDeploy

| Property | Value |
|----------|-------|
| Pricing | Free for EC2 and Lambda. $0.02 per on-premises instance update. |
| Deployment types | EC2/On-Premises (in-place or blue/green), Lambda (canary or linear), ECS (blue/green via ALB). |
| appspec.yml | Deployment manifest — defines hooks (BeforeInstall, AfterInstall, ApplicationStart, ValidateService) for EC2 and lifecycle events for Lambda/ECS. |
| Rollback | Automatic on CloudWatch alarm or deployment failure. Manual rollback available. |
| Deployment configs | `AllAtOnce`, `HalfAtATime`, `OneAtATime` (built-in). Custom configs for canary/linear percentages. |

### Key Limits

| Limit | Value |
|-------|-------|
| Pipelines per region per account | 1,000 |
| Stages per pipeline | 50 |
| Actions per stage | 50 |
| Artifact size | 5 GB (S3 limit) |
| Manual approval timeout | 7 days |
| CodeBuild concurrent builds | 60 (soft) |
| CodeBuild max timeout | 8 hours |


## Mental Model

Five primitives to hold in your head:

### 1. CodePipeline = Orchestrator

A pipeline is a series of stages. Stages run sequentially. Actions within a stage run in parallel (by default) or in a defined order via `runOrder`. Every action belongs to one of six categories: Source, Build, Test, Deploy, Approval, or Invoke.

```
Pipeline
├── Stage: Source        → GitHub / CodeCommit / S3 / ECR trigger
├── Stage: Build         → CodeBuild action (produces artifacts)
├── Stage: Test          → CodeBuild action (runs tests, produces test report)
├── Stage: Approve       → Manual approval gate (optional)
└── Stage: Deploy
    ├── Action: Deploy to Staging   (runOrder: 1)
    └── Action: Deploy to Prod      (runOrder: 2 — waits for staging)
```

### 2. CodeBuild = On-Demand Build Server

CodeBuild spins up a fresh container for every build. Your `buildspec.yml` defines what happens inside that container. The four phases run in order — a failure in an earlier phase skips all later phases:

```
install      → install runtimes, tools, system packages
pre_build    → login to ECR, restore cache, set env vars
build        → compile, run tests, docker build
post_build   → docker push, upload artifacts, notify
```

Artifacts produced by the build (declared in the `artifacts` block) are uploaded to S3 and become the `outputArtifact` for downstream pipeline actions.

### 3. CodeDeploy = Deployment Coordinator

CodeDeploy reads `appspec.yml` from your deployment package and coordinates rolling out new code to your targets. For ECS blue/green, it manages traffic shifting between the blue target group (live) and the green target group (new version) through the ALB. For EC2, it runs lifecycle hook scripts on each instance.

### 4. Artifacts = The Pipeline's Data Bus

Artifacts are the mechanism by which stages share data. The Source stage produces an artifact (your code). The Build stage takes that as input and produces a compiled artifact. The Deploy stage takes the compiled artifact and deploys it. Artifacts are stored in an S3 bucket (one bucket per pipeline, created automatically). If you have large artifacts, monitor and clean up this bucket — it will grow without a lifecycle policy.

### 5. CDK Pipelines = The Recommended Abstraction

Raw CodePipeline requires manually wiring together IAM roles, S3 artifacts, KMS keys, and action configurations. CDK Pipelines (`pipelines` module in CDK v2) wraps all of this:
- Self-mutating: the pipeline updates itself when you change the CDK pipeline code
- Asset publishing: automatically publishes Docker images to ECR and files to S3 before deploying stacks
- Cross-account: handles cross-account IAM role assumptions out of the box
- Stage-based: add `Stage` objects (each containing CDK stacks) to add deployment environments

If you are using CDK and need CodePipeline, use CDK Pipelines. Do not hand-roll the raw constructs.


## Common Patterns

### Pattern 1: CDK Pipeline with Staging and Production Stages

The canonical CDK Pipelines setup. The pipeline self-mutates first (updates itself), then deploys to staging, then production. Wave-based deployment controls cross-account promotion.

```typescript
// lib/pipeline-stack.ts
import * as cdk from 'aws-cdk-lib';
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { MyAppStage } from './my-app-stage';

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: 'my-app-pipeline',
      // Self-mutation: pipeline updates itself before deploying your app
      selfMutation: true,
      // Use Docker in CodeBuild (required if your build uses Docker)
      dockerEnabledForSelfMutation: true,
      dockerEnabledForSynth: true,
      synth: new ShellStep('Synth', {
        // Connect to GitHub via CodeStar connection (set up in console first)
        input: CodePipelineSource.connection('my-org/my-repo', 'main', {
          connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789:connection/abc123',
        }),
        commands: [
          'npm ci',
          'npm run build',
          'npx cdk synth',
        ],
      }),
    });

    // Staging stage — deploys to staging account
    const stagingStage = pipeline.addStage(
      new MyAppStage(this, 'Staging', {
        env: { account: '111111111111', region: 'us-east-1' },
      })
    );

    // Add integration tests after staging deploy
    stagingStage.addPost(
      new ShellStep('IntegrationTests', {
        commands: ['npm run test:integration'],
        envFromCfnOutputs: {
          // Inject CloudFormation outputs (e.g., API URL) into test env
          API_URL: stagingStage.stackOutputs['ApiUrl'],
        },
      })
    );

    // Production stage — only runs after staging tests pass
    pipeline.addStage(
      new MyAppStage(this, 'Production', {
        env: { account: '222222222222', region: 'us-east-1' },
      }),
      {
        // Manual approval gate before production deploy
        pre: [
          new cdk.pipelines.ManualApprovalStep('ApproveProductionDeploy'),
        ],
      }
    );
  }
}

// lib/my-app-stage.ts
export class MyAppStage extends cdk.Stage {
  // CloudFormation outputs exposed to the pipeline
  public readonly stackOutputs: Record<string, cdk.CfnOutput> = {};

  constructor(scope: Construct, id: string, props?: cdk.StageProps) {
    super(scope, id, props);

    // Add your CDK stacks here — each stack is deployed in this stage
    const appStack = new MyAppStack(this, 'App');
    this.stackOutputs['ApiUrl'] = appStack.apiUrl;
  }
}
```

### Pattern 2: buildspec.yml for Node.js (Build, Test, Push to ECR)

The `buildspec.yml` at the root of your repo defines what CodeBuild executes. This example builds a Docker image, runs tests, and pushes to ECR.

```yaml
# buildspec.yml
version: 0.2

env:
  variables:
    NODE_ENV: production
  parameter-store:
    # Fetch from SSM Parameter Store at build start
    SOME_SECRET: /my-app/prod/some-secret
  exported-variables:
    # Export for downstream pipeline actions
    - IMAGE_TAG

phases:
  install:
    runtime-versions:
      nodejs: 22
    commands:
      - echo "Installing dependencies..."
      - npm ci --prefer-offline  # --prefer-offline uses cache if available

  pre_build:
    commands:
      - echo "Logging in to ECR..."
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY
      - IMAGE_TAG=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-8)
      - echo "Building image tag $IMAGE_TAG"
      - echo "Running unit tests..."
      - npm test

  build:
    commands:
      - echo "Building Docker image..."
      - docker build -t $ECR_REGISTRY/$ECR_REPO_NAME:$IMAGE_TAG .
      - docker tag $ECR_REGISTRY/$ECR_REPO_NAME:$IMAGE_TAG $ECR_REGISTRY/$ECR_REPO_NAME:latest

  post_build:
    commands:
      - echo "Pushing Docker image to ECR..."
      - docker push $ECR_REGISTRY/$ECR_REPO_NAME:$IMAGE_TAG
      - docker push $ECR_REGISTRY/$ECR_REPO_NAME:latest
      # Write imagedefinitions.json for CodeDeploy ECS action
      - printf '[{"name":"app","imageUri":"%s"}]' $ECR_REGISTRY/$ECR_REPO_NAME:$IMAGE_TAG > imagedefinitions.json
      - echo "Build complete."

artifacts:
  files:
    - imagedefinitions.json
    - appspec.yml
    - taskdef.json

cache:
  paths:
    # Cache node_modules between builds — speeds up install phase significantly
    - '/root/.npm/**/*'
    - 'node_modules/**/*'

reports:
  # Publish test results to CodeBuild test reporting
  jest-reports:
    files:
      - 'coverage/junit.xml'
    file-format: JUNITXML
```

### Pattern 3: GitHub Actions with OIDC for AWS Access

For teams using GitHub Actions instead of CodePipeline. OIDC eliminates long-lived IAM credentials — GitHub gets a short-lived token for each run.

```typescript
// CDK: Set up the OIDC provider and role (deploy once)
// lib/github-oidc-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class GithubOidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // GitHub's OIDC provider — create once per account
    const githubProvider = new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      // GitHub's thumbprint — verify at https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });

    // IAM role that GitHub Actions assumes during CI runs
    const githubActionsRole = new iam.Role(this, 'GithubActionsRole', {
      roleName: 'github-actions-deploy',
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
        StringEquals: {
          // CRITICAL: restrict to your repo and branch — do not use '*' here
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          // Allow any branch in your org/repo — tighten to 'repo:my-org/my-repo:ref:refs/heads/main' for prod-only
          'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:*',
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // Grant only what CI needs — not AdministratorAccess
    githubActionsRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:PutImage',
        'ecr:InitiateLayerUpload',
        'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload',
      ],
      resources: ['*'],
    }));

    githubActionsRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecs:UpdateService',
        'ecs:DescribeServices',
        'ecs:RegisterTaskDefinition',
        'iam:PassRole',
      ],
      resources: ['*'],
    }));

    new cdk.CfnOutput(this, 'RoleArn', { value: githubActionsRole.roleArn });
  }
}
```

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

permissions:
  id-token: write   # Required for OIDC token request
  contents: read

env:
  AWS_REGION: us-east-1
  ECR_REPOSITORY: my-app
  ECS_CLUSTER: my-cluster
  ECS_SERVICE: my-service
  CONTAINER_NAME: app

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure AWS credentials via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-deploy
          aws-region: ${{ env.AWS_REGION }}
          # No access keys needed — OIDC provides short-lived credentials

      - name: Login to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, push Docker image
        id: build-image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          echo "image=$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" >> $GITHUB_OUTPUT

      - name: Deploy to ECS
        uses: aws-actions/amazon-ecs-deploy-task-definition@v1
        with:
          task-definition: task-definition.json
          service: ${{ env.ECS_SERVICE }}
          cluster: ${{ env.ECS_CLUSTER }}
          wait-for-service-stability: true
          image: ${{ steps.build-image.outputs.image }}
          container-name: ${{ env.CONTAINER_NAME }}
```

### Pattern 4: CodeDeploy Blue/Green for ECS with SDK v3 Triggers

Set up blue/green ECS deployment via CDK, with a programmatic deployment trigger for custom automation workflows.

```typescript
// lib/codedeploy-bluegreen-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class BlueGreenEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ALB with blue and green target groups
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: /* your VPC */,
      internetFacing: true,
    });

    const blueTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BlueTG', {
      vpc: /* your VPC */,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/health', healthyHttpCodes: '200' },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    const greenTargetGroup = new elbv2.ApplicationTargetGroup(this, 'GreenTG', {
      vpc: /* your VPC */,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/health', healthyHttpCodes: '200' },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // Production listener routes to blue (active) target group
    const prodListener = alb.addListener('ProdListener', {
      port: 80,
      defaultTargetGroups: [blueTargetGroup],
    });

    // Test listener routes to green — for smoke tests before traffic cutover
    alb.addListener('TestListener', {
      port: 8080,
      defaultTargetGroups: [greenTargetGroup],
    });

    // ECS task definition and service
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry('my-org/my-app:latest'),
      portMappings: [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'my-app' }),
    });

    const ecsService = new ecs.FargateService(this, 'Service', {
      cluster: /* your cluster */,
      taskDefinition: taskDef,
      desiredCount: 2,
      deploymentController: {
        type: ecs.DeploymentControllerType.CODE_DEPLOY,
      },
    });

    ecsService.attachToApplicationTargetGroup(blueTargetGroup);

    // CodeDeploy application and deployment group
    const codeDeployApp = new codedeploy.EcsApplication(this, 'CodeDeployApp', {
      applicationName: 'my-app-codedeploy',
    });

    const deploymentGroup = new codedeploy.EcsDeploymentGroup(this, 'DeploymentGroup', {
      application: codeDeployApp,
      deploymentGroupName: 'my-app-deployment-group',
      service: ecsService,
      blueGreenDeploymentConfig: {
        blueTargetGroup,
        greenTargetGroup,
        listener: prodListener,
        testListener: alb.listeners[1],
        // Wait 5 min for smoke tests against green before shifting traffic
        deploymentApprovalWaitTime: cdk.Duration.minutes(5),
        // Keep blue tasks alive for 15 min after traffic shifts (for instant rollback)
        terminationWaitTime: cdk.Duration.minutes(15),
      },
      // CANARY_10PERCENT_5MINUTES: shift 10% of traffic to green, wait 5 min, then shift remainder
      deploymentConfig: codedeploy.EcsDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      // Auto-rollback on CloudWatch alarm
      autoRollback: {
        failedDeployment: true,
        deploymentInAlarm: true,
      },
    });
  }
}
```

```typescript
// Trigger a CodeDeploy ECS deployment programmatically (SDK v3)
import {
  CodeDeployClient,
  CreateDeploymentCommand,
  GetDeploymentCommand,
  DeploymentStatus,
} from '@aws-sdk/client-codedeploy';

const codeDeployClient = new CodeDeployClient({ region: 'us-east-1' });

interface EcsDeploymentInput {
  applicationName: string;
  deploymentGroupName: string;
  taskDefinitionArn: string;    // New task definition ARN
  containerName: string;
  containerPort: number;
  appSpecS3Bucket: string;      // S3 bucket containing appspec.yml
  appSpecS3Key: string;
}

export async function createEcsDeployment(input: EcsDeploymentInput): Promise<string> {
  // For ECS blue/green, CodeDeploy reads an appspec from S3
  // The appspec references the new task definition and container mapping
  const result = await codeDeployClient.send(
    new CreateDeploymentCommand({
      applicationName: input.applicationName,
      deploymentGroupName: input.deploymentGroupName,
      revision: {
        revisionType: 'S3',
        s3Location: {
          bucket: input.appSpecS3Bucket,
          key: input.appSpecS3Key,
          bundleType: 'YAML',
        },
      },
      deploymentConfigName: 'CodeDeployDefault.ECSCanary10Percent5Minutes',
      description: `Deploy task def ${input.taskDefinitionArn}`,
    })
  );

  return result.deploymentId!;
}

export async function waitForDeployment(deploymentId: string, timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await codeDeployClient.send(
      new GetDeploymentCommand({ deploymentId })
    );

    const status = result.deploymentInfo?.status;

    if (status === DeploymentStatus.SUCCEEDED) return;

    if (
      status === DeploymentStatus.FAILED ||
      status === DeploymentStatus.STOPPED
    ) {
      throw new Error(
        `Deployment ${deploymentId} ended with status ${status}: ${result.deploymentInfo?.errorInformation?.message}`
      );
    }

    await new Promise((r) => setTimeout(r, 5_000));
  }

  throw new Error(`Deployment ${deploymentId} timed out after ${timeoutMs}ms`);
}
```

```yaml
# appspec.yml — for ECS blue/green CodeDeploy deployments
# Place this in S3 or include in your build artifact.
version: 0.0
Resources:
  - TargetService:
      Type: AWS::ECS::Service
      Properties:
        TaskDefinition: <TASK_DEFINITION>   # Replaced by deployment automation
        LoadBalancerInfo:
          ContainerName: app
          ContainerPort: 3000
        # Platform version — LATEST or specific (e.g., 1.4.0)
        PlatformVersion: LATEST
Hooks:
  # Hooks run against the test listener (port 8080) before traffic shifts
  - BeforeAllowTraffic: ValidateGreenDeployment   # Lambda function name
  - AfterAllowTraffic: RunSmokeTests              # Lambda function name
```


## Gotchas

### 1. Large artifacts drive up S3 costs silently

Pipeline artifacts are stored in an S3 bucket created automatically per pipeline. Large artifacts (Docker layers shipped as tarballs, `node_modules` archives, large test datasets) accumulate without a lifecycle policy. Set a lifecycle rule on the artifacts bucket to expire objects older than 30 days, or cap artifact size by only including what downstream stages actually need.

### 2. CodeBuild timeout defaults to 60 minutes — silent failures at the limit

When a build exceeds the timeout, CodeBuild kills the build container without a useful error message in your build log. The build just stops mid-output. For long builds (large Docker images, slow test suites), set `buildTimeout` explicitly on the `Project` construct. The maximum is 8 hours.

### 3. Cross-account pipelines require a shared KMS key and explicit role trust

For a pipeline in Account A deploying to Account B:
- The artifact S3 bucket policy must grant Account B read access
- The KMS key encrypting artifacts must grant Account B `kms:Decrypt`
- Account B must have a CloudFormation deployment role that Account A's CodePipeline role can assume
- The pipeline action must specify `role` (the role to assume in Account B)

CDK Pipelines handles all of this automatically when you specify `env` on each `Stage`. If you are building cross-account pipelines manually, missing any one of these four pieces produces cryptic `AccessDenied` errors.

### 4. Pipeline V1 vs V2 — always use V2 for new pipelines

V1 pipelines lack trigger filters (you cannot filter by branch or tag), do not support pipeline-level variables, and have coarser execution mode controls. V2 pipelines support:
- Git tag and branch triggers (not just commit pushes)
- Pipeline-level variables passed at execution time
- Replaced instances mode (skip queued runs)
- Per-action timeouts

V2 pricing model is different ($0.002/action-execution-minute vs $1/pipeline/month for V1). At low build frequency, V2 is cheaper. At high frequency, calculate both. In CDK Pipelines, set `pipelineType: PipelineType.V2` on the `CodePipeline` construct.

### 5. CodeBuild caching requires explicit configuration — it is off by default

Without caching, every CodeBuild run re-downloads all npm packages, pip dependencies, or Maven artifacts. A medium Node.js project with 500 dependencies can spend 60–90 seconds on `npm ci` alone. Enable caching:

```yaml
cache:
  paths:
    - '/root/.npm/**/*'        # npm cache
    - 'node_modules/**/*'      # installed packages
    - '/root/.gradle/**/*'     # Gradle cache
    - '/root/.m2/**/*'         # Maven cache
```

In CDK, set `cache: BuildSpec.fromObject(...)` on the `Project`. Use S3 cache for sharing across build fleets; local cache for single-instance builds.

### 6. GitHub OIDC trust policy must be narrowly scoped

A GitHub OIDC trust policy with `StringLike: { sub: 'repo:*' }` lets any GitHub repository in the world assume your IAM role. Always scope the `sub` condition to your specific organization and repository:

```json
"StringLike": {
  "token.actions.githubusercontent.com:sub": "repo:my-org/my-repo:*"
}
```

For production deploys, further restrict to specific branches:
```json
"StringEquals": {
  "token.actions.githubusercontent.com:sub": "repo:my-org/my-repo:ref:refs/heads/main"
}
```

### 7. Manual approval actions time out after 7 days

If no approver acts on a manual approval action within 7 days, CodePipeline automatically fails the stage. There is no configurable extension. Build approval notifications (SNS, Slack via Lambda) and runbooks so approvals happen within the window. For long-running processes that legitimately take more than 7 days, do not use pipeline approval stages — use a Step Functions `waitForTaskToken` pattern instead.

### 8. buildspec.yml phase failures skip subsequent phases

If `pre_build` fails (e.g., ECR login fails), the `build` and `post_build` phases do not run. Artifacts are not uploaded. The pipeline reports a build failure, but the post_build notifications or cleanup logic you intended to always run will not execute. Use `finally` blocks in your commands where cleanup is critical, or separate cleanup into a separate CodeBuild action.

### 9. CodeDeploy blue/green requires an ALB — not an NLB or no load balancer

ECS blue/green deployments with CodeDeploy only work with Application Load Balancers. Network Load Balancers and direct ECS service deployments without a load balancer are not supported for blue/green. If your ECS service uses an NLB (for TCP/UDP workloads) or has no load balancer, you cannot use CodeDeploy blue/green — use the rolling update deployment controller instead.

### 10. Self-mutating CDK Pipeline: breaking pipeline code = stuck pipeline

The first stage of a CDK Pipeline updates the pipeline itself before deploying your application stacks. If you introduce a TypeScript error or CDK synth failure in your pipeline code, the self-mutation stage fails and the pipeline cannot update itself to fix the problem. You are stuck.

Recovery: manually push a fix that passes `cdk synth`, or update the pipeline via `cdk deploy PipelineStack` from your local machine. Always run `npx cdk synth` locally before pushing pipeline code changes.

### 11. CodeBuild environment variables are visible in the console

Environment variables set in a CodeBuild project (not sourced from Secrets Manager or SSM) are visible in plaintext in the AWS console. Anyone with CodeBuild read access can see them. Never put secrets, tokens, or credentials in CodeBuild environment variables. Use the `parameter-store` or `secrets-manager` blocks in `buildspec.yml` to fetch secrets at build time — these are fetched by the build agent and never displayed in the console.

### 12. Pipeline execution mode: QUEUED vs SUPERSEDED vs PARALLEL

By default (V2), CodePipeline queues executions that arrive while another is running (`QUEUED` mode). This can cause a backlog during high-commit periods. Consider `SUPERSEDED` mode for feature branch pipelines (only the latest commit matters, intermediate commits can be dropped) and `PARALLEL` mode for independent executions that do not share state. Set `executionMode` on the V2 pipeline.


## Official Documentation

- **CodePipeline User Guide** — https://docs.aws.amazon.com/codepipeline/latest/userguide/welcome.html
- **CodePipeline V2 Pipeline Features** — https://docs.aws.amazon.com/codepipeline/latest/userguide/pipeline-types.html
- **CodeBuild User Guide** — https://docs.aws.amazon.com/codebuild/latest/userguide/welcome.html
- **buildspec.yml Reference** — https://docs.aws.amazon.com/codebuild/latest/userguide/build-spec-ref.html
- **CodeDeploy User Guide** — https://docs.aws.amazon.com/codedeploy/latest/userguide/welcome.html
- **appspec.yml Reference (ECS)** — https://docs.aws.amazon.com/codedeploy/latest/userguide/reference-appspec-file-structure-resources.html
- **CDK Pipelines** — https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.pipelines-readme.html
- **CDK aws-codepipeline** — https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_codepipeline-readme.html
- **CDK aws-codebuild** — https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_codebuild-readme.html
- **CDK aws-codepipeline-actions** — https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_codepipeline_actions-readme.html
- **GitHub Actions OIDC for AWS** — https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services
- **CodeDeploy ECS Blue/Green** — https://docs.aws.amazon.com/codedeploy/latest/userguide/deployments-create-ecs-bluegreen.html
- **CodeBuild Pricing** — https://aws.amazon.com/codebuild/pricing/
- **CodePipeline Pricing** — https://aws.amazon.com/codepipeline/pricing/
- **AWS SDK v3 — CodePipeline Client** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/codepipeline/
- **AWS SDK v3 — CodeBuild Client** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/codebuild/
- **AWS SDK v3 — CodeDeploy Client** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/codedeploy/
