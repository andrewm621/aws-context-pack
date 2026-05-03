---
name: elasticache
description: Amazon ElastiCache guidance — Redis and Memcached, caching strategies, cluster modes, serverless, session storage. Use when adding caching or in-memory data stores to AWS applications.
metadata:
  priority: 4
  docs:
    - "https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/"
  pathPatterns:
    - 'cache/**'
    - 'redis/**'
  bashPatterns:
    - '\baws\s+elasticache\b'
  importPatterns:
    - "@aws-sdk/client-elasticache"
    - "aws-cdk-lib/aws-elasticache"
    - "ioredis"
    - "redis"
  promptSignals:
    phrases:
      - "elasticache"
      - "redis"
      - "memcached"
      - "caching layer"
      - "session store"
      - "redis cluster"
---

## What It Is & When to Use It

Amazon ElastiCache is a fully managed in-memory data store service. It runs either **Redis** (now branded as Valkey by the open-source community, though AWS continues to offer Redis-compatible nodes) or **Memcached** on infrastructure AWS manages — patching, failover, replication, monitoring, and backups are handled for you.

The core use cases are:

- **Caching** — store the results of expensive database queries, API calls, or computed values so repeat requests are served in sub-millisecond time rather than hitting the primary database.
- **Session storage** — keep user session data in a fast, shared store accessible by multiple application instances (Lambda, ECS, EC2).
- **Pub/Sub messaging** — Redis channels allow decoupled components to broadcast and subscribe to events with low latency.
- **Rate limiting and counters** — Redis atomic increment (`INCR`) and TTL-based keys are the standard building block for API rate limiters.
- **Leaderboards and sorted sets** — Redis sorted sets provide O(log N) rank operations without touching a relational database.
- **Distributed locks** — Redis `SET NX PX` pattern implements distributed mutual exclusion across microservices.

### Redis vs. Memcached Decision

| Criteria | Redis | Memcached |
|---|---|---|
| Data structures | Strings, hashes, lists, sets, sorted sets, streams, bitmaps, HyperLogLog | Strings (key-value) only |
| Persistence | Optional (RDB snapshots + AOF) | None — restart = data loss |
| Replication | Yes (primary + up to 5 replicas per shard) | No |
| Pub/Sub | Yes | No |
| Lua scripting | Yes | No |
| Transactions (MULTI/EXEC) | Yes | No |
| Cluster mode | Yes (sharding across up to 500 nodes) | Yes (client-side sharding) |
| Multi-threading | Single-threaded command execution (I/O is multi-threaded in Redis 6+) | Multi-threaded |
| Session storage | Ideal | Works, but no persistence |
| Simple shared cache at massive scale | Good | Slightly simpler operationally |

**Default to Redis.** Memcached's only meaningful advantage is marginally simpler mental model and multi-threaded command execution at extreme throughput. If you need persistence, pub/sub, Lua, sorted sets, or sessions, Redis is the only choice. If you are building a pure key-value cache that can tolerate complete data loss on restart and need to squeeze out every microsecond on GET/SET at enormous volume, Memcached is worth considering — but this is rare.

### ElastiCache Serverless

Launched in 2023, **ElastiCache Serverless** removes cluster sizing and management entirely. You create a cache, AWS scales capacity automatically, and you pay per ECU (ElastiCache Compute Unit) used plus data stored. No node types, no shard counts, no replica configuration.

| | ElastiCache Serverless | ElastiCache (Node-based) |
|---|---|---|
| Provisioning | None — auto-scales | Choose node type + shard/replica count |
| Minimum cost | ~$90/month (minimum 1 GB data storage + baseline ECU cost) | As low as ~$12/month for a single `cache.t4g.micro` |
| Scaling | Automatic, instant | Manual resizing or scheduled scaling |
| Best for | Unpredictable traffic, teams who want zero ops | Cost-sensitive workloads, predictable traffic, tight budget |
| Cluster mode | Always on | Optional |
| Multi-AZ | Always on | Configurable |

