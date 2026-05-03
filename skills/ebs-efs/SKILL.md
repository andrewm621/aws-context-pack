---
name: ebs-efs
description: Amazon EBS and EFS guidance — block storage volumes, file systems, performance tiers, snapshots, encryption. Use when configuring storage for EC2, ECS, or Lambda.
metadata:
  priority: 4
  docs:
    - "https://docs.aws.amazon.com/ebs/"
    - "https://docs.aws.amazon.com/efs/"
  pathPatterns:
    - 'storage/**'
    - 'volumes/**'
  bashPatterns:
    - '\baws\s+ec2\s+(create|describe|delete|attach|detach)-volume\b'
    - '\baws\s+efs\b'
  importPatterns:
    - "@aws-sdk/client-ebs"
    - "@aws-sdk/client-efs"
    - "aws-cdk-lib/aws-efs"
  promptSignals:
    phrases:
      - "ebs"
      - "efs"
      - "block storage"
      - "file system"
      - "ebs volume"
      - "elastic file system"
      - "ebs snapshot"
      - "gp3"
---

# Amazon EBS and EFS

## What It Is & When to Use It

Amazon **EBS** (Elastic Block Store) is network-attached block storage for EC2 instances. It behaves like a physical disk: you format it with a filesystem, mount it to exactly one EC2 instance at a time (with the exception of io1/io2 Multi-Attach), and read/write at block level. EBS volumes persist independently from the EC2 instance lifecycle — the instance can stop, terminate, and restart while the volume retains data.

Amazon **EFS** (Elastic File System) is a managed NFS (Network File System) service. It provides a shared filesystem that multiple EC2 instances, ECS tasks, or Lambda functions can mount concurrently across multiple Availability Zones. You do not provision capacity — EFS grows and shrinks automatically and you pay per GB actually stored.

### Storage Type Decision Matrix

| Storage Type | Mount | Capacity | Durability | Best For |
|---|---|---|---|---|
| **EBS gp3** | 1 EC2 (or Multi-Attach on io2) | 1 GB–16 TB | 99.8–99.9% | Boot volumes, databases, single-instance apps |
| **EBS io2 Block Express** | 1 EC2 | 4 GB–64 TB | 99.999% | High-IOPS databases (Oracle, SQL Server), SAP |
| **EBS st1** | 1 EC2 | 125 GB–16 TB | 99.8–99.9% | Log processing, Kafka, throughput-heavy sequential reads |
| **EBS sc1** | 1 EC2 | 125 GB–16 TB | 99.8–99.9% | Cold archive, infrequently accessed large files |
| **EFS Standard** | Many EC2/ECS/Lambda | Unlimited (auto) | 99.9999999% | Shared content repos, CMS assets, ML training datasets |
| **EFS Standard-IA** | Many EC2/ECS/Lambda | Unlimited (auto) | 99.9999999% | Same as above but infrequently accessed — 90% cheaper |
| **Instance Store** | 1 EC2 (ephemeral) | Instance-defined | None (lost on stop) | Caches, temp files, shuffle space for Spark/Hadoop |
| **S3** | Application (not OS mount) | Unlimited | 99.999999999% | Objects, large media, backups, data lakes |

**When to use EBS:** Single EC2 instance needs block-level storage. Database data directories (MySQL, PostgreSQL, MongoDB). Boot volumes. Any workload where you need consistent, low-latency I/O from one compute node.

**When to use EFS:** Multiple EC2 instances or containers need to read/write the same files. Shared configuration or content that needs to be visible to all instances behind a load balancer. Machine learning training jobs accessing the same dataset from multiple nodes. Lambda functions that need persistent shared state beyond tmp space.

