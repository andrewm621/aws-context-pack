---
name: ec2
description: Amazon EC2 guidance — instance types, AMIs, pricing models, user data, placement groups, instance store vs EBS. Use when working with virtual machines on AWS.
metadata:
  priority: 4
  docs:
    - "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/"
  pathPatterns:
    - 'ec2/**'
    - 'userdata/**'
    - 'instances/**'
  bashPatterns:
    - '\baws\s+ec2\b'
    - '\baws\s+ssm\s+start-session\b'
  importPatterns:
    - "@aws-sdk/client-ec2"
    - "aws-cdk-lib/aws-ec2"
  promptSignals:
    phrases:
      - "ec2"
      - "ec2 instance"
      - "instance type"
      - "ami"
      - "spot instance"
      - "auto scaling group"
      - "launch template"
      - "user data"
---

# Amazon EC2

## What It Is & When to Use It

Amazon EC2 (Elastic Compute Cloud) provides resizable virtual machines (instances) in AWS data centers. You choose the OS, CPU, memory, storage, and networking. EC2 is the foundation of most compute workloads on AWS and sits beneath higher-level services like ECS on EC2, EMR, and self-managed Kubernetes (kops).

**Use EC2 when:**
- You need full control over the operating system, kernel parameters, or system software
- Workloads require GPU, FPGA, or specialized instance hardware (inference, training, HPC, video encoding)
- Running software that must run on a specific instance type for licensing reasons
- Long-running, stateful workloads that cannot be containerized or serverless-ified
- Migrating existing on-premises VMs with minimal refactoring (lift-and-shift)
- Steady, high-volume compute where Reserved Instances or Savings Plans make EC2 cheaper than Fargate or Lambda

**Choosing between alternatives:**

| Use Case | Best Choice | Reason |
|----------|-------------|--------|
| Short-lived event-driven code (<15 min) | Lambda | No infrastructure management, per-ms billing |
| Containerized apps, variable traffic | ECS Fargate | No instance management, per-task billing |
| GPU training or inference workloads | EC2 (P/G family) or SageMaker | Fargate has no GPU support |
| Lift-and-shift VM migration | EC2 | Full OS control, familiar tooling |
| Kubernetes with specific instance needs | EKS on EC2 | Access to all instance families, Spot integration |
| Batch/ETL at scale | AWS Batch on EC2/Fargate | Built-in job scheduling, retry, and array jobs |
| Steady-state, predictable workloads | EC2 + Reserved Instances | 40-72% discount over on-demand |


## Service Surface

### Instance Families

AWS groups instance types into families by primary workload. The naming convention is `[family][generation][modifiers].[size]` — for example, `m7g.2xlarge` is 7th-generation M-family, Graviton3 (g suffix), 2xlarge size.

| Family | Optimized For | Example Types | Use When |
|--------|--------------|---------------|----------|
| **M** (General Purpose) | Balanced CPU/memory/network | m7i, m7g, m6i, m6a | Web servers, app servers, dev environments — the safe default |
| **C** (Compute) | High CPU, lower memory ratio | c7i, c7g, c6i, c6a | CPU-bound workloads: encoding, HPC, gaming, batch compute |
| **R** (Memory) | High memory, lower CPU ratio | r7i, r7g, r6i | In-memory databases, Redis, large Java heaps, analytics |
| **T** (Burstable) | Baseline CPU + burst credits | t4g, t3, t3a | Bursty workloads: dev/test, small websites, CI workers |
| **X** (Extra Memory) | Very high memory-to-CPU ratio | x2idn, x2iedn | SAP HANA, in-memory analytics, large relational DBs |
| **I** (Storage Optimized) | High NVMe SSD throughput/IOPS | i4i, i3en | NoSQL databases, data warehousing, Elasticsearch |
| **D** (Dense Storage) | High sequential disk throughput | d3, d3en | Hadoop, MapReduce, data lakes with local storage |
| **P** (Accelerated - ML training) | NVIDIA A100/H100 GPUs | p4de, p5 | Deep learning training, LLM fine-tuning |
| **G** (Accelerated - Graphics/Inference) | NVIDIA GPUs, lower cost | g5, g4dn | ML inference, video transcoding, game streaming |
| **Inf** (Inference) | AWS Inferentia chips | inf2 | Cost-optimized ML inference (up to 70% cheaper than G) |
| **Trn** (Training) | AWS Trainium chips | trn1 | Cost-optimized LLM training (up to 50% cheaper than P) |
| **HPC** (High Performance Compute) | EFA networking, high CPU freq | hpc7g, hpc6a | Tightly coupled MPI workloads, computational fluid dynamics |

