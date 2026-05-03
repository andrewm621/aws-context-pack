---
name: ecs-fargate
description: Amazon ECS with Fargate guidance — container orchestration, task definitions, services, load balancing, auto-scaling, service mesh. Use when running containers on AWS without managing servers.
metadata:
  priority: 6
  docs:
    - "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/"
  pathPatterns:
    - 'Dockerfile'
    - 'docker-compose*.yml'
    - 'docker-compose*.yaml'
    - 'ecs/**'
    - 'containers/**'
    - 'task-definitions/**'
    - '.aws/task-definition.json'
  bashPatterns:
    - '\baws\s+ecs\b'
    - '\bdocker\s+(build|push|pull|run)\b'
    - '\bcopilot\s+'
  importPatterns:
    - "@aws-sdk/client-ecs"
    - "aws-cdk-lib/aws-ecs"
    - "aws-cdk-lib/aws-ecs-patterns"
  promptSignals:
    phrases:
      - "ecs"
      - "fargate"
      - "container"
      - "task definition"
      - "ecs service"
      - "docker deploy"
      - "container orchestration"
      - "ecs cluster"
      - "fargate task"
      - "copilot"
---

# Amazon ECS with Fargate

## What It Is & When to Use It

Amazon ECS (Elastic Container Service) is AWS's fully managed container orchestration service. Fargate is the serverless compute engine for ECS — you define what containers to run, AWS provisions and manages the underlying EC2 instances, networking, and OS patching. You pay only for the vCPU and memory your tasks consume, not for idle capacity.