**When to use neither:** Data is objects (use S3). Data is relational (use RDS or Aurora — they manage their own EBS). Ephemeral scratch space (use instance store or Lambda's /tmp).

---

## Service Surface

### EBS Volume Types

| Type | IOPS (Max) | Throughput (Max) | Size | $/GB-month | $/IOPS-month | Best For |
|---|---|---|---|---|---|---|
| **gp3** (default) | 16,000 | 1,000 MB/s | 1–16 TB | $0.08 | $0.005 (above 3k) | General purpose — start here |
| **gp2** (legacy) | 16,000 | 250 MB/s | 1–16 TB | $0.10 | — (IOPS tied to size) | Migrating from old deployments |
| **io2 Block Express** | 256,000 | 4,000 MB/s | 4–64 TB | $0.125 | $0.065 | Critical databases needing >16k IOPS |
| **io1** (legacy) | 64,000 | 1,000 MB/s | 4–16 TB | $0.125 | $0.065 | Legacy high-IOPS workloads |
| **st1** | 500 | 500 MB/s | 125 GB–16 TB | $0.045 | — | Big data, log streaming |
| **sc1** | 250 | 250 MB/s | 125 GB–16 TB | $0.015 | — | Lowest cost, cold storage |

Pricing verified against us-east-1 public pricing, 2024.

**gp3 baseline is free:** gp3 includes 3,000 IOPS and 125 MB/s at no extra charge regardless of volume size. You only pay extra if you provision above that baseline. This is why the vast majority of workloads should use gp3 — you get solid IOPS without paying the io2 premium.

### EFS Pricing & Performance Modes

| Storage Class | $/GB-month | Throughput Mode | Use Case |
|---|---|---|---|
| **Standard** | $0.30 | Elastic (default) or Provisioned | Active files, frequently read |
| **Standard-IA** (Infrequent Access) | $0.025 | — | Files not accessed in 30 days |
| **One Zone** | $0.16 | Elastic or Provisioned | Dev/staging, cost-sensitive, one AZ acceptable |
| **One Zone-IA** | $0.01 | — | Lowest cost, single AZ, cold |

**Throughput modes:**
- **Elastic** (default, 2022+): scales automatically based on workload, billed per GB transferred. Best for most workloads — no capacity planning.
- **Provisioned**: you specify MB/s (up to 1,024 MB/s per filesystem). Use when throughput is consistently higher than what Elastic provides.
- **Bursting** (legacy): throughput tied to stored data size (50 MB/s per TB). Avoid for new filesystems; migrate to Elastic.

**Lifecycle policy:** EFS can automatically move files to Standard-IA after 7, 14, 30, 60, or 90 days of no access, and move them back to Standard on first access. Enable this — it typically reduces EFS costs by 60–80% for content repositories with mixed access patterns.

### Key Limits

| Service | Limit |
|---|---|
| EBS max volume size (gp3/io2) | 16 TB / 64 TB |
| EBS max IOPS per EC2 instance | 260,000 (depends on instance type) |
| EBS snapshots per region | 100,000 |
| EFS filesystems per account | 1,000 per region |
| EFS max throughput (Elastic) | 3 GB/s read, 1 GB/s write |
| EFS mount targets per AZ | 1 per AZ per filesystem |
| Lambda /tmp size | 512 MB default, up to 10 GB |

---

## Mental Model

Three storage analogies that match how EBS, EFS, and instance store actually behave:

### EBS = USB Drive
EBS is a network-attached USB drive. You plug it into one computer (EC2 instance) at a time. It persists when you unplug it. You can take a snapshot (like copying the drive contents to S3). You can detach it and plug it into a different computer. The data stays until you explicitly delete the volume. **One mount point, persistent, moveable.**

The exception: io1/io2 Multi-Attach allows up to 16 Nitro-based EC2 instances in the same AZ to mount the same EBS volume simultaneously. This is for clustered database applications (Oracle RAC, WSFC) that coordinate writes at the application layer. Do not use Multi-Attach unless your application explicitly supports concurrent writers — you will corrupt data.

### EFS = Network Drive (NAS)
EFS is a network-attached filesystem like a corporate NAS. Many computers mount it simultaneously. Files written by one instance are immediately visible to all others. Capacity is infinite (no provisioning). It lives across multiple AZs — if one AZ fails, instances in other AZs keep reading and writing. **Many mount points, persistent, shared.**

EFS is POSIX-compliant: it supports file locking, permissions, and symbolic links. Applications that use a filesystem directly (CMS platforms, build systems, shared state files) can use EFS without code changes.

### Instance Store = RAM Disk
Instance store is physically attached NVMe storage on the EC2 host. It delivers the highest possible IOPS (millions) and lowest latency (microseconds) because there is no network hop. **But it is ephemeral**: the data is gone when the instance stops, hibernates, or fails. Treat it like a fast in-memory cache, not storage. Use it for temp files, shuffle space for distributed compute, or read-only dataset copies that can be rebuilt.

---

## Common Patterns

### Pattern 1: Create and Attach an EBS Volume (SDK v3)

Create a gp3 volume and attach it to a running EC2 instance programmatically.

```typescript
import {
  EC2Client,
  CreateVolumeCommand,
  AttachVolumeCommand,
  DescribeVolumesCommand,
  type VolumeState,
} from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({ region: "us-east-1" });

async function createAndAttachVolume(
  instanceId: string,
  availabilityZone: string,
  sizeGb: number = 100
): Promise<string> {
  // Create the volume
  const createResponse = await ec2.send(
    new CreateVolumeCommand({
      AvailabilityZone: availabilityZone, // must match EC2 instance AZ
      Size: sizeGb,
      VolumeType: "gp3",
      Iops: 3000,        // baseline — free, no extra charge
      Throughput: 125,   // MB/s — baseline — free
      Encrypted: true,   // always encrypt
      TagSpecifications: [
        {
          ResourceType: "volume",
          Tags: [{ Key: "Name", Value: "app-data" }],
        },
      ],
    })
  );

  const volumeId = createResponse.VolumeId!;
  console.log(`Created volume: ${volumeId}`);

  // Wait for volume to become available
  await waitForVolumeState(volumeId, "available");

  // Attach to instance
  await ec2.send(
    new AttachVolumeCommand({
      VolumeId: volumeId,
      InstanceId: instanceId,
      Device: "/dev/xvdf", // Linux device name — check OS docs for Windows
    })
  );

  console.log(`Attached ${volumeId} to ${instanceId}`);
  return volumeId;
}

async function waitForVolumeState(
  volumeId: string,
  targetState: VolumeState
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const response = await ec2.send(
      new DescribeVolumesCommand({ VolumeIds: [volumeId] })
    );
    const state = response.Volumes?.[0]?.State;
    if (state === targetState) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Volume ${volumeId} did not reach state ${targetState}`);
}
```

### Pattern 2: EBS Snapshot Lifecycle Management (SDK v3)

Create snapshots on a schedule and clean up old ones to control costs.

```typescript
import {
  EC2Client,
  CreateSnapshotCommand,
  DescribeSnapshotsCommand,
  DeleteSnapshotCommand,
} from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({ region: "us-east-1" });
const RETENTION_DAYS = 7;