**Size suffixes:** `nano < micro < small < medium < large < xlarge < 2xlarge ... 48xlarge < metal`. Metal instances expose bare-metal hardware with no hypervisor — used for workloads that require direct hardware access.

**Processor suffixes:** `a` = AMD EPYC, `g` = AWS Graviton (ARM64), `i` = Intel, no suffix = previous-gen or mixed. Graviton instances are 10-40% cheaper than comparable x86 for the same performance.

### Pricing Models

| Model | Discount vs On-Demand | Commitment | Best For |
|-------|-----------------------|------------|----------|
| **On-Demand** | None (baseline) | None | Unpredictable workloads, short-term needs, dev/test |
| **Spot** | Up to 90% | None (interruptible with 2-min notice) | Fault-tolerant batch, stateless workers, CI/CD |
| **Reserved Instance (RI)** | Up to 72% (3yr, all upfront) | 1 or 3 year | Steady-state workloads with predictable baselines |
| **Compute Savings Plan** | Up to 66% | 1 or 3 year ($/hr commitment) | Flexible — applies across instance families, sizes, regions, and Lambda |
| **EC2 Instance Savings Plan** | Up to 72% | 1 or 3 year (specific region + family) | Less flexible than Compute, slightly higher discount |
| **Dedicated Host** | None (often more expensive) | On-Demand or 1/3 year | Regulatory/BYOL licensing that requires physical host control |
| **Dedicated Instance** | ~10% premium | None | Workloads that must not share hardware with other accounts |

**Savings Plan vs Reserved Instances:** Savings Plans are almost always preferred over RIs for new commitments. They apply to more workload types, auto-apply across sizes and families within the commitment level, and are simpler to manage. RIs are still worth it for very specific, stable workloads (same region + family + size for years).

**Spot interruption handling:** EC2 sends a termination notice 2 minutes before reclaiming a Spot instance. The instance metadata endpoint (`http://169.254.169.254/latest/meta-data/spot/termination-time`) will have a timestamp. Poll this endpoint every 5 seconds in your application to trigger graceful shutdown.

### Key Limits (us-east-1 defaults, soft limits requestable)

| Limit | Default |
|-------|---------|
| Running On-Demand instances (vCPU-based) | 32–1152 vCPUs depending on family |
| Elastic IP addresses per region | 5 |
| Security groups per network interface | 5 |
| Rules per security group (inbound + outbound) | 60 each |
| EBS volumes per instance | 40 |
| Spot Instance requests per region | 20 (dynamic limit) |

### Storage: Instance Store vs EBS

This is one of the most important decisions for stateful workloads on EC2.

| Property | Instance Store | EBS |
|----------|---------------|-----|
| **Persistence** | Lost on stop, hibernate, or termination | Persists independently of instance lifecycle |
| **Performance** | Extremely high (NVMe, direct attach, no network) | High but network-bound; varies by volume type |
| **Cost** | Included in instance price | Pay per GB-month + IOPS + throughput |
| **Snapshots** | Not supported | Supported (incremental, to S3) |
| **Multi-attach** | No | Yes (io2 volumes only, up to 16 instances) |
| **Resize** | No | Yes (can increase size, IOPS, type without stopping) |
| **Use when** | Temp scratch, cache, buffer, ephemeral data | OS root volumes, databases, any persistent data |

EBS volume types (2024):

| Type | Max IOPS | Max Throughput | Use When |
|------|----------|----------------|----------|
| `gp3` | 16,000 | 1,000 MB/s | Default choice — baseline 3,000 IOPS/125 MB/s included, independently configurable |
| `gp2` | 16,000 | 250 MB/s | Legacy — use gp3 for all new volumes (better price/perf) |
| `io2 Block Express` | 256,000 | 4,000 MB/s | Highest performance, SAP HANA, Oracle, critical DBs |
| `io1` | 64,000 | 1,000 MB/s | Legacy provisioned IOPS — use io2 instead |
| `st1` | 500 | 500 MB/s | Streaming throughput (Kafka, log processing, big data) |
| `sc1` | 250 | 250 MB/s | Cold data archives, infrequently accessed large volumes |