**Use ECS Fargate when:**
- You need long-running services (web servers, APIs, workers) that exceed Lambda's 15-minute limit
- Your workload requires a specific runtime, language version, or native dependency not available in Lambda runtimes
- You have multi-container applications where containers share a task lifecycle (app + sidecar log router, app + metrics exporter)
- You want containers without the operational burden of managing EC2 instances or Kubernetes control planes
- You need more than 10 GB memory or 6 vCPU (Lambda's maximum)

**Choosing between alternatives:**

| Use Case | Best Choice | Reason |
|----------|-------------|--------|
| Short-lived event-driven work (<15 min) | Lambda | Simpler, cheaper per-invocation pricing |
| Long-running services, specific runtimes | ECS Fargate | No server management, per-second billing |
| GPU workloads, specific instance types | ECS on EC2 | Fargate does not support GPU instances |
| Cost optimization at large, steady scale | ECS on EC2 | Reserved/Spot EC2 pricing beats Fargate |
| Kubernetes ecosystem, helm charts, operators | EKS | Fargate can run EKS pods but ECS is simpler for AWS-native |
| Batch/ETL jobs triggered on demand | ECS Fargate (run-task) or AWS Batch | Batch is better for array jobs and retry logic |

**AWS Copilot** is the recommended high-level CLI for ECS Fargate projects. It handles clusters, task definitions, services, load balancers, and CI/CD pipelines from a single manifest file. Use raw CDK/CloudFormation when you need fine-grained control or are integrating into an existing CDK app.


## Service Surface

### Launch Types

| Property | Fargate | EC2 |
|----------|---------|-----|
| Infrastructure management | AWS manages | You manage EC2 fleet |
| Pricing | Per task vCPU + memory | Per EC2 instance |
| GPU support | No | Yes (G, P instance families) |
| Windows containers | Yes (Fargate on Windows) | Yes |
| Spot support | Fargate Spot (up to 70% discount) | EC2 Spot instances |
| SSH/ECS Exec into tasks | Yes (with SSM) | Yes (direct EC2 SSH available) |
| Best for | Most services, variable traffic | GPU, steady high-volume, specialized hardware |

### Fargate Pricing (us-east-1, verified 2024)

| Resource | On-Demand | Fargate Spot |
|----------|-----------|--------------|
| Per vCPU-hour | $0.04048 | ~$0.01215 (70% discount) |
| Per GB-hour | $0.004445 | ~$0.00133 (70% discount) |
| Ephemeral storage (>20 GB) | $0.000111/GB-hour | Same |

Minimum billable duration: 1 minute. Billing starts when task enters RUNNING state. Linux/ARM (Graviton) tasks are ~20% cheaper than Linux/x86.

### Key Limits

| Limit | Value |
|-------|-------|
| Tasks per service | 5,000 |
| Tasks per cluster | 5,000 (soft, requestable) |
| Container definitions per task definition | 10 |
| Ephemeral storage per task | 20 GB default, up to 200 GB |
| Max vCPU per task | 16 vCPU |
| Max memory per task | 120 GB |
| Task network mode | awsvpc only (on Fargate) |
| Supported CPU/memory combinations | Specific pairs (0.25 vCPU / 0.5–2 GB, up to 16 vCPU / 32–120 GB) |

### Key Components

| Component | What It Is |
|-----------|-----------|
| Cluster | Logical grouping of services and tasks. Can mix Fargate and EC2 capacity. |
| Task Definition | Immutable blueprint for one or more containers. Versioned (revision 1, 2, 3...). |
| Task | A running instance of a task definition. Ephemeral — dies and is not replaced. |
| Service | Ensures N tasks are always running. Handles deployments, health checks, ALB registration. |
| Container Definition | Per-container config inside a task definition — image, CPU/memory, ports, env vars, secrets, logging. |
| Capacity Provider | Maps a service to Fargate or Fargate Spot. Can split traffic (e.g., 70% On-Demand, 30% Spot). |


## Mental Model

Five primitives to hold in your head:

### 1. Hierarchy: Cluster → Service → Task → Container

```
Cluster (my-app-cluster)
└── Service (api-service)          ← maintains desired count, handles deployments
    ├── Task (running instance)    ← one running copy, gets its own ENI
    │   ├── Container: api         ← your application
    │   └── Container: log-router  ← Fluent Bit sidecar
    └── Task (running instance)
        ├── Container: api
        └── Container: log-router
```

This maps roughly to Kubernetes: Cluster ≈ Namespace, Service ≈ Deployment, Task ≈ Pod, Container ≈ Container. The key difference: ECS Services are opinionated about load balancing and rolling updates in ways that K8s leaves to you.

### 2. Task Definition = Immutable Blueprint

A task definition is like a `docker-compose.yml` for AWS. It specifies:
- Container image URIs (from ECR or Docker Hub)
- CPU and memory allocation (task-level and per-container)
- Port mappings
- Environment variables and secrets
- Volume mounts
- IAM roles (Task Role + Execution Role — see #5)
- Logging configuration
- Health check commands

Task definitions are **immutable** once registered. Deploying a change creates a new revision (`:1`, `:2`, etc.). Services reference a specific revision or `LATEST`. Old revisions are retained indefinitely (soft limit: 1 million per account per region).

### 3. Service = Desired State Controller

An ECS Service is a control loop: it compares desired task count to running task count and acts. Services handle:
- **Deployments**: Rolling update (replace old tasks with new), Blue/Green (via CodeDeploy + ALB), Canary
- **Load balancer registration**: Automatically registers/deregisters task IPs with ALB target groups
- **Health replacement**: Unhealthy tasks (per ALB health check or container health check) are killed and replaced
- **Auto-scaling**: Integrates with Application Auto Scaling to adjust task count based on CloudWatch metrics

### 4. Networking: awsvpc Mode (One ENI Per Task)

Fargate always uses `awsvpc` networking mode. Each task gets its own Elastic Network Interface (ENI) with a private IP address in your VPC. This means:
- Tasks are treated like EC2 instances from a networking perspective
- Each task can have its own security group
- You can control traffic between tasks at the security group level (not just port-based)
- Tasks can communicate with other AWS services using VPC endpoints
- Public tasks need a public IP assigned at launch OR a NAT Gateway in the subnet

Subnet placement matters: put tasks in private subnets with NAT Gateway for outbound internet. Tasks that need to accept inbound traffic from the internet go behind an ALB (which lives in public subnets).

### 5. IAM: Task Role vs. Execution Role

**Never confuse these.** They are always separate roles.

| Role | Who Uses It | What It Controls |
|------|------------|-----------------|
| **Execution Role** | ECS agent (not your code) | Pull image from ECR, write logs to CloudWatch, fetch secrets from Secrets Manager at startup |
| **Task Role** | Your container code | What your app can do — call DynamoDB, read S3, invoke Lambda, etc. |

Missing permissions on the Execution Role causes tasks to fail at launch (often silently). Missing permissions on the Task Role cause runtime errors in your application. Always define both explicitly — never use `AdministratorAccess`.


## Common Patterns

### Pattern 1: Basic Fargate Web Service with ALB (CDK ecs-patterns)

The fastest path to a load-balanced Fargate service. `ApplicationLoadBalancedFargateService` is an L3 CDK construct that creates the cluster, service, task definition, ALB, target group, and security groups in one call.

```typescript
// lib/web-service-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class WebServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Use an existing VPC or create one
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1, // NAT Gateway for private subnet outbound traffic
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsights: true, // Enables CloudWatch Container Insights metrics
    });

    const repo = ecr.Repository.fromRepositoryName(this, 'Repo', 'my-app');

    // Secret from Secrets Manager — injected into container at task start
    const dbSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'DbSecret', 'my-app/db-credentials'
    );

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Service', {
      cluster,
      cpu: 512,           // 0.5 vCPU
      memoryLimitMiB: 1024,
      desiredCount: 2,
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
        containerPort: 3000,
        environment: {
          NODE_ENV: 'production',
          PORT: '3000',
        },
        secrets: {
          // ECS fetches these from Secrets Manager and injects as env vars
          DATABASE_URL: ecs.Secret.fromSecretsManager(dbSecret, 'url'),
          DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'my-app',
          logRetention: cdk.aws_logs.RetentionDays.ONE_MONTH,
        }),
      },
      // ALB health check — must pass before ECS considers task healthy
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60), // Grace period for startup
      },
      // Use Fargate Spot for cost savings (not suitable for stateful or critical workloads)
      // capacityProviderStrategies: [
      //   { capacityProvider: 'FARGATE_SPOT', weight: 1 },
      //   { capacityProvider: 'FARGATE', weight: 0, base: 1 }, // Always keep 1 on-demand
      // ],
      publicLoadBalancer: true,
    });

    // ALB health check grace period — give container time to start before ALB checks
    service.targetGroup.configureHealthCheck({
      path: '/health',
      healthyHttpCodes: '200',
      interval: cdk.Duration.seconds(30),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    new cdk.CfnOutput(this, 'ServiceUrl', {
      value: `http://${service.loadBalancer.loadBalancerDnsName}`,
    });
  }
}
```

### Pattern 2: Task Definition with Sidecar Containers

Use a sidecar (e.g., Fluent Bit for log routing, Envoy for service mesh) alongside your application container. Sidecar containers share the task's network namespace — they communicate via `localhost`.

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class SidecarTaskStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Task Role — what your app can do at runtime
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      inlinePolicies: {
        AppPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:GetObject', 's3:PutObject'],
              resources: ['arn:aws:s3:::my-bucket/*'],
            }),
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
              resources: ['arn:aws:dynamodb:*:*:table/my-table'],
            }),
          ],
        }),
      },
    });

    // Execution Role — what ECS agent needs at launch (pull image, write logs, fetch secrets)
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
    });

    const logGroup = new logs.LogGroup(this, 'AppLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 1024,           // 1 vCPU
      memoryLimitMiB: 2048,
      taskRole,
      executionRole,
    });

    // Primary application container
    const appContainer = taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry('my-org/my-app:latest'),
      essential: true,       // If this container exits, kill the entire task
      portMappings: [{ containerPort: 3000 }],
      environment: {
        LOG_DRIVER: 'stdout', // App logs to stdout, Fluent Bit collects them
        FLUENT_HOST: '127.0.0.1',
        FLUENT_PORT: '24224',
      },
      logging: ecs.LogDrivers.firelens({
        options: {
          Name: 'cloudwatch',
          region: this.region,
          log_group_name: logGroup.logGroupName,
          log_stream_prefix: 'app/',
          auto_create_group: 'false',
        },
      }),
      // Container-level health check (separate from ALB health check)
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(3),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    // Fluent Bit sidecar for log routing
    // essential: false — if Fluent Bit crashes, app keeps running
    taskDef.addContainer('log-router', {
      image: ecs.ContainerImage.fromRegistry(
        'public.ecr.aws/aws-observability/aws-for-fluent-bit:stable'
      ),
      essential: false,
      firelensConfig: {
        type: ecs.FirelensLogRouterType.FLUENTBIT,
        options: {
          enableECSLogMetadata: true,
        },
      },
      memoryReservationMiB: 50, // Soft limit — can burst higher
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'fluent-bit',
        logGroup,
      }),
    });

    // Ensure log router starts before app (sidecar ordering)
    appContainer.addContainerDependencies({
      container: taskDef.findContainer('log-router')!,
      condition: ecs.ContainerDependencyCondition.START,
    });
  }
}
```

