---
name: app-runner
description: AWS App Runner guidance — fully managed container service, auto-scaling, custom domains, VPC connectors. Use when deploying web apps/APIs with minimal configuration.
metadata:
  priority: 4
  docs:
    - "https://docs.aws.amazon.com/apprunner/latest/dg/"
  pathPatterns:
    - 'apprunner/**'
    - 'apprunner.yaml'
  bashPatterns:
    - '\baws\s+apprunner\b'
  importPatterns:
    - "@aws-sdk/client-apprunner"
    - "aws-cdk-lib/aws-apprunner"
  promptSignals:
    phrases:
      - "app runner"
      - "apprunner"
      - "managed container"
      - "auto deploy container"
---

# AWS App Runner

## What It Is & When to Use It

AWS App Runner is a fully managed container service that takes a source (container image or GitHub repository) and hands back an HTTPS URL — no clusters, no task definitions, no load balancers to configure. AWS handles provisioning, scaling, TLS termination, health checks, and OS patching. The mental model is Heroku for AWS: point it at code or an image, get a URL.

**Use App Runner when:**
- You want the fastest path from container image to live HTTPS endpoint
- You're deploying stateless web apps, REST/GraphQL APIs, or backend services
- Your team doesn't have deep AWS or container orchestration expertise
- You need automatic scale-to-zero for dev/staging environments where idle cost matters
- You're migrating from Heroku, Render, Fly.io, or Railway and want to stay in the AWS ecosystem