Always use `gp3` over `gp2` — it's cheaper, provides 3x better baseline throughput, and lets you set IOPS and throughput independently without paying for extra GBs.


## Mental Model

Five primitives to hold in your head:

### 1. Instance Lifecycle

```
Pending → Running → Stopping → Stopped → Terminated
                 ↘ Shutting-down → Terminated
```

Key lifecycle facts:
- **Stop** (EBS-backed only): Instance halts, EBS root volume persists. Instance store data is lost. You are not billed for stopped instances (but EBS volume charges continue).
- **Terminate**: Instance is destroyed. Root EBS volume deleted by default (`DeleteOnTermination: true`). Data EBS volumes persist by default.
- **Hibernate** (supported instance types only): RAM contents saved to EBS. On restart, memory is restored — processes resume where they left off. Boot time equals snapshot restore time (~30-60s vs full cold boot).
- **Reboot**: Equivalent to OS reboot. Instance retains its IP addresses, EBS volumes, and instance store.

### 2. Instance Metadata Service (IMDSv2)

The Instance Metadata Service (IMDS) is an HTTP endpoint at `http://169.254.169.254` that provides instance identity, IAM credentials, user data, network config, and more. Available only from within the instance.

**IMDSv1 is a security risk.** It allows any process on the instance (including SSRF-vulnerable web apps) to request IAM credentials without authentication. IMDSv2 requires a token-based request flow that mitigates SSRF attacks.

Always enforce IMDSv2:
- In Launch Templates: set `HttpTokens: required`
- In CDK/CloudFormation: `requireImdsv2: true` on the `Instance` or `LaunchTemplate`
- Account-level default: use EC2 `ModifyInstanceMetadataDefaults` to require IMDSv2 for all new instances

IMDSv2 token flow:
```bash
# Step 1: Get a session token (TTL: 1-21600 seconds)
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

# Step 2: Use the token in metadata requests
curl -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id

# Get IAM credentials (rotated automatically by EC2)
curl -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/iam/security-credentials/MyRole
```

### 3. Launch Templates vs Launch Configurations

**Always use Launch Templates.** Launch Configurations are the legacy mechanism and have been frozen — no new instance types or features are added to them. Launch Templates support versioning, Mixed Instance Policies (combining multiple instance types in an ASG), and all current features.

| Feature | Launch Template | Launch Configuration |
|---------|----------------|---------------------|
| Versioning | Yes ($Default, $Latest, or specific) | No (immutable) |
| Mixed Instance Policies (ASG) | Yes | No |
| IMDSv2 enforcement | Yes | No |
| Capacity Reservations | Yes | No |
| T2/T3 Unlimited mode | Yes | Limited |
| Status | Active, recommended | Frozen, deprecated path |

### 4. Auto Scaling Groups (ASG)

An ASG maintains a fleet of EC2 instances: it monitors instance health, replaces unhealthy instances, and scales capacity based on policies or schedules.

Key ASG concepts:
- **Desired capacity**: Target number of running instances. ASG works to reach and maintain this.
- **Min/Max**: Hard bounds. Scaling policies and schedules adjust desired capacity within these bounds.
- **Health checks**: EC2 status checks (default) or ELB health checks (recommended when behind a load balancer).
- **Lifecycle hooks**: Pause instance launch or termination to run custom actions (install agents, drain connections, snapshot). The instance waits in `Pending:Wait` or `Terminating:Wait` state until you complete or timeout the hook.
- **Warm pools**: Pre-initialized instances waiting in `Stopped` state. Dramatically reduces scale-out latency by eliminating OS boot and application init time.
- **Instance refresh**: Rolling replacement of all instances when you update the Launch Template version. Controlled by `MinHealthyPercentage` and `InstanceWarmup`.

### 5. Placement Groups

Placement groups control how instances are physically placed within AWS infrastructure. Three types:

| Type | Placement | Use When |
|------|-----------|----------|
| **Cluster** | Same physical rack, same AZ | Ultra-low latency between instances — HPC, MPI, tightly-coupled ML training |
| **Spread** | Separate physical hardware, up to 7 per AZ | Maximum fault isolation — critical instances, quorum nodes |
| **Partition** | Separate racks (partitions), multiple AZs | Distributed systems (Kafka, Cassandra, HDFS) — isolate rack failures |

## Common Patterns

### Pattern 1: Launch an Instance with IMDSv2 and SSM Access (CDK)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class Ec2InstanceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // Instance role — grants SSM access (no SSH key required)
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // Required for SSM Session Manager
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonSSMManagedInstanceCore'
        ),
      ],
    });

    // Amazon Linux 2023 AMI — automatically resolves to latest for the region
    const ami = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64, // Graviton — cheaper and faster for most workloads
    });

    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, // No public IP
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.M7G,
        ec2.InstanceSize.LARGE
      ),
      machineImage: ami,
      role,
      // Enforce IMDSv2 — never leave this as optional
      requireImdsv2: true,
      // EBS-optimized is default on modern instance types; explicit here for clarity
      ebsOptimized: true,
      // Root volume
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
      // User data — runs as root on first boot
      userData: ec2.UserData.custom(`#!/bin/bash
set -e
dnf update -y
dnf install -y amazon-cloudwatch-agent
# Start the CloudWatch agent
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a start
      `),
      // Detailed monitoring (1-minute CloudWatch metrics, vs 5-minute basic)
      detailedMonitoring: true,
    });

    // SSM Session Manager connect (no bastion host, no SSH keys)
    new cdk.CfnOutput(this, 'SessionManagerCommand', {
      value: `aws ssm start-session --target ${instance.instanceId}`,
    });
  }
}
```

### Pattern 2: Auto Scaling Group with Launch Template and Mixed Instance Policy

Use multiple instance types to maximize Spot availability and minimize interruptions.

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class AsgStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: false });

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Launch Template — versioned, supports all modern features
    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      requireImdsv2: true,
      ebsOptimized: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
      userData: ec2.UserData.custom(`#!/bin/bash
dnf install -y aws-cli
# Signal CloudFormation when instance is ready (used with lifecycle hooks)
/opt/aws/bin/cfn-signal -e $? --stack ${this.stackName} --region ${this.region}
      `),
      detailedMonitoring: true,
    });

    // ASG with mixed instance policy — diversifies across instance types and AZs
    const asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minCapacity: 2,
      desiredCapacity: 4,
      maxCapacity: 20,
      launchTemplate,
      // Mixed instances: on-demand base + spot for the rest
      mixedInstancesPolicy: {
        instancesDistribution: {
          onDemandBaseCapacity: 1,
          onDemandPercentageAboveBaseCapacity: 20,
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.PRICE_CAPACITY_OPTIMIZED,
        },
        launchTemplate,
        launchTemplateOverrides: [
          { instanceType: new ec2.InstanceType('m7i.large') },
          { instanceType: new ec2.InstanceType('m7a.large') },
          { instanceType: new ec2.InstanceType('m6i.large') },
          { instanceType: new ec2.InstanceType('m6a.large') },
        ],
      },
      healthCheck: autoscaling.HealthCheck.elb({ grace: cdk.Duration.seconds(60) }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({ minHealthyPercentage: 80 }),
      defaultInstanceWarmup: cdk.Duration.seconds(120),
    });

    // Scale on CPU
    asg.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Pre-warm for business hours
    asg.scaleOnSchedule('MorningScale', {
      schedule: autoscaling.Schedule.cron({ hour: '7', minute: '30' }),
      desiredCapacity: 6,
    });

    asg.scaleOnSchedule('NightScale', {
      schedule: autoscaling.Schedule.cron({ hour: '21', minute: '0' }),
      desiredCapacity: 2,
    });
  }
}
```

### Pattern 3: AMI Management with AWS SDK v3

Finding the latest AMI, describing instances, and managing the instance lifecycle programmatically.