export async function snapshotVolume(
  volumeId: string,
  description: string
): Promise<string> {
  const response = await ec2.send(
    new CreateSnapshotCommand({
      VolumeId: volumeId,
      Description: description,
      TagSpecifications: [
        {
          ResourceType: "snapshot",
          Tags: [
            { Key: "CreatedBy", Value: "snapshot-lambda" },
            { Key: "VolumeId", Value: volumeId },
            { Key: "CreatedAt", Value: new Date().toISOString() },
          ],
        },
      ],
    })
  );

  console.log(`Snapshot created: ${response.SnapshotId}`);
  return response.SnapshotId!;
}

export async function deleteOldSnapshots(volumeId: string): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  // List our managed snapshots for this volume
  const response = await ec2.send(
    new DescribeSnapshotsCommand({
      Filters: [
        { Name: "volume-id", Values: [volumeId] },
        { Name: "tag:CreatedBy", Values: ["snapshot-lambda"] },
        { Name: "status", Values: ["completed"] },
      ],
      OwnerIds: ["self"],
    })
  );

  const toDelete = (response.Snapshots ?? []).filter(
    (s) => s.StartTime && s.StartTime < cutoff
  );

  for (const snap of toDelete) {
    console.log(`Deleting snapshot ${snap.SnapshotId} from ${snap.StartTime}`);
    await ec2.send(
      new DeleteSnapshotCommand({ SnapshotId: snap.SnapshotId! })
    );
  }

  console.log(`Deleted ${toDelete.length} old snapshots.`);
}
```

### Pattern 3: EFS Filesystem with Lifecycle Policy (CDK)

Create an EFS filesystem across multiple AZs with automatic tiering to Infrequent Access storage.

```typescript
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as efs from "aws-cdk-lib/aws-efs";
import { Construct } from "constructs";