**Do not use App Runner when:**
- You need WebSocket connections — App Runner does not support WebSockets (use ECS Fargate + ALB instead)
- You need fine-grained container scheduling, sidecars, or multi-container task groups
- Your app is stateful and writes to local disk (ephemeral filesystem only — use EFS or S3)
- You need GPU instances, specific CPU families, or bare-metal access
- You require custom VPC inbound rules or need to expose non-HTTP ports
- You need observability depth (App Runner's metrics and logging are basic vs. ECS + Container Insights)

**Choosing between App Runner and alternatives:**

| Use Case | Best Choice | Reason |
|----------|-------------|--------|
| HTTPS API, minimal config, auto-scale | App Runner | Zero infrastructure management |
| Long-running services, sidecars, GPU | ECS Fargate | Full container orchestration control |
| Short-lived event-driven compute | Lambda | Per-invocation pricing, better cold start story |
| Scale-to-zero with high traffic variance | App Runner | Automatic pause/resume built in |
| Kubernetes ecosystem, Helm, service mesh | EKS | App Runner has no K8s compatibility |
| Steady high-volume traffic, cost-optimized | ECS on EC2 + Reserved | App Runner On-Demand pricing doesn't compete at scale |


## Service Surface

### Pricing (us-east-1, verified 2024)

App Runner has two billing states: **active** (your container is running and serving requests) and **paused** (instances scaled to zero, waiting for a request to trigger warm-up).

| State | Resource | Rate |
|-------|----------|------|
| Active | Per vCPU-hour | $0.064 |
| Active | Per GB memory-hour | $0.007 |
| Paused | Per vCPU-hour | $0.00 (free) |
| Paused | Per GB memory-hour | $0.0007 |
| Build | Per build minute | $0.005 |

The pause/resume cycle means dev and low-traffic services can cost near zero when idle. The trade-off: the first request after a pause triggers a cold start that can take 5+ minutes (see Gotchas).

Minimum instance size: 0.25 vCPU / 0.5 GB. Maximum: 4 vCPU / 12 GB per instance. If you need more, use ECS Fargate.

### Source Types

| Source | How It Works | Best For |
|--------|-------------|----------|
| **ECR image** | Point at an ECR repository + tag. App Runner pulls the image and deploys. Auto-deploy on tag push is optional. | Production — build pipeline pushes to ECR, App Runner deploys. |
| **ECR Public image** | Same as ECR, using the public registry (`public.ecr.aws`). | Open-source base images or public demo apps. |
| **GitHub repository** | App Runner builds from source using a managed build. Supports Node.js, Python, Java, .NET, Ruby, PHP, Go. Auto-deploys on branch push. | Simpler projects where you don't maintain a separate Docker build pipeline. |

For production workloads, ECR image is preferred: you control the build, the image is versioned, and you can validate before deployment. GitHub source is convenient for prototypes and low-risk services.

### Key Limits

| Limit | Value |
|-------|-------|
| Services per region | 40 (soft, requestable) |
| Concurrent requests per instance | Configurable (1–200, default 100) |
| Max instances per service | 25 (soft, requestable) |
| Min instances | 0 (scale to zero) or 1+ (always on) |
| vCPU per instance | 0.25, 0.5, 1, 2, 4 |
| Memory per instance | 0.5, 1, 2, 3, 4, 6, 8, 10, 12 GB |
| Inbound ports | 443 (HTTPS) only |
| Environment variables per service | 50 |
| VPC connectors per service | 1 |
| Custom domains per service | 5 |
| Max request timeout | 120 seconds |
| Request payload size | 5 MB |

### Key Components

| Component | What It Is |
|-----------|-----------|
| **Service** | The top-level resource. Has a URL, instance config, scaling config, and source. |
| **Instance configuration** | vCPU + memory for each running instance. |
| **Auto-scaling configuration** | Concurrent requests threshold that triggers scaling out/in. Min and max instances. |
| **Source configuration** | ECR image URI + tag, or GitHub repo + branch + runtime. |
| **VPC connector** | Attach the service to a VPC so it can reach RDS, ElastiCache, or other private resources. |
| **Custom domain** | Associate your domain. App Runner provisions and manages the ACM certificate. |
| **Observability configuration** | Optional X-Ray tracing. CloudWatch metrics and logs always enabled. |


## Mental Model

### App Runner as a Managed Request Router

App Runner sits in front of your container instances and routes inbound HTTPS requests. You never manage the load balancer — it's implicit. The service URL (`<id>.us-east-1.awsapprunner.com`) is always HTTPS with an AWS-managed certificate.

```
Internet
   │
   ▼
App Runner HTTPS endpoint (AWS managed LB + TLS)
   │
   ├── Instance 1 (your container, port you specify)
   ├── Instance 2 (scaled out when concurrent requests exceed threshold)
   └── Instance N (up to maxSize)
```

App Runner scales horizontally by launching additional container instances when the number of in-flight concurrent requests per instance exceeds your configured threshold. It scales in (and eventually pauses to zero) when requests drop.

### Auto-Scaling: Concurrent Requests, Not CPU

ECS scales on CPU utilization or request count per minute. App Runner scales on **concurrent requests** — how many requests are actively in-flight at once on each instance. This is a fundamentally different model.

If your `concurrency` setting is 100 and you have 1 instance handling 50 concurrent requests, it will not scale out. When those 50 requests complete and 200 new ones arrive simultaneously, App Runner will scale to 2 instances.

This means:
- Long-running requests (file uploads, slow DB queries) consume concurrency slots for longer and drive scale-out more aggressively
- Fast APIs with low latency can handle high throughput on few instances
- Set `concurrency` based on your container's thread/worker capacity, not a fixed number

### Scale-to-Zero vs. Always-On

Setting `minSize: 0` (the default) enables scale-to-zero: when no traffic arrives for ~5 minutes, App Runner pauses all instances. The service costs ~$0 while paused.

Setting `minSize: 1` keeps at least one instance running. You pay the active rate 24/7 but eliminate the cold-start delay for the first request after idle.

Rule of thumb: `minSize: 0` for dev/staging. `minSize: 1` for production APIs where the first request matters.

### VPC Connector: Required for Private Resources

By default, App Runner instances run in AWS-managed infrastructure — outside your VPC. They can reach the public internet and public AWS service endpoints (like S3 via public URLs) but cannot reach private VPC resources (RDS, ElastiCache, internal services).

To reach private resources, attach a **VPC connector**: a managed construct that routes outbound traffic from App Runner instances through ENIs in your VPC subnets. The connector associates security groups, so your RDS security group can allow inbound from the connector's security group.

**One VPC connector per service.** If you need to reach resources in multiple VPCs, use VPC peering.


## Common Patterns

### Pattern 1: Deploy a Container from ECR (CDK)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class AppRunnerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repo = ecr.Repository.fromRepositoryName(this, 'Repo', 'my-api');

    // Access role — grants App Runner permission to pull images from ECR
    // This is different from the instance role (runtime permissions)
    const accessRole = new iam.Role(this, 'AppRunnerAccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSAppRunnerServicePolicyForECRAccess'
        ),
      ],
    });

    // Instance role — what your running container can do at runtime
    const instanceRole = new iam.Role(this, 'AppRunnerInstanceRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
      inlinePolicies: {
        AppPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:GetObject', 's3:PutObject'],
              resources: ['arn:aws:s3:::my-bucket/*'],
            }),
            new iam.PolicyStatement({
              actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret',
              ],
              resources: ['arn:aws:secretsmanager:*:*:secret:my-app/*'],
            }),
          ],
        }),
      },
    });

    const service = new apprunner.CfnService(this, 'Service', {
      serviceName: 'my-api',

      sourceConfiguration: {
        authenticationConfiguration: {
          accessRoleArn: accessRole.roleArn,
        },
        autoDeploymentsEnabled: true, // Re-deploy when image tag is pushed to ECR
        imageRepository: {
          imageIdentifier: `${repo.repositoryUri}:latest`,
          imageRepositoryType: 'ECR',
          imageConfiguration: {
            port: '3000',
            runtimeEnvironmentVariables: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'PORT', value: '3000' },
            ],
          },
        },
      },

      instanceConfiguration: {
        cpu: '1 vCPU',
        memory: '2 GB',
        instanceRoleArn: instanceRole.roleArn,
      },

      // Concurrent requests threshold — scale out when this is exceeded per instance
      autoScalingConfigurationArn: new apprunner.CfnAutoScalingConfiguration(
        this, 'ScalingConfig', {
          autoScalingConfigurationName: 'my-api-scaling',
          maxConcurrency: 100,  // Scale out if >100 concurrent requests per instance
          minSize: 1,           // Keep 1 instance warm (no cold start on first request)
          maxSize: 10,
        }
      ).attrAutoScalingConfigurationArn,

      healthCheckConfiguration: {
        protocol: 'HTTP',
        path: '/health',
        interval: 10,         // Check every 10 seconds
        timeout: 5,
        healthyThreshold: 1,
        unhealthyThreshold: 5,
      },
    });

    new cdk.CfnOutput(this, 'ServiceUrl', {
      value: `https://${service.attrServiceUrl}`,
    });
  }
}
```

### Pattern 2: VPC Connector for Private RDS Access (CDK)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export class AppRunnerWithVpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: false });

    // Security group for App Runner outbound traffic within the VPC
    const connectorSg = new ec2.SecurityGroup(this, 'ConnectorSg', {
      vpc,
      description: 'App Runner VPC connector egress',
      allowAllOutbound: true,
    });

    // Your RDS security group must allow inbound from connectorSg on port 5432
    // e.g.: rdsSg.addIngressRule(connectorSg, ec2.Port.tcp(5432));

    const vpcConnector = new apprunner.CfnVpcConnector(this, 'VpcConnector', {
      vpcConnectorName: 'my-api-connector',
      subnets: vpc.privateSubnets.map(s => s.subnetId), // Private subnets — no public IP
      securityGroups: [connectorSg.securityGroupId],
    });

    // Reference the connector ARN in your service's network configuration
    const service = new apprunner.CfnService(this, 'Service', {
      serviceName: 'my-api',
      sourceConfiguration: { /* ... same as Pattern 1 ... */ } as any,
      instanceConfiguration: { cpu: '1 vCPU', memory: '2 GB' },
      networkConfiguration: {
        egressConfiguration: {
          egressType: 'VPC',  // Route outbound through VPC (not public internet)
          vpcConnectorArn: vpcConnector.attrVpcConnectorArn,
        },
        ingressConfiguration: {
          isPubliclyAccessible: true, // Still accept inbound from the internet
        },
      },
    });
  }
}
```