```typescript
import {
  EC2Client,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  CreateTagsCommand,
  type Filter,
} from '@aws-sdk/client-ec2';

const ec2Client = new EC2Client({ region: 'us-east-1' });

// Find the latest Amazon Linux 2023 AMI for a given architecture
async function getLatestAmazonLinux2023Ami(
  arch: 'x86_64' | 'arm64' = 'arm64'
): Promise<string> {
  const response = await ec2Client.send(new DescribeImagesCommand({
    Owners: ['amazon'],
    Filters: [
      { Name: 'name', Values: ['al2023-ami-*-kernel-*'] },
      { Name: 'architecture', Values: [arch] },
      { Name: 'state', Values: ['available'] },
      { Name: 'root-device-type', Values: ['ebs'] },
      { Name: 'virtualization-type', Values: ['hvm'] },
    ],
  }));

  if (!response.Images?.length) {
    throw new Error(`No Amazon Linux 2023 AMI found for ${arch}`);
  }

  // Sort by creation date descending — newest first
  const sorted = response.Images.sort((a, b) =>
    (b.CreationDate ?? '').localeCompare(a.CreationDate ?? '')
  );

  return sorted[0].ImageId!;
}

// Describe running instances with a tag filter
async function getInstancesByTag(
  tagKey: string,
  tagValue: string
): Promise<Array<{ instanceId: string; state: string; privateIp: string }>> {
  const response = await ec2Client.send(new DescribeInstancesCommand({
    Filters: [
      { Name: `tag:${tagKey}`, Values: [tagValue] },
      { Name: 'instance-state-name', Values: ['running', 'pending'] },
    ],
  }));

  return (response.Reservations ?? []).flatMap(r =>
    (r.Instances ?? []).map(i => ({
      instanceId: i.InstanceId!,
      state: i.State?.Name ?? 'unknown',
      privateIp: i.PrivateIpAddress ?? '',
    }))
  );
}

// Launch a single instance programmatically
async function launchInstance(params: {
  amiId: string;
  instanceType: string;
  subnetId: string;
  securityGroupIds: string[];
  iamInstanceProfile: string;
  tags: Record<string, string>;
}): Promise<string> {
  const response = await ec2Client.send(new RunInstancesCommand({
    ImageId: params.amiId,
    InstanceType: params.instanceType as any,
    MinCount: 1,
    MaxCount: 1,
    SubnetId: params.subnetId,
    SecurityGroupIds: params.securityGroupIds,
    IamInstanceProfile: { Name: params.iamInstanceProfile },
    MetadataOptions: {
      HttpTokens: 'required',       // IMDSv2 enforced
      HttpEndpoint: 'enabled',
      HttpPutResponseHopLimit: 1,   // Prevent container escapes from accessing IMDS
    },
    EbsOptimized: true,
    BlockDeviceMappings: [
      {
        DeviceName: '/dev/xvda',
        Ebs: {
          VolumeType: 'gp3',
          VolumeSize: 20,
          Encrypted: true,
          DeleteOnTermination: true,
        },
      },
    ],
    TagSpecifications: [
      {
        ResourceType: 'instance',
        Tags: Object.entries(params.tags).map(([Key, Value]) => ({ Key, Value })),
      },
    ],
  }));

  return response.Instances![0].InstanceId!;
}
```

### Pattern 4: Systems Manager Session Manager — No SSH Access

SSH to EC2 instances is an operational and security liability. Removing SSH eliminates the need for bastion hosts, key pair management, and open port 22. Use SSM Session Manager for all interactive access.

```bash
# Prerequisites:
# 1. Instance has AmazonSSMManagedInstanceCore policy attached
# 2. SSM Agent running (pre-installed on Amazon Linux 2/2023, Ubuntu 16.04+)
# 3. AWS CLI + Session Manager plugin installed locally

# Open an interactive shell (no SSH key, no port 22, no bastion host)
aws ssm start-session --target i-0abc123def456

# Port forwarding — forward remote port to localhost (replaces SSH -L tunnels)
aws ssm start-session \
  --target i-0abc123def456 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["5432"],"localPortNumber":["5432"]}'
# Now: psql -h localhost -p 5432 -U myuser mydb

# Run a remote command without opening a session
aws ssm send-command \
  --instance-ids i-0abc123def456 \
  --document-name AWS-RunShellScript \
  --parameters commands='["sudo systemctl status nginx"]' \
  --query 'Command.CommandId' --output text

# Check command output
aws ssm get-command-invocation \
  --command-id <command-id> \
  --instance-id i-0abc123def456 \
  --query 'StandardOutputContent' --output text
```

