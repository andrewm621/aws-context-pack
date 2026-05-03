---
name: rds-aurora
description: Amazon RDS and Aurora guidance — managed relational databases, PostgreSQL, MySQL, connection pooling, read replicas, Multi-AZ, backups, Performance Insights. Use when working with relational databases on AWS.
metadata:
  priority: 6
  docs:
    - "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/"
    - "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/"
  pathPatterns:
    - 'database/**'
    - 'db/**'
    - 'migrations/**'
    - 'prisma/**'
    - 'drizzle/**'
  bashPatterns:
    - '\baws\s+rds\b'
    - '\bpsql\b'
    - '\bmysql\b'
  importPatterns:
    - "@aws-sdk/client-rds"
    - "@aws-sdk/client-rds-data"
    - "aws-cdk-lib/aws-rds"
  promptSignals:
    phrases:
      - "rds"
      - "aurora"
      - "postgresql"
      - "mysql"
      - "database instance"
      - "read replica"
      - "multi-az"
      - "rds proxy"
      - "aurora serverless"
      - "connection pooling"
---

## What It Is & When to Use It

Amazon RDS (Relational Database Service) is a managed service that handles provisioning, patching, backups, monitoring, and failover for six relational database engines: PostgreSQL, MySQL, MariaDB, Oracle, SQL Server, and Amazon's own Aurora engine. You bring the schema and queries; AWS runs the infrastructure.

**Aurora** is AWS's cloud-native relational engine. It is PostgreSQL-compatible and MySQL-compatible but built from scratch on a distributed storage layer that replicates data six ways across three Availability Zones. The compute (writer/reader instances) is decoupled from storage, which is what makes Aurora faster to fail over, faster to add replicas, and more resilient than standard RDS.

### When to use which

| Situation | Recommendation |
|---|---|
| Production PostgreSQL app needing HA | Aurora PostgreSQL (Multi-AZ cluster) |
| Production MySQL app | Aurora MySQL |
| Variable or bursty traffic (e.g., SaaS, cron-heavy) | Aurora Serverless v2 |
| True scale-to-zero (dev, staging, rarely-used) | Aurora Serverless v1 (legacy) or external Neon/PlanetScale |
| Oracle or SQL Server (licensing requirements) | RDS (Oracle/SQL Server) — Aurora does not support these |
| Simple low-traffic PostgreSQL or MySQL | RDS (cheaper at small scale than Aurora) |
| Key-value, simple access patterns, infinite scale | DynamoDB instead — don't reach for RDS here |
| Serverless functions (Lambda) connecting to any RDS/Aurora | Always add RDS Proxy between them |

### Aurora Serverless v2 vs v1

Aurora Serverless **v2** (current, 2022+) scales compute in fine-grained 0.5 ACU increments while the cluster is running. It does **not** scale to zero — minimum is 0.5 ACU (~$43/month). It is the recommended option for most variable workloads today.

Aurora Serverless **v1** (legacy) scales to zero but has a cold-start penalty (15–30 seconds) and limited feature support. Prefer v2 unless true zero-cost idle is a hard requirement.

---

## Service Surface

### Engine Options

| Engine | Latest Supported Version | Best For |
|---|---|---|
| Aurora PostgreSQL | 16.x (check console for latest) | Cloud-native, HA PostgreSQL |
| Aurora MySQL | 8.x | Cloud-native, HA MySQL |
| RDS PostgreSQL | 16.x | Simpler/smaller PostgreSQL workloads |
| RDS MySQL | 8.x | Simpler/smaller MySQL workloads |
| RDS MariaDB | 10.11.x | MariaDB-specific features |
| RDS Oracle | 19c, 21c | Oracle licensing compliance |
| RDS SQL Server | 2019, 2022 | SQL Server licensing compliance |

### Aurora vs RDS Comparison