### Pattern 3: Auto-Scaling on CPU and Request Count

ECS Services integrate with Application Auto Scaling. Scale on CPU utilization, memory, ALB request count per target, or custom CloudWatch metrics.

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as autoscaling from 'aws-cdk-lib/aws-applicationautoscaling';

// Assuming `service` is an ApplicationLoadBalancedFargateService from Pattern 1

// Enable auto-scaling on the service
const scaling = service.service.autoScaleTaskCount({
  minCapacity: 2,   // Never drop below 2 tasks (one per AZ minimum)
  maxCapacity: 20,
});

// Scale on CPU utilization — most common trigger
scaling.scaleOnCpuUtilization('CpuScaling', {
  targetUtilizationPercent: 60, // Scale out when CPU > 60%, in when < 60%
  scaleInCooldown: cdk.Duration.seconds(60),
  scaleOutCooldown: cdk.Duration.seconds(30), // Scale out faster than scale in
});

// Scale on memory utilization
scaling.scaleOnMemoryUtilization('MemoryScaling', {
  targetUtilizationPercent: 70,
  scaleInCooldown: cdk.Duration.seconds(60),
  scaleOutCooldown: cdk.Duration.seconds(30),
});

// Scale on ALB requests per target — useful for APIs where CPU isn't the bottleneck
scaling.scaleOnRequestCount('RequestScaling', {
  requestsPerTarget: 1000, // Target 1000 req/min per task
  targetGroup: service.targetGroup,
  scaleInCooldown: cdk.Duration.seconds(60),
  scaleOutCooldown: cdk.Duration.seconds(30),
});