Serverless is not cheap at idle. The ~$90/month floor means node-based clusters are often more economical for stable workloads. Use Serverless for: early-stage products where right-sizing is unknown, traffic that spikes unpredictably by 10x+, or teams with no capacity planning bandwidth.

---

## Service Surface

### Engine Versions

| Engine | Current Versions | Notes |
|---|---|---|
| Redis | 7.x (latest recommended) | Full feature set, Redis 7 added multi-part AOF, ACLs improvements |
| Redis 6.x | Supported | ACLs introduced, client-side caching |
| Memcached | 1.6.x | No major new features — stable |

### Node Types

| Family | Use Case | Example Sizes |
|---|---|---|
| `cache.t4g.*` | Dev, staging, small production | micro (~$12/mo), small (~$23/mo), medium (~$47/mo) |
| `cache.r7g.*` | Memory-optimized production | large (~$160/mo), xlarge (~$320/mo) |
| `cache.m7g.*` | General-purpose production | large (~$130/mo), xlarge (~$260/mo) |
| `cache.r6g.*` | Previous-gen memory-optimized | Available, slightly cheaper than r7g |

Graviton (g-suffix) nodes are 20–30% more cost-efficient than x86 equivalents. Prefer `t4g`, `r7g`, `m7g` for new deployments.

### Pricing (approximate, us-east-1, 2024)

- **Node-based:** hourly instance price per node. A `cache.r7g.large` (13 GB RAM) runs ~$0.221/hr (~$160/month).
- **Serverless:** $0.00034 per ECU-second + $0.125 per GB-hour stored. Minimum effective cost ~$90/month with 1 GB stored data.
- **Data transfer:** free within same AZ (use the same-AZ endpoint when possible), $0.01/GB cross-AZ.
- **Backup storage:** first 100% of cache size is free; beyond that, $0.085/GB-month.

### Key Service Limits

| Limit | Value |
|---|---|
| Clusters per region | 500 |
| Nodes per cluster (Redis cluster mode) | 500 (90 shards × up to 6 nodes per shard) |
| Replicas per shard | 5 |
| Max item size (Redis) | 512 MB per value |
| Max item size (Memcached) | 1 MB per value |
| Parameter groups per account | 150 |

---

## Mental Model

Four concepts explain nearly every ElastiCache decision:

### 1. VPC Isolation — No Public Access

ElastiCache clusters live entirely inside a VPC and have no public endpoints. There is no mechanism to connect from the internet directly. This is by design — in-memory stores should never be exposed publicly. Every client (Lambda, ECS task, EC2 instance) must be in the same VPC (or a peered VPC) to reach ElastiCache.

This has two practical implications:
- **Lambda must be VPC-configured** to reach ElastiCache. This means assigning the Lambda function to the same VPC and subnets as the cache. VPC-attached Lambdas have a slightly higher cold start cost (ENI provisioning), though with Hyperplane/LLME this is now typically under 100ms.
- **Security groups control access.** The ElastiCache security group should only allow inbound traffic on port 6379 (Redis) or 11211 (Memcached) from the security group(s) of your application tier. Never `0.0.0.0/0`.

### 2. Connection Pooling Is Essential from Lambda

Lambda functions are short-lived, but TCP connections to Redis are not free to establish. A naive pattern — create a new `ioredis` or `redis` client inside the handler function body — opens a new connection on every invocation. At moderate concurrency this exhausts Redis connection limits (default `maxclients` is 65,000 but meaningful overhead starts well below that) and adds 5–15ms of TCP handshake latency per invocation.

The correct pattern: initialize the Redis client outside the handler (at module scope). Lambda reuses the execution context across warm invocations, so the connection is reused. Combine this with client-side connection pooling if using a cluster-mode setup.

### 3. Cluster Mode Enabled vs. Disabled

Redis offers two topologies:

**Cluster mode disabled (single shard):**
- One primary node + up to 5 read replicas.
- All data lives on one shard. Max data = node RAM.
- Simple — one endpoint for writes, one for reads.
- Supports all Redis commands including multi-key operations and Lua scripts spanning multiple keys.

**Cluster mode enabled (multiple shards):**
- Data sharded across 1–90 shards, each with its own primary + replicas.
- Scales horizontally — total capacity = sum of shard RAM.
- Multi-key operations (MGET, MSET, transactions) only work if all keys hash to the same slot (use hash tags: `{user:123}:session`, `{user:123}:prefs`).
- Required for datasets larger than a single node can hold or write throughput that saturates a single primary.

**Default to cluster mode disabled** unless your dataset exceeds node memory or you have very high write throughput. It is simpler to operate and avoids hash tag complexity.

### 4. Caching Patterns

Four patterns cover 90% of caching use cases:

**Cache-Aside (Lazy Loading):** Application checks cache first; on miss, loads from database and writes to cache. Most common pattern. Cache never holds stale data for keys not yet requested. Downside: first request after TTL expiry hits the database (cache miss penalty).

**Write-Through:** Application writes to cache and database simultaneously on every mutation. Cache is always warm and consistent. Downside: writes are slower (two writes instead of one); cache holds data that may never be read.

**Write-Behind (Write-Back):** Application writes to cache only; a background process asynchronously flushes to the database. Fastest writes. Risky — data in cache but not yet persisted can be lost on cache failure. Use only when write latency is critical and some data loss is acceptable.

**TTL-Based Expiry:** Every key gets a TTL. When it expires, the next read misses and refreshes. Simplest consistency mechanism. Match TTL to data freshness tolerance: user profile (5 minutes), product catalog (1 hour), static reference data (24 hours).

---

## Common Patterns

### Pattern 1: ElastiCache Redis Cluster via CDK

```typescript
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import { Construct } from "constructs";

interface RedisCacheProps {
  vpc: ec2.IVpc;
  appSecurityGroup: ec2.ISecurityGroup; // SG of the application tier
}

export class RedisCache extends Construct {
  public readonly primaryEndpoint: string;
  public readonly readerEndpoint: string;
  public readonly port: number = 6379;

  constructor(scope: Construct, id: string, props: RedisCacheProps) {
    super(scope, id);

    // Security group — only allow inbound Redis from the app SG
    const cacheSecurityGroup = new ec2.SecurityGroup(this, "CacheSecurityGroup", {
      vpc: props.vpc,
      description: "ElastiCache Redis",
      allowAllOutbound: false,
    });
    cacheSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(props.appSecurityGroup.securityGroupId),
      ec2.Port.tcp(6379),
      "Redis from application tier"
    );

    // Subnet group — place cache in private subnets
    const subnetGroup = new elasticache.CfnSubnetGroup(this, "SubnetGroup", {
      description: "Redis cache subnet group",
      subnetIds: props.vpc.privateSubnets.map((s) => s.subnetId),
      cacheSubnetGroupName: `${cdk.Names.uniqueId(this)}-redis-subnets`,
    });

    // Parameter group — Redis 7.x with sensible defaults
    const paramGroup = new elasticache.CfnParameterGroup(this, "ParamGroup", {
      cacheParameterGroupFamily: "redis7",
      description: "Redis 7 custom params",
      properties: {
        "maxmemory-policy": "allkeys-lru",    // evict least-recently-used keys when full
        "lazyfree-lazy-eviction": "yes",       // non-blocking eviction
        "lazyfree-lazy-expire": "yes",         // non-blocking TTL expiry
        "activedefrag": "yes",                 // online memory defragmentation
      },
    });

    // Replication group (cluster mode disabled — single shard + 1 replica)
    const replicationGroup = new elasticache.CfnReplicationGroup(
      this,
      "ReplicationGroup",
      {
        replicationGroupDescription: "Application Redis cache",
        engine: "redis",
        engineVersion: "7.1",
        cacheNodeType: "cache.r7g.large",
        numCacheClusters: 2,             // 1 primary + 1 replica
        automaticFailoverEnabled: true,  // requires >= 2 nodes
        multiAzEnabled: true,
        cacheParameterGroupName: paramGroup.ref,
        cacheSubnetGroupName: subnetGroup.ref,
        securityGroupIds: [cacheSecurityGroup.securityGroupId],
        atRestEncryptionEnabled: true,
        transitEncryptionEnabled: true,
        transitEncryptionMode: "required",
        snapshotRetentionLimit: 7,       // daily snapshots, 7-day retention
        snapshotWindow: "03:00-04:00",   // UTC
        preferredMaintenanceWindow: "sun:04:00-sun:05:00",
        autoMinorVersionUpgrade: true,
      }
    );
    replicationGroup.addDependency(subnetGroup);
    replicationGroup.addDependency(paramGroup);

    this.primaryEndpoint = replicationGroup.attrPrimaryEndPointAddress;
    this.readerEndpoint = replicationGroup.attrReaderEndPointAddress;

    new cdk.CfnOutput(this, "PrimaryEndpoint", { value: this.primaryEndpoint });
    new cdk.CfnOutput(this, "ReaderEndpoint", { value: this.readerEndpoint });
  }
}
```