| Feature | Aurora | RDS (PostgreSQL/MySQL) |
|---|---|---|
| Storage | Auto-scales to 128 TB, billed per GB-month | Manual allocation, max 64 TB (gp3) |
| Replication | 6 copies across 3 AZs (storage-level) | EBS replication to standby |
| Failover time | Typically < 30 seconds | 60–120 seconds |
| Read replicas (max) | 15 per cluster | 5 per instance |
| Cross-region replicas | Aurora Global Database (< 1s replication lag) | RDS Read Replicas (async) |
| Backtrack | Yes (rewind in-place, no restore needed) | No |
| I/O cost | Billed per I/O operation | Included in gp3 pricing |
| Starting cost | Higher (Aurora compute >= db.t3.medium) | Lower (db.t3.micro available) |

### Pricing Summary

- **RDS:** instance hours + gp3 storage ($0.115/GB-month) + backup storage (free up to DB size)
- **Aurora:** instance hours + storage ($0.10/GB-month) + I/O ($0.20 per 1M requests) + backup storage
- **Aurora Serverless v2:** $0.12 per ACU-hour + storage + I/O. 1 ACU ≈ 2 GB RAM.
- **RDS Proxy:** 1/100th of the underlying instance cost per hour (typically $0.015–$0.05/hr)
- **Multi-AZ RDS:** doubles instance cost (synchronous standby)
- **Data transfer:** free within same AZ, $0.01/GB cross-AZ, standard egress rates out of AWS

### Key Service Limits (default, can request increase)

| Limit | Value |
|---|---|
| DB instances per region | 40 |
| Aurora read replicas per cluster | 15 |
| RDS read replicas per instance | 5 |
| Max Aurora storage | 128 TB (auto-scaling) |
| Max RDS storage | 64 TB (gp3) |
| Automated backup retention | 1–35 days |
| RDS Proxy max connections multiplexed | Per instance size (see docs) |
| Parameter groups per account | 50 |

---

## Mental Model

Five primitives explain nearly every RDS/Aurora decision:

### 1. Aurora's Shared Distributed Storage Layer

Aurora separates compute from storage. The storage layer is a distributed, self-healing volume that lives across 3 AZs with 6 copies (4/6 quorum for writes, 3/6 for reads). When an Aurora writer instance fails, the new writer just re-attaches to the same storage volume — it does not need to copy or replay data. This is why Aurora failover is fast (< 30s) and why adding a read replica is fast (no data copy, just a new compute node connecting to the same storage).

RDS does not have this. RDS uses EBS volumes per instance with synchronous replication to a standby (Multi-AZ). Failover means promoting the standby and updating DNS, which takes 60–120 seconds.

### 2. Endpoints: Writer, Reader, Instance

Aurora exposes three endpoint types:
- **Cluster endpoint** (writer): always points to the current writer. Use for all writes and reads that need the freshest data.
- **Reader endpoint**: load-balances across all available reader instances. Use for read-heavy workloads (reporting, analytics, search).
- **Instance endpoints**: direct connection to a specific instance. Use only for debugging or when you need sticky routing.

Route reads to the reader endpoint to reduce writer load. This is the simplest Aurora scaling lever — add read replicas, they immediately join the reader endpoint pool.

### 3. RDS Proxy: Essential for Serverless

Lambda functions open a new database connection on every cold start and can hold connections idle between invocations. A 1,000-concurrency Lambda function can open 1,000 simultaneous connections, instantly exhausting `max_connections` on even a large RDS instance (`db.r5.large` has ~4,000 connections, but 1,000 idle ones are wasteful and degrading).

RDS Proxy solves this by maintaining a persistent connection pool to the database and multiplexing application connections through it. Lambda connects to the Proxy (fast, cheap), the Proxy manages the real DB connections. The Proxy also handles failover transparently — it re-routes connections to the new writer without the application seeing an error.

**Rule:** Any Lambda or ECS task that talks to RDS/Aurora must go through RDS Proxy.