### Pattern 3: AWS SDK v3 — Create and Manage Services Programmatically

```typescript
import {
  AppRunnerClient,
  CreateServiceCommand,
  DescribeServiceCommand,
  UpdateServiceCommand,
  ListServicesCommand,
  PauseServiceCommand,
  ResumeServiceCommand,
  CreateAutoScalingConfigurationCommand,
  type ServiceSummary,
} from '@aws-sdk/client-apprunner';

const client = new AppRunnerClient({ region: 'us-east-1' });

// Create an App Runner service
async function createService(imageUri: string, roleArn: string) {
  const response = await client.send(new CreateServiceCommand({
    ServiceName: 'my-api',
    SourceConfiguration: {
      AuthenticationConfiguration: {
        AccessRoleArn: roleArn,
      },
      AutoDeploymentsEnabled: true,
      ImageRepository: {
        ImageIdentifier: imageUri,      // e.g. "123456789.dkr.ecr.us-east-1.amazonaws.com/my-api:latest"
        ImageRepositoryType: 'ECR',
        ImageConfiguration: {
          Port: '3000',
          RuntimeEnvironmentVariables: {
            NODE_ENV: 'production',
          },
        },
      },
    },
    InstanceConfiguration: {
      Cpu: '1 vCPU',
      Memory: '2 GB',
    },
    HealthCheckConfiguration: {
      Protocol: 'HTTP',
      Path: '/health',
      Interval: 10,
      Timeout: 5,
      HealthyThreshold: 1,
      UnhealthyThreshold: 5,
    },
  }));

  return response.Service;
}

// Poll service status until it reaches a terminal state
async function waitForService(
  serviceArn: string,
  targetStatus: 'RUNNING' | 'DELETED' = 'RUNNING'
) {
  while (true) {
    const { Service } = await client.send(new DescribeServiceCommand({
      ServiceArn: serviceArn,
    }));

    const status = Service?.Status;
    console.log(`Service status: ${status}`);

    if (status === targetStatus) return Service;
    if (status === 'CREATE_FAILED' || status === 'DELETE_FAILED' || status === 'UPDATE_FAILED') {
      throw new Error(`Service entered failed state: ${status}`);
    }

    // Poll every 10 seconds — deployments typically take 1-3 minutes
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
}

// Force a redeployment (useful after pushing a new image to ECR with same tag)
async function triggerDeploy(serviceArn: string) {
  await client.send(new UpdateServiceCommand({
    ServiceArn: serviceArn,
    // Omitting source changes forces a re-deploy with current config
  }));
}

// Pause a service to reduce costs (dev/staging)
async function pauseService(serviceArn: string) {
  await client.send(new PauseServiceCommand({ ServiceArn: serviceArn }));
}

// Resume a paused service
async function resumeService(serviceArn: string) {
  await client.send(new ResumeServiceCommand({ ServiceArn: serviceArn }));
}

// List all services in a region
async function listAllServices(): Promise<ServiceSummary[]> {
  const services: ServiceSummary[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(new ListServicesCommand({ NextToken: nextToken }));
    services.push(...(response.ServiceSummaryList ?? []));
    nextToken = response.NextToken;
  } while (nextToken);

  return services;
}
```