Programmatic session start with AWS SDK v3:

```typescript
import { SSMClient, StartSessionCommand, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';

const ssmClient = new SSMClient({ region: 'us-east-1' });

// Run a shell command on an instance and get output
async function runRemoteCommand(instanceId: string, command: string): Promise<string> {
  const sendResult = await ssmClient.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: 'AWS-RunShellScript',
    Parameters: { commands: [command] },
    TimeoutSeconds: 30,
  }));

  const commandId = sendResult.Command!.CommandId!;

  // Poll for completion
  let attempts = 0;
  while (attempts < 12) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const result = await ssmClient.send(new GetCommandInvocationCommand({
      CommandId: commandId,
      InstanceId: instanceId,
    }));

    if (result.Status === 'Success') return result.StandardOutputContent ?? '';
    if (['Failed', 'TimedOut', 'Cancelled'].includes(result.Status ?? '')) {
      throw new Error(`Command failed: ${result.StatusDetails} — ${result.StandardErrorContent}`);
    }
    attempts++;
  }
  throw new Error('Command timed out waiting for result');
}
```


## Gotchas

### 1. Instance Store Data Is Lost on Stop — Permanently

If an instance backed by instance store (I-family, some C and M metal types) is stopped, hibernated, or terminated, all data on instance store volumes is irretrievably gone. There are no snapshots, no recovery, no warnings. EBS-backed instances retain their root volume on stop.

Always confirm whether a workload's local state can be reconstructed before using instance store. The I-family instances (i4i, i3en) are specifically designed for scratch workloads, cache tiers, and distributed databases that replicate data across nodes.

### 2. IMDSv1 Is a Security Risk — Enforce IMDSv2 Everywhere

IMDSv1 allows any HTTP request from within the instance to retrieve IAM credentials without authentication. A server-side request forgery (SSRF) vulnerability in a web application can expose your EC2 role credentials to attackers. This is how the Capital One breach happened in 2019.

Enforce IMDSv2 at three layers:
1. **Launch Template**: `HttpTokens: required`
2. **Account default**: `aws ec2 modify-instance-metadata-defaults --http-tokens required --region us-east-1`
3. **SCP/Config rule**: `ec2-imdsv2-check` AWS Config rule to detect non-compliant instances

Also set `HttpPutResponseHopLimit: 1` (the default) to prevent containers running on the instance from reaching the IMDS through extra network hops.

### 3. EBS-Optimized Not Enabled by Default on All Instance Types

Older or smaller instance types may not have EBS-optimized networking enabled by default, causing EBS and network I/O to compete on the same interface. All current-generation instances (6th gen and newer) have EBS optimization enabled by default and it cannot be disabled. For 5th-gen and older, always set `EbsOptimized: true` explicitly. Without it, gp3 volumes will not deliver their rated IOPS.

### 4. Spot Interruption Handling — 2-Minute Notice Is Not Guaranteed

The 2-minute termination notice is best-effort, not contractual. In practice, AWS almost always provides it, but applications should not assume they will receive the full 2 minutes. Design Spot workloads to checkpoint state frequently and tolerate interruption at any point.

Recommended patterns:
- Poll `http://169.254.169.254/latest/meta-data/spot/termination-time` every 5 seconds
- On interrupt notice, drain in-flight work, commit state, and exit cleanly
- Use SQS for work queues — the message becomes visible again after the visibility timeout if the instance is interrupted before deletion
- Use `price-capacity-optimized` Spot allocation strategy (not `lowest-price`) — it picks pools with the lowest interruption frequency, not the lowest absolute price

### 5. Public IP Assignment Rules — Not Automatic in All Subnets

New instances launched in a public subnet do not automatically receive a public IP unless the subnet's `MapPublicIpOnLaunch` attribute is true, or you explicitly request it at launch. Instances in private subnets never receive public IPs.

Without a public IP or Elastic IP, an instance in a public subnet cannot be reached from the internet and cannot reach the internet directly. Use NAT Gateway for private subnet outbound traffic. Never rely on auto-assigned public IPs for persistent workloads — they change on stop/start. Assign an Elastic IP for stable public-facing instances.