### 4. Multi-AZ vs. Read Replicas

These solve different problems:
- **Multi-AZ** is for high availability (failover). The standby does not serve reads. It doubles instance cost. Essential for production; skip for dev/staging.
- **Read replicas** are for scaling read throughput. They can serve reads but add a small replication lag (milliseconds for Aurora, potentially seconds for RDS under high write load). They can also be promoted to a standalone instance for disaster recovery.

Aurora's Multi-AZ is implicit — the storage layer is always multi-AZ. Aurora read replicas serve reads and act as hot standbys for failover. You get both HA and read scaling from a single feature.

### 5. Backup Strategy: Automated + Snapshots + Backtrack

- **Automated backups**: continuous backup to S3, enabling point-in-time recovery (PITR) to any second within the retention window (1–35 days). Enabled by default. Zero performance impact on Aurora (storage-level backup).
- **Manual snapshots**: user-initiated, persist until explicitly deleted (survive even if the DB instance is deleted). Take one before every major change.
- **Aurora Backtrack**: rewind the entire cluster to a point in the past (up to 72 hours) without restoring from a snapshot. This is fast (seconds to minutes) and does not require a new DB instance. Use for accidental `DROP TABLE` or bad migrations.
- **Cross-region snapshot copy**: for disaster recovery in a different region. Automated, schedulable via Lambda or EventBridge.

---

## Common Patterns

### Pattern 1: Aurora Serverless v2 Cluster (CDK, PostgreSQL)

This is the recommended starting point for a production-grade PostgreSQL database on AWS. The cluster auto-scales compute between the min/max ACU range you define.

```typescript
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export class DatabaseStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly secret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: { vpc: ec2.IVpc }) {
    super(scope, id);

    // Security group — allow inbound Postgres from within VPC
    const dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc: props.vpc,
      description: "Aurora PostgreSQL cluster",
      allowAllOutbound: false,
    });
    dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      "PostgreSQL from VPC"
    );

    // Aurora Serverless v2 cluster
    this.cluster = new rds.DatabaseCluster(this, "AuroraCluster", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_2,
      }),
      writer: rds.ClusterInstance.serverlessV2("writer", {
        publiclyAccessible: false,
        enablePerformanceInsights: true,
        performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT, // 7 days free
      }),
      readers: [
        rds.ClusterInstance.serverlessV2("reader1", {
          scaleWithWriter: true, // reader scales with writer capacity
          enablePerformanceInsights: true,
          performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
        }),
      ],
      serverlessV2MinCapacity: 0.5,  // minimum — ~$43/month
      serverlessV2MaxCapacity: 16,   // max ACU — adjust for your workload
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSecurityGroup],
      defaultDatabaseName: "appdb",
      storageEncrypted: true,
      backup: {
        retention: cdk.Duration.days(14),
        preferredWindow: "03:00-04:00", // UTC
      },
      preferredMaintenanceWindow: "Sun:04:00-Sun:05:00",
      deletionProtection: true,       // prevent accidental deletion in production
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.secret = this.cluster.secret!;

    // Export endpoints for use in application stacks
    new cdk.CfnOutput(this, "ClusterEndpoint", {
      value: this.cluster.clusterEndpoint.hostname,
    });
    new cdk.CfnOutput(this, "ReaderEndpoint", {
      value: this.cluster.clusterReadEndpoint.hostname,
    });
    new cdk.CfnOutput(this, "SecretArn", {
      value: this.secret.secretArn,
    });
  }
}
```

### Pattern 2: RDS Proxy for Lambda Connections

Add an RDS Proxy between Lambda and Aurora. The Proxy handles connection pooling and failover transparency. Lambda authenticates to the Proxy via IAM (no password in environment variables).