### Pattern 4: Custom Domain with ACM Certificate

App Runner provisions and renews an ACM certificate automatically when you associate a custom domain. You provide the domain; App Runner gives you CNAME records to add to your DNS.

```typescript
import {
  AppRunnerClient,
  AssociateCustomDomainCommand,
  DescribeCustomDomainsCommand,
} from '@aws-sdk/client-apprunner';

const client = new AppRunnerClient({ region: 'us-east-1' });

// Step 1: Associate the domain
async function addCustomDomain(serviceArn: string, domain: string) {
  const response = await client.send(new AssociateCustomDomainCommand({
    ServiceArn: serviceArn,
    DomainName: domain,           // e.g. "api.myapp.com"
    EnableWWWSubdomain: false,    // Set true to also register "www.api.myapp.com"
  }));

  // response.CustomDomain.CertificateValidationRecords contains the CNAME records
  // you must add to your DNS provider to prove domain ownership.
  // App Runner polls for validation — certificate is issued once DNS propagates.
  console.log('Add these CNAME records to your DNS:');
  response.CustomDomain?.CertificateValidationRecords?.forEach(record => {
    console.log(`  ${record.Name} → ${record.Value}`);
  });

  // Also add a CNAME for the domain itself pointing to the App Runner URL:
  // api.myapp.com → <id>.us-east-1.awsapprunner.com
  console.log(`\nAlso add: ${domain} CNAME → ${response.DNSTarget}`);

  return response;
}

// Step 2: Check validation status (repeat until Status === 'ACTIVE')
async function checkDomainStatus(serviceArn: string) {
  const response = await client.send(new DescribeCustomDomainsCommand({
    ServiceArn: serviceArn,
  }));

  return response.CustomDomains?.map(d => ({
    domain: d.DomainName,
    status: d.Status, // 'CREATING' | 'CREATE_FAILED' | 'ACTIVE' | 'DELETING' | 'DELETE_FAILED' | 'PENDING_CERTIFICATE_DNS_VALIDATION'
  }));
}
```