### 6. Graviton (ARM64) — Check Dependency Compatibility Before Migrating

Graviton instances are 10-20% cheaper and deliver comparable or better performance for most workloads. However, migrating from x86 requires:
- Compiled binaries recompiled for ARM64 (Go, Rust, C/C++)
- Docker images with `linux/arm64` variant available (check Docker Hub before switching)
- Native Node.js addons (bcrypt, sharp, sqlite3) need recompilation — use multi-arch builds
- Interpreted languages (Python, Node.js, Ruby) generally work without changes
- Lambda container images must use an ARM64 base image when targeting Graviton

Always test your full dependency tree on ARM64 before production migration. AWS Graviton-compatible software is well-documented at https://github.com/aws/aws-graviton-getting-started.

### 7. Launch Configuration Is Frozen — Migrate to Launch Templates

If your ASG still references a Launch Configuration, you are missing: IMDSv2 enforcement, Mixed Instance Policies, Capacity Reservations, and all features added after ~2021. AWS has announced Launch Configurations will be deprecated. Migrate by creating an equivalent Launch Template and updating the ASG — no instance replacement required for the migration itself.

### 8. gp2 Volumes Use a Credit Bucket System — gp3 Does Not

`gp2` volumes earn and spend I/O credits: 3 IOPS/GB baseline, burst to 3,000 IOPS when credits are available. A small gp2 volume (e.g., 8 GB root volume at 24 baseline IOPS) will burst fine under low load but throttle severely under sustained I/O. This causes mysterious performance degradation that looks like application slowness.

`gp3` has no credit system — it provides a flat 3,000 IOPS baseline regardless of size, with throughput and IOPS configurable independently. Migrate all gp2 volumes to gp3 for consistent performance and lower cost (20% cheaper per GB-month).

```bash
# Modify a single EBS volume from gp2 to gp3 (online, no downtime)
aws ec2 modify-volume \
  --volume-id vol-0abc123 \
  --volume-type gp3 \
  --iops 3000 \
  --throughput 125
```

### 9. Security Group Rules Are Stateful — NACLs Are Not

Security groups track connection state — if you allow outbound traffic on port 443, the return traffic is automatically allowed. Network ACLs (NACLs) are stateless: you must explicitly allow both inbound and outbound for every connection, including ephemeral port ranges (1024-65535 for return traffic).

Most EC2 networking should be done via security groups. Use NACLs only for subnet-level deny rules that need to override security groups (e.g., blocking a CIDR range across all resources in a subnet).

### 10. UserData Runs Once — Re-Running Requires Cloud-Init Reset

EC2 UserData scripts run once at first launch. They do not re-run on stop/start or reboot. If you need idempotent configuration management, use AWS Systems Manager Run Command, CloudFormation cfn-init + cfn-hup, or a configuration management tool (Ansible, Chef, Puppet) that runs at boot.

If you need to re-run UserData for testing (e.g., on a running instance), reset the cloud-init state:

```bash
# Amazon Linux 2023
sudo cloud-init clean --logs
sudo reboot
```

This re-runs UserData on next boot — useful in development but should never be done in production.


## Official Documentation

- **EC2 User Guide:** https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/
- **EC2 Instance Types:** https://aws.amazon.com/ec2/instance-types/
- **EC2 Pricing:** https://aws.amazon.com/ec2/pricing/
- **Spot Instance Advisor (interruption frequency by type):** https://aws.amazon.com/ec2/spot/instance-advisor/
- **Graviton Getting Started:** https://github.com/aws/aws-graviton-getting-started
- **IMDSv2 Migration Guide:** https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html
- **EBS Volume Types:** https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-volume-types.html
- **Launch Templates:** https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-launch-templates.html
- **Auto Scaling Groups:** https://docs.aws.amazon.com/autoscaling/ec2/userguide/what-is-amazon-ec2-auto-scaling.html
- **Savings Plans vs Reserved Instances:** https://aws.amazon.com/savingsplans/compute-pricing/
- **AWS SDK v3 EC2 Client:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/ec2/
- **SSM Session Manager:** https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html
- **Placement Groups:** https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/placement-groups.html