### Pattern 2: Lambda Redis Client with Connection Reuse

Initialize the client at module scope so the connection is reused across warm Lambda invocations. The client must be lazy-connected — do not `await client.connect()` at module level (it blocks the module load and fails on first cold start if the VPC interface is not yet ready).

```typescript
// src/lib/redis.ts
import Redis from "ioredis";

// Module-scope client — reused across warm invocations
let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (client && client.status === "ready") {
    return client;
  }

  client = new Redis({
    host: process.env.REDIS_PRIMARY_ENDPOINT!,
    port: 6379,
    tls: {},                           // ElastiCache requires TLS in transit
    connectTimeout: 3_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 2,
    lazyConnect: true,                 // don't connect until first command
    enableOfflineQueue: false,         // fail fast rather than queue commands
    retryStrategy: (times) => {
      if (times > 3) return null;      // stop retrying after 3 attempts
      return Math.min(times * 100, 500);
    },
  });

  client.on("error", (err) => {
    console.error("Redis client error:", err);
  });

  return client;
}

// src/handlers/getProduct.ts
import { getRedisClient } from "../lib/redis";

const CACHE_TTL_SECONDS = 300; // 5 minutes

export const handler = async (event: { productId: string }) => {
  const redis = getRedisClient();
  const cacheKey = `product:${event.productId}`;

  // Cache-aside: check cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss — fetch from primary data store
  const product = await fetchProductFromDatabase(event.productId);
  if (!product) {
    return null;
  }

  // Write to cache with TTL
  await redis.set(cacheKey, JSON.stringify(product), "EX", CACHE_TTL_SECONDS);

  return product;
};

async function fetchProductFromDatabase(productId: string) {
  // Your database call here
  return { id: productId, name: "Example Product", price: 99.99 };
}
```

### Pattern 3: Session Storage with Sliding TTL

Store and retrieve user sessions in Redis. Each session key is prefixed and given an explicit TTL. `GETEX` atomically refreshes the TTL on read (sliding expiry).