## Gotchas

### 1. No WebSocket Support

App Runner only supports HTTP/1.1 and HTTP/2 request-response cycles over HTTPS port 443. It does not support WebSocket upgrades (`Upgrade: websocket`). Requests requiring persistent bidirectional connections will fail at the App Runner layer.

If your application uses WebSockets, use ECS Fargate with an ALB (which has WebSocket support via sticky sessions) or API Gateway WebSocket APIs.

### 2. Scale-to-Zero Cold Start Is 5+ Minutes, Not Seconds

When all instances are paused and a request arrives, App Runner must pull the container image, start the container, pass the health check, and then route the request. This takes **5–15 minutes** in practice, depending on image size and application startup time. The incoming request does not wait — it receives a 503 or times out.

This is not a Lambda cold start (milliseconds to low seconds). It is a full container boot cycle.

Mitigations:
- Set `minSize: 1` for any service where first-request latency matters
- Use scheduled scaling to resume services before expected traffic windows
- Keep images small to reduce pull time (multi-stage builds, `node:22-alpine` vs `node:22`)
- Implement aggressive health check paths that return 200 immediately without waiting for DB connections

### 3. VPC Connector Required for Every Private Resource

App Runner services run in AWS-managed infrastructure, not your VPC. Without a VPC connector, your service cannot reach:
- Amazon RDS or Aurora (private endpoints)
- Amazon ElastiCache
- Internal ALBs or NLBs
- EC2 instances in private subnets
- Any resource accessible only within your VPC

Even if your RDS is in the same AWS account and region, the App Runner service cannot reach it without a VPC connector. This surprises teams migrating from ECS, where services are already inside the VPC.

A common symptom: `ECONNREFUSED` or `timeout` when the app tries to connect to the database, with no obvious DNS or networking errors in the App Runner logs.

### 4. Auto-Deploy on `:latest` Tag Has No Rollback Mechanism

When `autoDeploymentsEnabled: true` and you're using the `:latest` ECR tag, every push triggers a new deployment. App Runner performs a rolling replacement but does not retain previous image versions for rollback — you must push a known-good image back to ECR to recover.

Best practice: use immutable image tags (e.g., git SHA or build number) and update the image identifier explicitly per deployment. This preserves rollback capability and makes deployments auditable.

```bash
# Good: immutable tag
aws apprunner update-service \
  --service-arn $SERVICE_ARN \
  --source-configuration '{"ImageRepository":{"ImageIdentifier":"123456789.dkr.ecr.us-east-1.amazonaws.com/my-api:abc1234","ImageRepositoryType":"ECR"}}'
```

### 5. Limited Observability vs. ECS

App Runner exposes:
- CloudWatch metrics: `RequestCount`, `2xxStatusResponses`, `4xxStatusResponses`, `5xxStatusResponses`, `RequestLatency`, `ActiveInstances`
- CloudWatch Logs: application stdout/stderr (automatically collected)
- Optional X-Ray tracing (must be enabled explicitly in `ObservabilityConfiguration`)

What it does not expose:
- Container-level CPU and memory metrics per instance (only aggregate)
- Network I/O metrics
- Container health check failure details
- Fine-grained deployment event history

