# Lambda Cold Start Optimization

## What Causes Cold Starts

A cold start occurs when Lambda must provision a new execution environment before invoking your handler. This happens on the first invocation of a function, after a period of inactivity (typically 15–45 minutes, but not guaranteed), when scaling beyond existing warm instances, or after a deployment.

The cold start sequence has three distinct phases:

**1. Initialization (Lambda-controlled)**
Lambda provisions the microVM, downloads your deployment package or container image, and sets up the execution environment. This phase is entirely outside your control.

**2. Runtime bootstrap (partially controllable)**
The runtime process starts. For managed runtimes (Node.js, Python, Java, etc.) this means starting the language runtime and its standard library. Container images and custom runtimes have more variability here. Smaller runtimes bootstrap faster — Go and Rust binaries start nearly instantly because they compile to native code with minimal runtime overhead.

**3. Handler initialization (your code)**
Lambda runs your function's initialization code — everything outside the handler function itself. This includes importing modules, initializing SDK clients, loading configuration, and setting up database connection pools. This is the phase you have the most control over.

When an execution environment is reused (a "warm start"), phases 1 and 2 are skipped entirely. Phase 3 is also skipped because the runtime process is already running. Only your handler function body executes.

---

## Measuring Cold Starts

### CloudWatch Logs — INIT_START

Lambda logs an `INIT_START` line at the beginning of every cold start. Look for this in CloudWatch Logs Insights:

```
fields @timestamp, @message
| filter @message like /INIT_START/
| stats count() as coldStarts by bin(5m)
```

The `START` log entry also includes an `Init Duration` field (in ms) that appears only on cold starts:

```
REPORT RequestId: abc123  Duration: 45.23 ms  Billed Duration: 46 ms
Init Duration: 412.37 ms  ...
```

`Init Duration` measures phases 2 and 3 — runtime bootstrap plus your initialization code. Phase 1 (VM provisioning) is not included in any reported metric.

### X-Ray Tracing

X-Ray segments include an `Initialization` subsegment that appears only on cold starts. This is visible in the X-Ray service map and trace view. You can query it via the X-Ray API or CloudWatch ServiceLens. X-Ray gives you a timeline view that can show which part of your initialization (module imports, SDK clients, etc.) consumes the most time if you add custom subsegments.

### Lambda Insights and CloudWatch Metrics

Lambda Insights (via the CloudWatch Lambda Insights extension) adds an `init_duration` metric to every function, aggregable by function, alias, or version. This is the easiest way to build a dashboard showing cold start trends over time.

---

## Optimization Techniques (Ranked by Impact)

### 1. Provisioned Concurrency — Eliminates Cold Starts Entirely

Provisioned Concurrency (PC) pre-warms a specified number of execution environments so they are always ready. Those environments go through phases 1–3 before any request arrives, so invocations always get a warm start.

```typescript
// CDK
const fn = new lambda.Function(this, 'MyFn', { ... });
const version = fn.currentVersion;
const alias = new lambda.Alias(this, 'ProdAlias', {
  aliasName: 'prod',
  version,
  provisionedConcurrentExecutions: 5,
});
```

**Tradeoffs:**
- Eliminates cold starts for all requests up to the provisioned count
- You pay for provisioned environments even when idle (~$0.015/GB-hour on top of invocation costs)
- Use Application Auto Scaling to scale PC up/down on a schedule (e.g., business hours) to reduce cost
- Only applies to versioned functions with an alias or a published version — not `$LATEST`

**When to use:** Latency-sensitive APIs, customer-facing endpoints where P99 matters, any function where a 500ms spike is unacceptable.

### 2. SnapStart — Free Warm Starts for JVM, Python, .NET

Lambda SnapStart takes a snapshot of the execution environment after initialization (phases 1–3), stores it, and restores from that snapshot on subsequent invocations. Restore is much faster than re-running initialization.

```typescript
// CDK
const fn = new lambda.Function(this, 'JavaFn', {
  runtime: lambda.Runtime.JAVA_21,
  snapStart: lambda.SnapStartConf.ON_PUBLISHED_VERSIONS,
  ...
});
```

**Runtime support (as of 2025):** Java 11, 17, 21, Python 3.12+, .NET 8+.