```typescript
// src/lib/session.ts
import { randomUUID } from "crypto";
import { getRedisClient } from "./redis";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const SESSION_PREFIX = "session:";

interface UserSession {
  userId: string;
  email: string;
  roles: string[];
  createdAt: number;
}

export async function createSession(data: UserSession): Promise<string> {
  const redis = getRedisClient();
  const sessionId = randomUUID();
  const key = `${SESSION_PREFIX}${sessionId}`;

  await redis.set(key, JSON.stringify(data), "EX", SESSION_TTL_SECONDS);

  return sessionId;
}

export async function getSession(sessionId: string): Promise<UserSession | null> {
  const redis = getRedisClient();
  const key = `${SESSION_PREFIX}${sessionId}`;

  // GETEX: get value and reset TTL (sliding expiry)
  const raw = await redis.call(
    "GETEX", key, "EX", SESSION_TTL_SECONDS
  ) as string | null;
  if (!raw) return null;

  return JSON.parse(raw) as UserSession;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(`${SESSION_PREFIX}${sessionId}`);
}

export async function deleteAllUserSessions(userId: string): Promise<void> {
  // Avoid KEYS in production — maintain a secondary index instead
  const redis = getRedisClient();
  const userSessionsKey = `user-sessions:${userId}`;

  const sessionIds = await redis.smembers(userSessionsKey);
  if (sessionIds.length === 0) return;

  const pipeline = redis.pipeline();
  for (const sid of sessionIds) {
    pipeline.del(`${SESSION_PREFIX}${sid}`);
  }
  pipeline.del(userSessionsKey);
  await pipeline.exec();
}
```

### Pattern 4: Rate Limiter with Sliding Window

Atomic Redis operations implement a precise sliding-window rate limiter without external locking.

```typescript
// src/lib/rateLimiter.ts
import { getRedisClient } from "./redis";

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // Unix timestamp ms
}

/**
 * Sliding window rate limiter.
 * Tracks request timestamps in a sorted set; removes entries outside the window
 * and counts what remains — all in a single atomic pipeline.
 */
export async function checkRateLimit(
  identifier: string,      // e.g., IP address or user ID
  limitPerWindow: number,  // e.g., 100
  windowSeconds: number    // e.g., 60
): Promise<RateLimitResult> {
  const redis = getRedisClient();
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const key = `ratelimit:${identifier}`;

  const pipeline = redis.pipeline();
  // Remove timestamps older than the window
  pipeline.zremrangebyscore(key, "-inf", windowStart);
  // Add current request timestamp (score = timestamp, member = unique ID)
  pipeline.zadd(key, now, `${now}-${Math.random()}`);
  // Count requests in window
  pipeline.zcard(key);
  // Reset TTL on the key
  pipeline.expire(key, windowSeconds * 2);

  const results = await pipeline.exec();
  const count = (results?.[2]?.[1] as number) ?? 0;

  return {
    allowed: count <= limitPerWindow,
    remaining: Math.max(0, limitPerWindow - count),
    resetAt: now + windowSeconds * 1000,
  };
}
```

### Pattern 5: ElastiCache Serverless via CDK

For variable workloads where you want zero operational overhead:

```typescript
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import { Construct } from "constructs";

export class ServerlessRedisCache extends Construct {
  public readonly endpoint: string;
  public readonly port: number = 6379;

  constructor(
    scope: Construct,
    id: string,
    props: { vpc: ec2.IVpc; appSg: ec2.ISecurityGroup }
  ) {
    super(scope, id);

    const cacheSg = new ec2.SecurityGroup(this, "CacheSg", {
      vpc: props.vpc,
      description: "ElastiCache Serverless Redis",
    });
    cacheSg.addIngressRule(
      ec2.Peer.securityGroupId(props.appSg.securityGroupId),
      ec2.Port.tcp(6379),
      "Redis from app"
    );

    // ElastiCache Serverless — L1 construct (no L2 available yet as of 2024)
    const serverlessCache = new elasticache.CfnServerlessCache(this, "Cache", {
      serverlessCacheName: `${cdk.Names.uniqueId(this)}-cache`,
      engine: "redis",
      description: "Serverless Redis cache",
      securityGroupIds: [cacheSg.securityGroupId],
      subnetIds: props.vpc.privateSubnets.map((s) => s.subnetId),
      cacheUsageLimits: {
        dataStorage: {
          maximum: 10,   // GB — soft ceiling to avoid bill surprises
          unit: "GB",
        },
        ecpuPerSecond: {
          maximum: 5000, // ECPUs — cap throughput
        },
      },
      snapshotRetentionLimit: 7,
    });

    this.endpoint = serverlessCache.attrEndpointAddress;

    new cdk.CfnOutput(this, "ServerlessCacheEndpoint", {
      value: this.endpoint,
    });
  }
}
```