interface SharedFilesystemProps {
  vpc: ec2.IVpc;
}

export class SharedFilesystem extends Construct {
  public readonly filesystem: efs.FileSystem;
  public readonly accessPoint: efs.AccessPoint;

  constructor(scope: Construct, id: string, props: SharedFilesystemProps) {
    super(scope, id);

    // Security group — allow NFS (port 2049) from within the VPC
    const efsSecurityGroup = new ec2.SecurityGroup(this, "EfsSecurityGroup", {
      vpc: props.vpc,
      description: "EFS filesystem",
      allowAllOutbound: false,
    });
    efsSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(2049),
      "NFS from VPC"
    );

    this.filesystem = new efs.FileSystem(this, "FileSystem", {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: efsSecurityGroup,
      encrypted: true,
      // Elastic throughput — scales automatically, billed per GB transferred
      throughputMode: efs.ThroughputMode.ELASTIC,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      // Move files to IA after 30 days of no access (saves ~90%)
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      // Move back to Standard on first access
      outOfInfrequentAccessPolicy:
        efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // don't delete data on stack destroy
    });

    // Access point — enforce a POSIX identity for mounting from Lambda
    this.accessPoint = this.filesystem.addAccessPoint("AppAccessPoint", {
      path: "/app-data",
      createAcl: {
        ownerGid: "1000",
        ownerUid: "1000",
        permissions: "755",
      },
      posixUser: {
        gid: "1000",
        uid: "1000",
      },
    });

    new cdk.CfnOutput(this, "FilesystemId", {
      value: this.filesystem.fileSystemId,
    });
  }
}
```

### Pattern 4: EFS Mounted in Lambda (CDK)

Lambda functions can mount EFS for persistent shared storage beyond the 512 MB–10 GB /tmp limit.

```typescript
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

// Assumes filesystem and accessPoint are created as in Pattern 3

const processingLambda = new nodejs.NodejsFunction(this, "ProcessingFunction", {
  entry: "src/handlers/process.ts",
  runtime: lambda.Runtime.NODEJS_22_X,
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  filesystem: lambda.FileSystem.fromEfsAccessPoint(
    accessPoint,
    "/mnt/shared" // mount path inside Lambda execution environment
  ),
  timeout: cdk.Duration.minutes(5),
  memorySize: 1024,
  environment: {
    SHARED_DIR: "/mnt/shared",
  },
});