// Scheduled scaling — pre-warm for known traffic patterns
scaling.scaleOnSchedule('MorningScale', {
  schedule: autoscaling.Schedule.cron({ hour: '8', minute: '0' }),
  minCapacity: 5, // Bump minimum at 8 AM
});

scaling.scaleOnSchedule('NightScale', {
  schedule: autoscaling.Schedule.cron({ hour: '22', minute: '0' }),
  minCapacity: 2, // Reduce overnight
});
```

### Pattern 4: Blue/Green Deployment with CodeDeploy

Rolling deployments are ECS's default. Blue/Green shifts traffic instantly between two versions and allows instant rollback. Requires CodeDeploy and an ALB with two target groups (blue + green).

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import { Construct } from 'constructs';

export class BlueGreenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: false });
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
      clusterName: 'my-cluster',
      vpc,
      securityGroups: [],
    });

    // Two target groups — blue (live) and green (staging)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
    });

    const blueTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BlueTarget', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP, // Required for awsvpc mode
      healthCheck: { path: '/health', healthyHttpCodes: '200' },
    });

    const greenTargetGroup = new elbv2.ApplicationTargetGroup(this, 'GreenTarget', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/health', healthyHttpCodes: '200' },
    });

    // Production listener → blue (live)
    const prodListener = alb.addListener('ProdListener', {
      port: 80,
      defaultTargetGroups: [blueTargetGroup],
    });

    // Test listener → green (for smoke testing before cutover)
    alb.addListener('TestListener', {
      port: 8080,
      defaultTargetGroups: [greenTargetGroup],
    });

    // ECS service configured for CODE_DEPLOY deployment controller
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry('my-org/my-app:latest'),
      portMappings: [{ containerPort: 3000 }],
    });

    const ecsService = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      deploymentController: {
        type: ecs.DeploymentControllerType.CODE_DEPLOY, // Hands deployment to CodeDeploy
      },
    });

    // Attach to blue target group initially
    ecsService.attachToApplicationTargetGroup(blueTargetGroup);

    // CodeDeploy ECS deployment group
    const ecsApplication = new codedeploy.EcsApplication(this, 'CodeDeployApp');

    new codedeploy.EcsDeploymentGroup(this, 'DeploymentGroup', {
      application: ecsApplication,
      service: ecsService,
      blueGreenDeploymentConfig: {
        blueTargetGroup,
        greenTargetGroup,
        listener: prodListener,
        testListener: alb.listeners[1],
        // Wait 10 min for smoke tests on green before shifting traffic
        deploymentApprovalWaitTime: cdk.Duration.minutes(10),
        // Keep blue tasks running for 30 min after cutover (for instant rollback)
        terminationWaitTime: cdk.Duration.minutes(30),
      },
      deploymentConfig: codedeploy.EcsDeploymentConfig.CANARY_10PERCENT_5MINUTES,
    });
  }
}
```