### Pattern 6: Describe and Monitor Clusters via AWS SDK v3

```typescript
import {
  ElastiCacheClient,
  DescribeReplicationGroupsCommand,
  DescribeCacheClustersCommand,
  ModifyReplicationGroupCommand,
} from "@aws-sdk/client-elasticache";

const client = new ElastiCacheClient({ region: "us-east-1" });

// List all replication groups and their status
export async function listRedisClusters() {
  const response = await client.send(
    new DescribeReplicationGroupsCommand({ MaxRecords: 100 })
  );

  return (response.ReplicationGroups ?? []).map((rg) => ({
    id: rg.ReplicationGroupId,
    status: rg.Status,
    nodeType: rg.CacheNodeType,
    primaryEndpoint: rg.NodeGroups?.[0]?.PrimaryEndpoint?.Address,
    readerEndpoint: rg.NodeGroups?.[0]?.ReaderEndpoint?.Address,
    memberClusters: rg.MemberClusters ?? [],
  }));
}

// Check individual node status (for health monitoring or runbooks)
export async function getClusterNodeStatus(clusterId: string) {
  const response = await client.send(
    new DescribeCacheClustersCommand({
      CacheClusterId: clusterId,
      ShowCacheNodeInfo: true,
    })
  );

  const cluster = response.CacheClusters?.[0];
  return {
    status: cluster?.CacheClusterStatus,
    nodes: cluster?.CacheNodes?.map((n) => ({
      id: n.CacheNodeId,
      status: n.CacheNodeStatus,
      endpoint: n.Endpoint?.Address,
    })),
  };
}

// Scale up node type — applied at next maintenance window by default
export async function modifyNodeType(
  replicationGroupId: string,
  newNodeType: string // e.g., "cache.r7g.xlarge"
) {
  await client.send(
    new ModifyReplicationGroupCommand({
      ReplicationGroupId: replicationGroupId,
      CacheNodeType: newNodeType,
      ApplyImmediately: false,
    })
  );
}
```

---

## Gotchas

**1. ElastiCache has no public endpoint — Lambda must be VPC-configured.**
This is the most common source of connection timeouts. Lambda functions outside a VPC cannot reach ElastiCache at all. Place Lambda in the same VPC and private subnets as the cache, and ensure the Lambda's security group is allowed inbound on port 6379 in the cache's security group. If you add ElastiCache to an existing Lambda stack, account for the ENI provisioning step in deployment.

**2. ElastiCache Serverless minimum cost is ~$90/month.**
The pricing page quotes ECU-seconds and per-GB-hour storage, but the minimum billing floor means even a lightly used serverless cache costs roughly $90/month. For a dev environment or a small internal tool, a `cache.t4g.micro` node (~$12/month) is a much better fit. Reserve Serverless for production workloads with unpredictable burst traffic.

**3. Redis connections are not free — always initialize clients outside the handler.**
Every `new Redis(...)` call opens a new TCP connection. Placing the client inside the Lambda handler body creates a new connection on every invocation, burns through Redis `maxclients` at scale, and adds TCP handshake latency to every request. Initialize at module scope; Lambda reuses the execution environment across warm invocations. The connection persists until the execution environment is recycled (typically minutes to hours).

**4. Cluster mode breaks multi-key operations that span hash slots.**
Commands like `MGET`, `MSET`, `SUNION`, `ZINTERSTORE`, and Lua scripts that operate on multiple keys only work in cluster mode if all involved keys hash to the same slot. The solution is hash tags — wrapping the shared portion of the key in braces: `{user:123}:cart` and `{user:123}:wishlist` both hash to the `user:123` slot. If you are migrating from cluster-mode-disabled to cluster-mode-enabled, audit every multi-key operation first.