```typescript
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";

// In your stack, after creating the cluster...
const proxy = new rds.DatabaseProxy(this, "AuroraProxy", {
  proxyTarget: rds.ProxyTarget.fromCluster(cluster),
  secrets: [cluster.secret!],
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  securityGroups: [dbSecurityGroup],
  iamAuth: true,            // IAM authentication — no DB passwords needed
  requireTLS: true,
  idleClientTimeout: cdk.Duration.minutes(10),
  maxConnectionsPercent: 90,  // proxy uses up to 90% of DB max_connections
  maxIdleConnectionsPercent: 50,
});

// Lambda function that connects through the proxy
const apiLambda = new nodejs.NodejsFunction(this, "ApiFunction", {
  entry: "src/handlers/api.ts",
  runtime: lambda.Runtime.NODEJS_22_X,
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  environment: {
    DB_PROXY_ENDPOINT: proxy.endpoint,
    DB_NAME: "appdb",
    AWS_REGION: this.region,
  },
  timeout: cdk.Duration.seconds(30),
});

// Grant Lambda permission to connect via IAM auth
proxy.grantConnect(apiLambda, "appuser"); // "appuser" is the DB username
```

Lambda handler connecting via IAM token (no password):

```typescript
// src/handlers/api.ts
import {
  RDSClient,
  GenerateAuthTokenCommand,
} from "@aws-sdk/client-rds";
import { Client } from "pg";

const rdsClient = new RDSClient({ region: process.env.AWS_REGION });

async function getDbConnection(): Promise<Client> {
  // Generate a short-lived IAM auth token (valid 15 minutes)
  const command = new GenerateAuthTokenCommand({
    hostname: process.env.DB_PROXY_ENDPOINT!,
    port: 5432,
    username: "appuser",
    region: process.env.AWS_REGION,
  });

  // Note: GenerateAuthToken is a local operation — it doesn't call AWS APIs.
  // Use the Signer utility instead for auth token generation:
  const { Signer } = await import("@aws-sdk/rds-signer");
  const signer = new Signer({
    hostname: process.env.DB_PROXY_ENDPOINT!,
    port: 5432,
    username: "appuser",
    region: process.env.AWS_REGION,
  });
  const token = await signer.getAuthToken();

  const client = new Client({
    host: process.env.DB_PROXY_ENDPOINT,
    port: 5432,
    database: process.env.DB_NAME,
    user: "appuser",
    password: token,          // IAM token serves as the password
    ssl: { rejectUnauthorized: true },
  });

  await client.connect();
  return client;
}

export const handler = async (event: unknown) => {
  const db = await getDbConnection();
  try {
    const result = await db.query("SELECT NOW()");
    return { statusCode: 200, body: JSON.stringify(result.rows[0]) };
  } finally {
    await db.end();
  }
};
```

### Pattern 3: Reader Endpoint Routing (Writes vs. Reads)

Route write queries to the cluster endpoint and read queries to the reader endpoint. Use two separate connection pool instances in your application.

```typescript
// src/lib/db.ts — Drizzle ORM with writer + reader pools
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const writerPool = new Pool({
  host: process.env.DB_WRITER_HOST,   // cluster endpoint
  port: 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: true },
  max: 10,
  idleTimeoutMillis: 30_000,
});

const readerPool = new Pool({
  host: process.env.DB_READER_HOST,   // reader endpoint
  port: 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: true },
  max: 20,  // readers can handle more connections
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(writerPool, { schema });       // mutations
export const dbRead = drizzle(readerPool, { schema });   // queries

// Usage in route handlers:
// import { db, dbRead } from "@/lib/db";
// await db.insert(orders).values(newOrder);           // goes to writer
// const results = await dbRead.select().from(orders); // goes to reader
```

### Pattern 4: Cross-Region Snapshot Copy for Disaster Recovery

Automate snapshot replication to a secondary region using the AWS SDK v3 from a Lambda or EventBridge-triggered function.