For programmatic deployment triggers using AWS SDK v3:

```typescript
import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { CodeDeployClient, CreateDeploymentCommand } from '@aws-sdk/client-codedeploy';

const ecsClient = new ECSClient({ region: 'us-east-1' });
const codeDeployClient = new CodeDeployClient({ region: 'us-east-1' });

// Force a new deployment (re-pulls :latest tag, creates CodeDeploy deployment)
async function deployNewVersion(clusterName: string, serviceName: string) {
  await ecsClient.send(new UpdateServiceCommand({
    cluster: clusterName,
    service: serviceName,
    forceNewDeployment: true,
  }));
}

// Describe running tasks
import { ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';

async function listRunningTasks(clusterName: string, serviceName: string) {
  const listed = await ecsClient.send(new ListTasksCommand({
    cluster: clusterName,
    serviceName,
    desiredStatus: 'RUNNING',
  }));

  if (!listed.taskArns?.length) return [];

  const described = await ecsClient.send(new DescribeTasksCommand({
    cluster: clusterName,
    tasks: listed.taskArns,
  }));

  return described.tasks ?? [];
}
```


## Gotchas

### 1. Fargate Cold Start: 30–60 Seconds

New Fargate tasks take 30–60 seconds to start: image pull (5–30s depending on image size) + container init + health check passing. This is a cold start in the ECS sense — different from Lambda, but still impactful during scale-out events.

**Mitigations:**
- Keep minimum task count above zero (`minCapacity: 1` or higher in auto-scaling)
- Scale out proactively with scheduled scaling before expected traffic peaks
- Reduce image size — use multi-stage builds and slim base images (`node:22-alpine` over `node:22`)
- Use ECR in the same region to avoid cross-region image pull latency
- Pre-pull images with ECS image caching (EC2 launch type only, not Fargate)

### 2. Task Definition Revisions Are Immutable