For services that need Container Insights-level observability, use ECS Fargate. For App Runner, set up CloudWatch alarms on `5xxStatusResponses` and `RequestLatency` at minimum.

### 6. Environment Variables Are Not Encrypted at Rest by Default

Environment variables set on an App Runner service are stored in plaintext in the service configuration and visible in the AWS console. For secrets (database passwords, API keys), use AWS Secrets Manager and inject values at runtime via the instance role:

```typescript
// In your application code — fetch secret at startup, not at build time
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

async function getDbUrl(): Promise<string> {
  const response = await secretsClient.send(new GetSecretValueCommand({
    SecretId: 'my-app/db-credentials',
  }));
  const secret = JSON.parse(response.SecretString ?? '{}');
  return secret.url;
}
```

The instance role must have `secretsmanager:GetSecretValue` on the secret's ARN. App Runner does not support native Secrets Manager injection in container environment variables the way ECS does — you must fetch secrets in application code.

### 7. One Inbound Port, HTTPS Only

App Runner exposes exactly one port (the one you configure) over HTTPS on port 443. You cannot:
- Expose additional ports (e.g., a metrics scrape endpoint on port 9090)
- Accept raw TCP/UDP traffic
- Terminate TLS yourself (App Runner always terminates TLS before your container)
- Serve HTTP (non-TLS) on port 80

If your architecture requires Prometheus metrics scraping on a separate port, run a side-channel solution (push metrics to CloudWatch or Datadog via the SDK) rather than exposing a scrape port.

### 8. `autoDeploymentsEnabled` Only Watches One Tag

The automatic deployment trigger watches the specific image tag configured on the service. Pushing a new image with the same tag triggers a redeploy. Pushing to a different tag does not. There is no way to configure a tag pattern (e.g., "deploy on any push matching `v*`") — use a CI/CD pipeline with explicit `UpdateService` calls for tag-based promotion workflows.

### 9. Request Timeout Is Capped at 120 Seconds

Long-running synchronous requests (large file processing, slow AI inference calls, bulk data exports) will be terminated by App Runner at 120 seconds regardless of container behavior. This is not configurable.

For long-running work: accept the request, enqueue it to SQS or EventBridge, return a job ID immediately, and have a separate ECS task or Lambda process the queue. Use polling or webhooks to notify the client when work is complete.

### 10. Service Deployment Replaces Instances, Not Updates In-Place

When you update a service (new image, new env vars, new instance size), App Runner provisions new instances running the new configuration, waits for them to pass health checks, then terminates old instances. There is no in-place update.

This means:
- Deployments always take 1–3 minutes minimum
- Rollbacks require pushing a new image or config — there is no "rollback to previous deployment" button in the console (use the API with a previous image tag)
- Health check configuration must pass on the new version before traffic shifts — a broken health check endpoint blocks the deployment indefinitely until it times out


## Official Documentation

- **App Runner Developer Guide:** https://docs.aws.amazon.com/apprunner/latest/dg/
- **App Runner Pricing:** https://aws.amazon.com/apprunner/pricing/
- **App Runner Service Quotas:** https://docs.aws.amazon.com/apprunner/latest/dg/architecture.html#architecture-quotas
- **App Runner VPC Connector:** https://docs.aws.amazon.com/apprunner/latest/dg/network-vpc.html
- **App Runner Custom Domains:** https://docs.aws.amazon.com/apprunner/latest/dg/manage-custom-domains.html
- **App Runner Auto Scaling:** https://docs.aws.amazon.com/apprunner/latest/dg/manage-autoscaling.html
- **App Runner Observability (X-Ray):** https://docs.aws.amazon.com/apprunner/latest/dg/monitor-xray.html
- **CDK AppRunner L1 constructs:** https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apprunner-readme.html
- **AWS SDK v3 AppRunner Client:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/apprunner/
- **App Runner GitHub source (managed runtimes):** https://docs.aws.amazon.com/apprunner/latest/dg/service-source-code.html
- **ECR image source and auto-deploy:** https://docs.aws.amazon.com/apprunner/latest/dg/service-source-image.html