```typescript
import {
  RDSClient,
  DescribeDBClusterSnapshotsCommand,
  CopyDBClusterSnapshotCommand,
  DescribeDBClusterSnapshotsCommandInput,
} from "@aws-sdk/client-rds";

const PRIMARY_REGION = "us-east-1";
const DR_REGION = "us-west-2";
const CLUSTER_ID = "my-aurora-cluster";
const SNAPSHOT_COPY_RETENTION_DAYS = 7;

const primaryClient = new RDSClient({ region: PRIMARY_REGION });
const drClient = new RDSClient({ region: DR_REGION });

export async function copyLatestSnapshotToDrRegion(): Promise<void> {
  // Find the most recent automated snapshot
  const describeInput: DescribeDBClusterSnapshotsCommandInput = {
    DBClusterIdentifier: CLUSTER_ID,
    SnapshotType: "automated",
    MaxRecords: 5,
  };

  const snapshots = await primaryClient.send(
    new DescribeDBClusterSnapshotsCommand(describeInput)
  );

  const sorted = (snapshots.DBClusterSnapshots ?? [])
    .filter((s) => s.Status === "available")
    .sort((a, b) =>
      (b.SnapshotCreateTime?.getTime() ?? 0) -
      (a.SnapshotCreateTime?.getTime() ?? 0)
    );

  const latest = sorted[0];
  if (!latest?.DBClusterSnapshotArn) {
    console.log("No available automated snapshots found.");
    return;
  }

  const targetId = `dr-copy-${latest.DBClusterSnapshotIdentifier}`;

  console.log(`Copying snapshot ${latest.DBClusterSnapshotIdentifier} to ${DR_REGION}`);

  await drClient.send(
    new CopyDBClusterSnapshotCommand({
      SourceDBClusterSnapshotIdentifier: latest.DBClusterSnapshotArn,
      TargetDBClusterSnapshotIdentifier: targetId,
      SourceRegion: PRIMARY_REGION,
      CopyTags: true,
    })
  );

  console.log(`Snapshot copy initiated: ${targetId}`);
}

// List existing copies in DR region to enforce retention
export async function cleanupOldDrSnapshots(): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SNAPSHOT_COPY_RETENTION_DAYS);

  const snapshots = await drClient.send(
    new DescribeDBClusterSnapshotsCommand({
      SnapshotType: "manual",
      MaxRecords: 100,
    })
  );

  const oldCopies = (snapshots.DBClusterSnapshots ?? []).filter(
    (s) =>
      s.DBClusterSnapshotIdentifier?.startsWith("dr-copy-") &&
      (s.SnapshotCreateTime?.getTime() ?? Infinity) < cutoff.getTime()
  );

  for (const snap of oldCopies) {
    console.log(`Deleting old DR snapshot: ${snap.DBClusterSnapshotIdentifier}`);
    // Import and call DeleteDBClusterSnapshotCommand here
  }
}
```

---

## Gotchas

**1. Lambda + RDS without Proxy = connection exhaustion.**
Lambda opens a new database connection on cold start and can hold it across warm invocations. At scale, hundreds of concurrent Lambda executions exhaust `max_connections` silently — queries start timing out with no clear error. Always route Lambda through RDS Proxy. This is not optional for production serverless workloads.

**2. Aurora Serverless v2 does not scale to zero.**
Minimum capacity is 0.5 ACU, which costs approximately $43/month even with zero traffic. If you need true zero-cost idle (dev environments, demos, rarely-used internal tools), use Aurora Serverless v1 (being deprecated but still available), an external provider like Neon (which does scale to zero), or just pause an RDS instance manually on a schedule.

**3. RDS storage only grows, never shrinks.**
RDS storage auto-scaling is one-directional. Once Aurora or RDS allocates storage (even from a temporary spike), that capacity is reserved and billed forever until you migrate to a new instance. Provision conservatively and let auto-scaling grow it. If you need to reclaim space, take a snapshot and restore to a new instance with a smaller allocation.