You cannot edit an existing task definition revision. Every `RegisterTaskDefinition` API call (or CDK deploy that changes task def properties) creates a new revision. Services can be updated to use a new revision without downtime. Old revisions accumulate — deregister unused ones to avoid hitting soft limits.

```bash
# Deregister old revisions (CLI)
aws ecs deregister-task-definition --task-definition my-task:42
```

### 3. ALB Health Check Grace Period Must Exceed Container Startup Time

ECS Services integrated with an ALB will kill tasks that fail health checks. If your container takes 45 seconds to start and the health check grace period is 30 seconds, ECS will kill the task before it ever becomes healthy — producing an infinite crash loop that's hard to diagnose.

Set `healthCheckGracePeriodSeconds` on the service (or `startPeriod` in the container health check) to at least 1.5x your observed startup time. In CDK's `ApplicationLoadBalancedFargateService`, this is the `healthCheckGracePeriod` prop.

### 4. CloudWatch Logs Retention Defaults to Never Expire

The `awslogs` log driver creates CloudWatch Log Groups with no retention period by default — logs accumulate forever. At production scale, this is a significant cost vector. Always set `logRetentionDays` explicitly, or use `logs.LogGroup` with a `retention` prop in CDK before the first deployment.

### 5. Secrets — Use Container Definition `secrets`, Not Environment Variables

Never bake secrets into Docker images or task definition environment variables (environment variables are visible in the AWS console and task metadata endpoint). Use the `secrets` field in container definitions to pull from AWS Secrets Manager or SSM Parameter Store at task launch:

```json
{
  "secrets": [
    {
      "name": "DATABASE_PASSWORD",
      "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:my-app/db:password::"
    }
  ]
}
```

The Execution Role must have `secretsmanager:GetSecretValue` (for Secrets Manager) or `ssm:GetParameters` (for Parameter Store). Missing this permission causes the task to fail at launch with a cryptic `ResourceInitializationError`.

### 6. Execution Role Permissions — Silent Task Launch Failures

The most common cause of tasks failing to start is insufficient Execution Role permissions. The ECS agent needs these to launch any Fargate task:

- `ecr:GetAuthorizationToken` — authenticate to ECR
- `ecr:BatchCheckLayerAvailability` + `ecr:GetDownloadUrlForLayer` + `ecr:BatchGetImage` — pull image layers
- `logs:CreateLogStream` + `logs:PutLogEvents` — write to CloudWatch Logs
- `secretsmanager:GetSecretValue` — fetch secrets (if using Secrets Manager)
- `ssm:GetParameters` — fetch parameters (if using SSM Parameter Store)
- `kms:Decrypt` — if secrets are encrypted with a custom KMS key

When these are missing, the task enters STOPPED state with reason `CannotPullContainerError` or `ResourceInitializationError`. The `AmazonECSTaskExecutionRolePolicy` managed policy covers the first three — add secrets permissions separately.

### 7. Use Service Discovery (Cloud Map) for Service-to-Service Communication

Routing internal traffic between ECS services through an ALB adds latency and cost. For service-to-service calls within the same VPC, use AWS Cloud Map service discovery: each task registers its IP with a private DNS namespace, and other services resolve `my-service.local` to the current task IPs.

In CDK, enable this with `cloudMapOptions` on your `FargateService`. Cloud Map integrations are free for DNS queries; you pay only for the health checks ($0.50/month per health check endpoint).

### 8. Fargate Spot Reclamation: 2-Minute Warning

Fargate Spot tasks can be interrupted with only a 2-minute SIGTERM notice when EC2 Spot capacity is reclaimed. ECS sends a `SIGTERM` to running containers and waits up to `stopTimeout` seconds (default 30s, max 120s on Fargate) before force-killing.

**Do not use Fargate Spot for:**
- Databases or stateful workloads
- Tasks without graceful shutdown handling
- Services where interruption causes user-visible errors

**Do use Fargate Spot for:**
- Background workers, async job processors
- Batch ETL pipelines
- Dev/staging environments