**Tradeoffs:**
- No additional cost beyond normal invocation pricing
- Requires a published version (not `$LATEST`)
- Initialization hooks (`beforeCheckpoint`, `afterRestore`) let you handle state that shouldn't be snapshotted (e.g., open network connections, random seeds)
- Not effective if your init code is trivial — the savings are largest for JVM startup

**When to use:** Java functions with long JVM startup, any function where you can't justify PC costs.

### 3. Smaller Deployment Packages

Package size directly affects cold start duration — Lambda must download and extract your package before execution. The target is under 5MB zipped for fastest cold starts; anything over 50MB zipped starts meaningfully impacting initialization time.

**Tree-shaking and bundling (Node.js):**
```bash
# esbuild bundles and tree-shakes in one step
esbuild src/handler.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --external:@aws-sdk/* \  # AWS SDK v3 is available in the runtime
  --minify \
  --outfile=dist/handler.js
```

The AWS SDK v3 is pre-installed in Lambda's managed Node.js and Python runtimes — do not bundle it. In Node.js, import only the specific client you need (`@aws-sdk/client-s3`, not `aws-sdk`).

**Lambda Layers for shared dependencies:**
Move stable, large dependencies (ImageMagick binaries, ML model files, shared utility libraries) to a Lambda Layer. The layer is cached separately from your function package, so deployments of your function code don't require re-downloading the layer. See `layers-and-extensions.md` for packaging details.

**Docker images:**
If using container images, Lambda caches image layers. Structure your Dockerfile with stable dependencies in early layers and your function code in the final layer. This maximizes cache reuse across deployments.

### 4. Lazy Initialization — Initialize What You Need, When You Need It

The standard pattern is to initialize SDK clients outside the handler (so they persist across warm invocations) but defer expensive or connection-limited resources.

```typescript
// GOOD: SDK client initialized once, reused across invocations
import { S3Client } from '@aws-sdk/client-s3';
const s3 = new S3Client({ region: process.env.AWS_REGION });

// GOOD: Database connections initialized lazily on first use
let dbClient: DatabaseClient | undefined;
function getDb(): DatabaseClient {
  if (!dbClient) {
    dbClient = new DatabaseClient({ connectionString: process.env.DB_URL });
  }
  return dbClient;
}

export const handler = async (event: APIGatewayEvent) => {
  // s3 is already warm, db connects on first real invocation
  const db = getDb();
  ...
};
```

**Why lazy for databases?**
Database connection pools can time out during idle periods. If you eagerly initialize a connection in module scope and the execution environment sits idle for 30 minutes, the connection may be stale by the time the next request arrives. Lazy initialization lets you re-connect only when needed.

**Don't lazy-load things that are always used.** If every invocation needs the DynamoDB client, initialize it at module scope so it's ready immediately.

### 5. ARM64 / Graviton2

Switch from `x86_64` to `arm64` architecture. Lambda's Graviton2 instances are ~20% cheaper per GB-second and frequently show faster cold start times due to different memory characteristics.

```typescript
// CDK
const fn = new lambda.Function(this, 'MyFn', {
  architecture: lambda.Architecture.ARM_64,
  ...
});
```

**Tradeoffs:**
- Native ARM binaries required — most Node.js and Python code works unchanged
- C extensions, binary dependencies, and Docker images must be compiled for ARM64
- Lambda Layers must also be ARM64-compatible if architecture is switched

**When to use:** Almost always for Node.js and Python functions. Evaluate case-by-case for functions with native dependencies.

### 6. Ahead-of-Time Compilation and Tiered Compilation

**Java — disable tiered compilation for faster (but lower peak throughput) startup:**
```bash
# Set JAVA_TOOL_OPTIONS environment variable
JAVA_TOOL_OPTIONS=-XX:+TieredCompilation -XX:TieredStopAtLevel=1
```
This tells the JVM to skip the more aggressive JIT compilation tiers, trading peak runtime performance for faster startup. Use with SnapStart for best results — SnapStart snapshots after compilation, so the tradeoff mostly disappears.

**Go and Rust:**
Both compile to native binaries with minimal runtime overhead. Cold starts are fast by default (80–150ms for Go, 10–50ms for Rust). No tuning typically needed.