**4. Multi-AZ doubles instance cost — disable it for non-production.**
A Multi-AZ RDS deployment spins up a synchronous standby that you pay for but cannot query. It is the right call for production; it is wasteful for dev and staging environments. Use a single-AZ instance (or Aurora's built-in redundancy) for lower environments.

**5. Static parameter group changes require a reboot.**
Parameter groups have two types of changes: dynamic (applied immediately) and static (requires instance reboot). If you change a static parameter (like `shared_buffers` in PostgreSQL), the change won't take effect until the next reboot. Apply these during maintenance windows or expect a brief downtime.

**6. Maintenance windows apply patches with or without your input.**
AWS applies minor version patches and OS updates during the configured maintenance window. If you have Multi-AZ or Aurora, this is typically zero-downtime. If you have a single-AZ instance, this is a brief outage. Set the window explicitly to a low-traffic period, don't leave it on the AWS default.

**7. Connection limits are per instance size, not per cluster.**
`max_connections` scales with instance memory. `db.t3.micro` allows approximately 85 connections. `db.t3.small` allows approximately 170. A web application with a 10-connection pool and 10 pods hits the micro limit immediately. Either size up the instance, use PgBouncer/RDS Proxy, or reduce pool sizes. Check `max_connections` before you go to production.

**8. Performance Insights is free for 7 days and invaluable for debugging.**
Enable Performance Insights at cluster creation. It shows you the top SQL queries by wait time, load, and frequency. Diagnosing a slow query without it means hunting through logs. With it, the hottest query is visible in 30 seconds. The 7-day free retention covers most incident investigations; 2 years costs $0.02/vCPU-hour.

**9. IAM authentication adds latency — pair it with connection pooling.**
Aurora supports IAM database authentication: Lambda generates a short-lived token and uses it as the password. This eliminates secrets in environment variables. However, token generation (via `@aws-sdk/rds-signer`) and the SSL handshake add approximately 10–15ms per new connection. With RDS Proxy, connections are reused and this cost is paid once per proxy connection, not per request.

**10. Encryption must be enabled at instance creation — it cannot be added later.**
If you create an RDS instance or Aurora cluster without `storageEncrypted: true`, you cannot enable encryption in place. The migration path is: create a snapshot, copy the snapshot with encryption enabled, restore to a new encrypted instance, then update your connection strings and swap over. Always enable encryption at creation, even for dev instances.

**11. Deleting an Aurora cluster without a final snapshot loses data permanently.**
By default, CDK's `RemovalPolicy.DESTROY` deletes the cluster without a snapshot. Always set `removalPolicy: cdk.RemovalPolicy.RETAIN` or `SNAPSHOT` for production clusters. The `deletionProtection: true` flag adds an extra guard — the API will refuse to delete the cluster until you disable it explicitly.

**12. Aurora Global Database replication lag is not zero.**
Aurora Global Database advertises < 1 second cross-region replication, but this is typical, not guaranteed. Under heavy write load, lag can grow. Secondary regions are read-only by design. Failover to a secondary region (promoting it to writer) takes 1–2 minutes and requires a DNS update. This is DR, not active-active.

---

## Official Documentation

- **RDS User Guide** — https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/
- **Aurora User Guide** — https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/
- **Aurora Serverless v2** — https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html
- **RDS Proxy** — https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html
- **RDS Pricing** — https://aws.amazon.com/rds/pricing/
- **Aurora Pricing** — https://aws.amazon.com/rds/aurora/pricing/
- **CDK aws-rds constructs** — https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds-readme.html
- **@aws-sdk/client-rds** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/rds/
- **@aws-sdk/client-rds-data** (Data API for Aurora Serverless) — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/rds-data/
- **@aws-sdk/rds-signer** (IAM auth tokens) — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-rds-signer/
- **Performance Insights** — https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PerfInsights.html
- **Aurora Backtrack** — https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Backtrack.html
- **Aurora Global Database** — https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html