Use a capacity provider strategy with `base: 1` on `FARGATE` (On-Demand) and remaining tasks on `FARGATE_SPOT` to ensure at least one stable task is always available.

### 9. ECS Exec Requires Explicit Enablement

ECS Exec (analogous to `kubectl exec`) lets you open a shell into a running container for debugging. It requires:
1. `enableExecuteCommand: true` on the ECS Service (or `--enable-execute-command` in CLI)
2. SSM Session Manager agent running in your container (included in Amazon Linux 2 images, must be added to minimal images)
3. Task Role with SSM permissions: `ssm:StartSession`, `ssm:TerminateSession`, `ssm:DescribeSessions`, `ssm:DescribeInstanceInformation`, `ssm:DescribeSessionsDocuments`, `ssm:GetConnectionStatus`

Without these, `aws ecs execute-command` returns `SessionManagerPlugin is not found` or hangs silently.

```bash
aws ecs execute-command \
  --cluster my-cluster \
  --task arn:aws:ecs:us-east-1:123456789:task/abc123 \
  --container app \
  --interactive \
  --command "/bin/sh"
```

### 10. Deployment Circuit Breaker — Enable It

By default, a failed ECS deployment will continue launching new tasks until the deployment times out (~1 hour) or you manually stop it. Enable the deployment circuit breaker to automatically detect and roll back failed deployments:

```typescript
const service = new ecs.FargateService(this, 'Service', {
  // ...
  circuitBreaker: {
    rollback: true, // Automatically roll back to last stable task definition revision
  },
});
```

The circuit breaker triggers when more than 50% of tasks fail health checks within a deployment window. Without it, a bad deployment can keep your service degraded for an hour before you notice.

### 11. Task Networking: Public IP Assignment Is Explicit

Tasks in public subnets do not automatically get a public IP unless you set `assignPublicIp: true` at the service level. Tasks in private subnets need a NAT Gateway for outbound internet access — without it, image pulls from Docker Hub will fail and Secrets Manager/ECR calls will time out unless you have VPC Endpoints configured.

### 12. CPU and Memory Must Use Valid Combinations

Fargate does not accept arbitrary CPU/memory combinations. Valid pairs include:

| vCPU | Valid Memory Range |
|------|--------------------|
| 0.25 | 512 MB – 2 GB (in 512 MB increments) |
| 0.5 | 1 GB – 4 GB (in 1 GB increments) |
| 1 | 2 GB – 8 GB (in 1 GB increments) |
| 2 | 4 GB – 16 GB (in 1 GB increments) |
| 4 | 8 GB – 30 GB (in 1 GB increments) |
| 8 | 16 GB – 60 GB (in 4 GB increments) |
| 16 | 32 GB – 120 GB (in 8 GB increments) |

In CDK, `cpu` is in units (1024 = 1 vCPU), `memoryLimitMiB` is in MiB. Mismatches cause `ClientException: Invalid CPU or memory value specified` during task registration.


## Official Documentation

- **ECS Developer Guide:** https://docs.aws.amazon.com/AmazonECS/latest/developerguide/
- **ECS Fargate Guide:** https://docs.aws.amazon.com/AmazonECS/latest/userguide/what-is-fargate.html
- **ECS Best Practices Guide:** https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/
- **CDK ecs-patterns Reference** (L3 constructs): https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs_patterns-readme.html
- **CDK ecs Reference** (L2 constructs): https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs-readme.html
- **AWS Copilot CLI** (recommended high-level ECS tool): https://aws.github.io/copilot-cli/
- **Fargate Pricing:** https://aws.amazon.com/fargate/pricing/
- **ECS Quotas and Limits:** https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-quotas.html
- **ECS Deployment Circuit Breaker:** https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html
- **ECS Exec (shell into tasks):** https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html
- **Fargate Spot:** https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html
- **AWS SDK v3 ECS Client:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/ecs/