**Python:**
`.pyc` precompilation is automatic in Lambda's managed runtime. Ensure your dependencies are installed with `--compile-bytecode` or that `.pyc` files are included in your package.

### 7. Keep-Warm Scheduled Pings (Anti-Pattern — Use with Caution)

A common workaround is to schedule an EventBridge rule to invoke the function every 5 minutes with a "ping" event that the handler detects and returns immediately. This keeps at least one execution environment warm.

**Why this is not recommended:**
- Only keeps one instance warm — any concurrent requests still cold start
- Doesn't work with provisioned concurrency scaling needs
- Costs money for invocations that do no real work
- Doesn't survive deployments (new version = new cold start)
- EventBridge scheduling has ±1 minute jitter, so the "every 5 minutes" guarantee is approximate

Use Provisioned Concurrency instead. Keep-warm pings are a legacy pattern from before PC existed.

---

## Language-Specific Cold Start Benchmarks

These are representative ranges from typical production functions with moderate initialization code. Actual times depend heavily on package size, import count, and initialization work.

| Runtime | Typical Cold Start | Notes |
|---|---|---|
| Node.js 20/22 | 200–500ms | Varies with bundle size and import count |
| Python 3.12 | 200–400ms | SnapStart available; numpy/pandas add ~500ms+ |
| Java 21 | 3,000–8,000ms | Without SnapStart; with SnapStart: 200–600ms |
| .NET 8 | 800–2,000ms | Without SnapStart; with SnapStart: 200–500ms |
| Go 1.21 | 80–150ms | Native binary, minimal runtime overhead |
| Rust (custom runtime) | 10–50ms | Fastest option; custom runtime required |

These numbers assume a function with a reasonable initialization footprint (a few SDK clients, some config loading). Functions that load large ML models, establish many connections, or import heavy libraries will be at the high end or beyond.

---

## When Cold Starts Don't Matter

Not every function needs cold start optimization. Invest optimization effort based on actual latency requirements:

**Async invocations (SQS, SNS, S3 events, EventBridge)**
The caller doesn't wait for a response. A 3-second cold start on an SQS consumer is irrelevant if messages can queue briefly. Focus on throughput and error handling instead.

**Batch processing**
Step Functions, scheduled batch jobs, and data pipelines tolerate cold starts because total job duration (minutes to hours) dwarfs any individual function's startup time.

**Low-traffic scheduled tasks**
A function that runs once per day or once per hour will almost always cold start — optimizing it is rarely worth the effort. Use Provisioned Concurrency only if the scheduled task has strict latency requirements for its own output.

**Internal tooling and admin endpoints**
If your users are internal and an occasional slow response is acceptable, cold starts aren't a business problem.

**High-concurrency burst scenarios**
Paradoxically, extremely high traffic spikes (Lambda scaling from 0 to 1000 concurrent executions) will always include cold starts regardless of Provisioned Concurrency settings, because PC only covers the pre-provisioned count. Design for cold starts in burst scenarios even if you use PC.

---

## Anti-Patterns

**Importing the entire AWS SDK**
```typescript
// BAD — imports all services, adds megabytes to your bundle
import AWS from 'aws-sdk';
const s3 = new AWS.S3();

// GOOD — imports only S3 client, tree-shakeable
import { S3Client } from '@aws-sdk/client-s3';
const s3 = new S3Client({});
```

**Importing unused modules**
Every `import` or `require` at module scope runs during initialization. Audit your imports regularly. Tools like `depcheck` or webpack-bundle-analyzer can identify unused dependencies.

**Large Docker images without layer optimization**
```dockerfile
# BAD — single layer means full download on every cold start
COPY . .
RUN npm install && npm run build

# GOOD — dependencies cached in earlier layer, only app code changes
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
```

**Synchronous initialization in the handler body**
If you initialize an SDK client inside the handler function (not at module scope), it re-initializes on every invocation, even warm ones. Move client construction outside the handler.

**Connecting to RDS directly from Lambda without RDS Proxy**
Direct RDS connections from Lambda don't pool across execution environments. Under load, you'll exhaust database connection limits. Use RDS Proxy, which maintains a pool and multiplexes Lambda connections. This doesn't directly affect cold starts but is a related initialization concern.