**5. The `KEYS` command is dangerous in production.**
`KEYS *` (or any pattern scan) blocks Redis for the duration of the scan. On a cache with millions of keys, this can block for seconds, causing latency spikes across every client. Never use `KEYS` in application code. Use `SCAN` instead — it iterates in O(1) chunks with a cursor and does not block. If you need to find all keys matching a pattern, build a secondary index (e.g., a Redis Set tracking key names) rather than scanning the keyspace.

**6. Default eviction policy is `noeviction` — writes return errors when memory is full.**
By default, ElastiCache Redis uses `maxmemory-policy: noeviction`. When the cache reaches its memory limit, write operations return errors rather than evicting old data. For a cache (not a primary data store), set `allkeys-lru` (evict the least-recently-used key regardless of TTL) or `volatile-lru` (evict LRU keys that have a TTL set). Update the parameter group at cluster creation — changing it later requires a parameter group update and cluster reboot.

**7. Serialization overhead is real — benchmark before optimizing.**
JSON serialization/deserialization of large objects adds CPU time that can approach the Redis network round-trip time. For very hot keys (millions of reads/day) with large payloads, consider: MessagePack (more compact than JSON), storing flat fields in a Redis hash rather than a serialized blob, or pre-aggregating data to reduce value size. Profile before assuming the cache is the bottleneck.

**8. Transit encryption adds a TLS handshake cost on new connections.**
Transit encryption (`transitEncryptionEnabled: true`) is required for compliance and a good default. TLS adds ~5ms to each new connection establishment. With connection reuse (module-scope client) this is a one-time cost per Lambda execution environment. With naive per-invocation client creation, it compounds. Another reason to initialize the client outside the handler.

**9. ElastiCache backups are snapshots, not point-in-time recovery.**
Unlike RDS, ElastiCache does not offer continuous PITR to an arbitrary second. It offers daily automatic snapshots (RDB files) with up to 35 days retention. If Redis holds data you cannot afford to lose (not just a cache), either ensure the primary data store is the system of record and Redis is purely a cache, or enable AOF persistence for Redis (available on select node types). Serverless does not support AOF.

**10. Cluster failover takes 10–60 seconds — design for transient failures.**
When an ElastiCache primary node fails, ElastiCache promotes a replica automatically. The cluster endpoint DNS record updates to point to the new primary. This process typically takes 10–60 seconds. During this window, writes fail. Applications should catch Redis errors gracefully — fall back to the database, return stale cached data from a local in-process cache, or queue the write for retry. Do not treat Redis errors as fatal application errors.

**11. AUTH token rotation requires a two-step migration.**
If you enable Redis AUTH (password authentication), changing the token requires adding the new token alongside the old one first (Redis 6+ supports multiple AUTH tokens), migrating clients to the new token, then removing the old token. You cannot swap tokens atomically. Plan for this in credential rotation workflows — a single-step replacement causes an outage.

---

## Official Documentation

- **ElastiCache for Redis User Guide** — https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/
- **ElastiCache for Memcached User Guide** — https://docs.aws.amazon.com/AmazonElastiCache/latest/mem-ug/
- **ElastiCache Serverless** — https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/serverless.html
- **ElastiCache Pricing** — https://aws.amazon.com/elasticache/pricing/
- **Eviction Policies** — https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/ParameterGroups.Redis.html#ParameterGroups.Redis.3-2-4
- **Transit Encryption** — https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/in-transit-encryption.html
- **At-Rest Encryption** — https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/at-rest-encryption.html
- **Redis Cluster Mode** — https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/Replication.Redis-RedisCluster.html
- **@aws-sdk/client-elasticache** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/elasticache/
- **CDK aws-elasticache constructs** — https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_elasticache-readme.html
- **ioredis (Redis client for Node.js)** — https://github.com/redis/ioredis
- **node-redis (official Redis client)** — https://github.com/redis/node-redis
- **Redis SCAN vs KEYS** — https://redis.io/docs/latest/commands/scan/
- **Redis Cluster hash tags** — https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/#hash-tags