// Grant read/write access to the filesystem
filesystem.grantReadWrite(processingLambda);
```

Lambda handler using the mounted path:

```typescript
// src/handlers/process.ts
import { readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const SHARED_DIR = process.env.SHARED_DIR ?? "/mnt/shared";

export const handler = async (event: { jobId: string; data: string }) => {
  const outputPath = join(SHARED_DIR, `${event.jobId}-result.json`);

  // Write result to EFS — visible to all other Lambda instances and EC2
  await writeFile(outputPath, JSON.stringify({ result: event.data }));

  // List all results accumulated across invocations
  const files = await readdir(SHARED_DIR);
  const results = await Promise.all(
    files.map(async (f) => ({
      file: f,
      content: JSON.parse(await readFile(join(SHARED_DIR, f), "utf-8")),
    }))
  );

  return { statusCode: 200, body: JSON.stringify({ results }) };
};
```

### Pattern 5: Create an EFS Filesystem via SDK (SDK v3)

Programmatically create an EFS filesystem and mount target.

```typescript
import {
  EFSClient,
  CreateFileSystemCommand,
  CreateMountTargetCommand,
  PutLifecycleConfigurationCommand,
  DescribeFileSystemsCommand,
} from "@aws-sdk/client-efs";

const efs = new EFSClient({ region: "us-east-1" });

async function createSharedFilesystem(
  subnetId: string,
  securityGroupId: string
): Promise<string> {
  // Create filesystem
  const fsResponse = await efs.send(
    new CreateFileSystemCommand({
      Encrypted: true,
      ThroughputMode: "elastic",
      PerformanceMode: "generalPurpose",
      Tags: [{ Key: "Name", Value: "shared-app-data" }],
    })
  );

  const fileSystemId = fsResponse.FileSystemId!;
  console.log(`Created EFS filesystem: ${fileSystemId}`);

  // Wait for filesystem to become available
  await waitForEfsAvailable(fileSystemId);

  // Create mount target in a subnet (do this per AZ/subnet you need)
  await efs.send(
    new CreateMountTargetCommand({
      FileSystemId: fileSystemId,
      SubnetId: subnetId,
      SecurityGroups: [securityGroupId],
    })
  );

  // Enable lifecycle management — move to IA after 30 days
  await efs.send(
    new PutLifecycleConfigurationCommand({
      FileSystemId: fileSystemId,
      LifecyclePolicies: [
        { TransitionToIA: "AFTER_30_DAYS" },
        { TransitionToPrimaryStorageClass: "AFTER_1_ACCESS" },
      ],
    })
  );

  console.log(`Mount target created, lifecycle policy applied.`);
  return fileSystemId;
}

async function waitForEfsAvailable(fileSystemId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const response = await efs.send(
      new DescribeFileSystemsCommand({ FileSystemId: fileSystemId })
    );
    const state = response.FileSystems?.[0]?.LifeCycleState;
    if (state === "available") return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`EFS ${fileSystemId} did not become available in time`);
}
```

---

## Gotchas

**1. gp3 baseline IOPS are free — don't pay for io2 unless you actually need >16,000 IOPS.**
gp3 provides 3,000 IOPS and 125 MB/s at no cost beyond the base storage rate. You can provision up to 16,000 IOPS at $0.005/IOPS-month. io2 Block Express starts at $0.125/GB and $0.065/IOPS — the cost difference is enormous. Profile your application under production load before choosing io2; most workloads fit within gp3.

**2. Unattached EBS volumes still incur full storage charges.**
An EBS volume that is not attached to any EC2 instance bills at the same rate as an attached one. Snapshots you take before deleting volumes are much cheaper ($0.05/GB-month for compressed snapshot data). Set up a CloudWatch alarm for `VolumeStatus` or audit unattached volumes periodically. Use AWS Cost Explorer's resource-level detail to find orphaned volumes.

**3. EBS snapshots are incremental — but the first one is full.**
After the first snapshot, subsequent snapshots only store changed blocks. This makes them efficient for ongoing backups. However, restoring from a snapshot always produces a complete volume. And snapshot pricing ($0.05/GB-month) is based on total stored data, not per-snapshot size. Deleting an older snapshot in a chain does not lose data — AWS maintains block references across the chain.

**4. EBS volumes are AZ-locked — you cannot attach a us-east-1a volume to a us-east-1b instance.**
EBS volumes live in a single Availability Zone. To move a volume to another AZ, you must create a snapshot and restore it in the target AZ. This is also true for recovery scenarios: if an AZ fails, EBS volumes in that AZ are unavailable until the AZ recovers. EFS does not have this limitation — it is multi-AZ by default.

**5. EFS performance degrades when accessing many small files.**
EFS is NFS over the network. Latency per operation is typically 1–3ms (vs. <0.2ms for EBS gp3). Workloads that open thousands of small files (build systems, node_modules, Python packages) will be noticeably slower on EFS than on EBS. Do not store `node_modules` or language package caches on EFS. Use EBS or container image layers for that.

**6. EFS Elastic throughput is billed per GB transferred — it is not free above baseline.**
Unlike EFS Provisioned throughput (flat monthly rate), Elastic throughput charges $0.03/GB read and $0.06/GB write (us-east-1). For a workload that reads 10 TB/month, that is $300 in throughput charges alone. Benchmark both modes for high-throughput workloads; Provisioned can be cheaper above a certain transfer volume.

**7. Lambda + EFS requires the Lambda to be in a VPC.**
Mounting EFS from Lambda forces the function into a VPC (EFS is a VPC-only resource). This adds ~500ms to cold start time as the VPC network interface is attached. It also requires NAT Gateway for internet access from VPC Lambda, adding cost. Weigh these against the benefit of shared persistent storage. For most Lambda use cases, DynamoDB, S3, or ElastiCache is a better fit than EFS.

**8. EBS encryption must be enabled at volume creation — you cannot encrypt an existing unencrypted volume in place.**
To encrypt an existing volume: create a snapshot, copy the snapshot with encryption enabled, create a new volume from the encrypted snapshot, detach the old volume, attach the new one. Enable account-level encryption by default in the EC2 console (`EC2 > Account Attributes > EBS encryption`) to ensure all new volumes are encrypted automatically.

**9. gp2 IOPS scale with volume size — migrating to gp3 can be a performance regression if not configured correctly.**
gp2 provides 3 IOPS per GB (a 1 TB gp2 = 3,000 IOPS baseline, a 5 TB gp2 = 15,000 IOPS). If you have a gp2 volume larger than 1 TB primarily for IOPS rather than capacity, migrating to gp3 at the default baseline (3,000 IOPS) will reduce performance. Always explicitly provision the IOPS on gp3 to match or exceed what you had on gp2 before switching.

**10. EFS One Zone sacrifices multi-AZ resilience — not suitable for production.**
EFS One Zone stores data in a single AZ. If that AZ experiences a disruption, the filesystem is unavailable (and in rare failure scenarios, data could be lost). One Zone is 47% cheaper ($0.16/GB vs $0.30/GB) and appropriate for dev environments, staging, and workloads with easily reconstructable data. Never use it as the primary storage for production workloads.

**11. Snapshot costs accumulate across the chain — deleting recent snapshots may not reduce costs.**
If you have snapshots S1, S2, S3 (S1 oldest, S3 newest), and S2 has unique blocks not in S3, deleting S3 while keeping S1 and S2 does not eliminate the data that was unique to S3 — that data is absorbed into the chain. Use Amazon Data Lifecycle Manager (DLM) to manage retention systematically rather than deleting snapshots manually, which can produce unexpected billing outcomes.

**12. EFS mount helper vs. manual NFS mount — always use the mount helper.**
AWS provides `amazon-efs-utils` (the EFS mount helper) which handles TLS encryption in transit, IAM authorization, and connection recovery. Manual NFS mounts (`mount -t nfs4 ...`) bypass these features. Install `amazon-efs-utils` on your AMI and mount with `mount -t efs -o tls,iam <fs-id>:/ /mnt/efs`.

---

## Official Documentation

- [EBS User Guide](https://docs.aws.amazon.com/ebs/latest/userguide/)
- [EBS Volume Types](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html)
- [EBS Snapshots](https://docs.aws.amazon.com/ebs/latest/userguide/EBSSnapshots.html)
- [Amazon Data Lifecycle Manager](https://docs.aws.amazon.com/ebs/latest/userguide/snapshot-lifecycle.html)
- [EBS Pricing](https://aws.amazon.com/ebs/pricing/)
- [EFS User Guide](https://docs.aws.amazon.com/efs/latest/ug/)
- [EFS Performance](https://docs.aws.amazon.com/efs/latest/ug/performance.html)
- [EFS Pricing](https://aws.amazon.com/efs/pricing/)
- [EFS with Lambda](https://docs.aws.amazon.com/lambda/latest/dg/configuration-filesystem.html)
- [@aws-sdk/client-ec2 (EBS operations)](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/ec2/)
- [@aws-sdk/client-efs](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/efs/)
- [CDK aws-efs constructs](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_efs-readme.html)
