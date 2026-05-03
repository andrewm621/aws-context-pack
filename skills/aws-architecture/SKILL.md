---
name: aws-architecture
description: AWS architecture guidance — Well-Architected Framework, multi-account strategy, landing zones, service selection, architecture patterns, design principles. Use when designing systems or making architectural decisions on AWS.
metadata:
  priority: 5
  docs:
    - "https://docs.aws.amazon.com/wellarchitected/latest/framework/"
  pathPatterns:
    - 'architecture/**'
    - 'docs/architecture/**'
    - 'adr/**'
  bashPatterns:
    - '\baws\s+wellarchitected\b'
    - '\baws\s+organizations\b'
  importPatterns:
    - "@aws-sdk/client-wellarchitected"
    - "@aws-sdk/client-organizations"
  promptSignals:
    phrases:
      - "aws architecture"
      - "well-architected"
      - "multi-account"
      - "landing zone"
      - "aws design"
      - "aws pattern"
      - "serverless vs containers"
      - "aws best practice"
      - "control tower"
      - "aws organization"
---

## What It Is & When to Use It

AWS architecture is the practice of making deliberate service and design choices that balance performance, cost, security, reliability, and operational excellence across an application's lifecycle. The AWS Well-Architected Framework is the canonical evaluation lens; this skill provides the decision frameworks you need to actually apply it.

Use this skill when:
- Starting a new project on AWS and deciding which services to use
- Reviewing an existing architecture for reliability, cost, or security problems
- Facing "which service?" decisions (Lambda vs. ECS, SQS vs. EventBridge, RDS vs. DynamoDB)
- Designing multi-account structure, CI/CD pipelines, or landing zones
- Preparing for a Well-Architected Review or similar audit

Do not use it as a replacement for service-specific skills (Lambda, VPC, DynamoDB, etc.) — this skill is the map; those are the territory.


## Service Surface

### Well-Architected Tool & Supporting Services

| Service | Purpose | Cost |
|---------|---------|------|
| **AWS Well-Architected Tool** | Run formal workload reviews against the 6-pillar framework; track improvement plans | Free |
| **AWS Trusted Advisor** | Automated checks for cost, security, fault tolerance, service limits, performance | Free for core checks; Business/Enterprise support for full suite |
| **AWS Config** | Continuous compliance recording — tracks resource configuration changes and evaluates against rules | $0.003/config item recorded + $0.001/rule evaluation |
| **AWS Organizations** | Central management of multiple AWS accounts — SCPs, consolidated billing, account vending | Free |
| **AWS Control Tower** | Opinionated landing zone setup on top of Organizations — guardrails, account factory, dashboard | Free (pay for underlying services) |
| **AWS Service Catalog** | Curated, pre-approved product portfolios (CloudFormation templates) for self-service provisioning | Free (100 portfolios/account) |
| **AWS SSO / IAM Identity Center** | Centralized identity and access across all accounts in an Organization | Free |

### The 6 Well-Architected Pillars

| Pillar | Core Question | Key AWS Tools |
|--------|--------------|--------------|
| **Operational Excellence** | Can you run and improve your system effectively? | CloudWatch, X-Ray, Systems Manager, CloudTrail |
| **Security** | Are you protecting data and systems appropriately? | IAM, KMS, GuardDuty, Security Hub, Macie, Config |
| **Reliability** | Will your system recover from failures? | Multi-AZ, Auto Scaling, Route 53, Backup, DynamoDB global tables |
| **Performance Efficiency** | Are you using resources effectively as demand changes? | CloudFront, ElastiCache, Lambda, Graviton, CloudWatch metrics |
| **Cost Optimization** | Are you spending only what you need? | Cost Explorer, Budgets, Savings Plans, Compute Optimizer, Trusted Advisor |
| **Sustainability** | Are you minimizing environmental impact? | Graviton (better perf/watt), managed services, right-sizing |

Every architectural decision maps to tradeoffs across these pillars. Adding multi-region (Reliability +) also increases Cost, Complexity, and Operational burden. The framework makes those tradeoffs explicit.


## Mental Model

### 1. The 6 Pillars as a Decision Filter

Every significant architecture choice should be run through the pillars as a checklist, not a wish list. You cannot maximize all six simultaneously — the goal is to make explicit tradeoffs aligned with your workload's actual requirements.

Common tradeoff examples:
- **Multi-region active-active** (Reliability++) costs 2-3x more and doubles operational complexity. Justified for <99.99% RTO/RPO requirements, not for most SaaS products.
- **DynamoDB on-demand pricing** (Operational Excellence+, Cost-) is the right default for unpredictable workloads. Switch to provisioned only when traffic is predictable and cost matters at scale.
- **Lambda** (Cost+, Performance Efficiency+) has cold starts and 15-minute execution limits. ECS Fargate (Reliability+, Cost-) is better for long-running processes or warm connection pools.

When a decision is not obvious, build a one-page decision record (ADR) listing the options, the pillar tradeoffs, and the choice. This is more valuable than the choice itself.

### 2. Blast Radius Thinking

Design systems so that failures affect the smallest possible scope. Apply this principle at every layer:

- **AZ-level**: Deploy across 2-3 AZs. An AZ failure should affect <50% of capacity, not 100%.
- **Region-level**: Most workloads need Multi-AZ, not multi-region. Multi-region is reserved for <99.99% availability SLAs or regulatory data residency requirements.
- **Account-level**: Production, staging, and dev in separate accounts. A misconfigured IAM policy in dev cannot affect prod. A cost spike in a test workload cannot obscure prod spending.
- **Service-level**: Use SQS/EventBridge to decouple services. A downstream service failure queues messages rather than cascading failure upstream.
- **Deployment-level**: Blue/green and canary deployments limit the blast radius of bad deploys to a small percentage of traffic.

The question is not "will this fail?" but "when this fails, what is the worst-case impact, and is that acceptable?"

### 3. Managed > Self-Managed (Until It Isn't)

Default to managed services. AWS has optimized, patched, and scaled these — you get that for free. Self-managing the equivalent means hiring DBAs, on-call engineers, and dealing with upgrades.

| Self-Managed | Managed Alternative | When to Prefer Self-Managed |
|-------------|--------------------|-----------------------------|
| PostgreSQL on EC2 | RDS Aurora PostgreSQL | Need specific extension, version, or OS-level tuning AWS doesn't expose |
| RabbitMQ on EC2 | Amazon SQS / MQ | Need AMQP semantics not available in SQS |
| Redis on EC2 | ElastiCache for Redis | Need a Redis version/config not yet in ElastiCache |
| Kubernetes on EC2 | EKS or ECS Fargate | Need specific K8s config or want full cluster control |
| Nginx reverse proxy | Application Load Balancer | Need WebSocket, complex routing, or request rewriting not supported by ALB |

The pattern: start managed, move to self-managed only when you hit a specific, documented gap. Not when you have a vague feeling of "more control."

### 4. Event-Driven by Default

Prefer asynchronous communication (SQS, SNS, EventBridge, Step Functions, Kinesis) over synchronous (direct Lambda invocation, API calls, RPC).

Why:
- **Retry logic is built in**: SQS retries failed messages automatically with configurable backoff. Dead-letter queues catch poison pills.
- **Natural decoupling**: The producer does not wait for or depend on the consumer. Scale independently.
- **Backpressure handled for you**: SQS buffers load spikes. Your consumers process at their own rate.
- **Observability**: Every message in SQS/EventBridge is a discrete, traceable unit.

Use synchronous calls when:
- The caller must know the result immediately to construct a response (e.g., an HTTP request that returns data to a user)
- The operation is idempotent and fast (<100ms)
- You need exactly-once semantics and SQS's at-least-once is not acceptable

Use async when:
- The caller can fire-and-forget (order confirmation email, image processing, webhook delivery)
- The operation is slow, variable, or might fail transiently
- You want to smooth out traffic spikes without scaling the downstream service proportionally

### 5. Multi-Account Strategy

A single AWS account is a single blast radius and a single bill. For anything beyond a prototype, use multiple accounts:

```
AWS Organization (root)
├── Management Account (billing root only — no workloads here)
├── Security OU
│   ├── Log Archive Account (CloudTrail, Config logs — never touch)
│   └── Audit Account (Security Hub, GuardDuty aggregation)
├── Infrastructure OU
│   └── Shared Services Account (VPN, DNS, CI/CD, container registries)
├── Workloads OU
│   ├── Dev Account
│   ├── Staging Account
│   └── Production Account
└── Sandbox OU
    └── Individual developer sandbox accounts (auto-nuked nightly)
```

Benefits:
- **Blast radius**: A production IAM mistake does not affect dev. A dev cost spike does not obscure prod costs.
- **Billing clarity**: Cost allocation by account is trivial. No tagging strategy required.
- **Security isolation**: SCPs on the root OU prevent any account from disabling CloudTrail or leaving the Organization.
- **Limit isolation**: Service quotas are per-account. A Lambda concurrency spike in dev does not throttle production.

Control Tower automates this structure with a 30-minute setup. Use it unless you have very specific requirements the account factory cannot accommodate.


## Common Patterns

### Pattern 1: Serverless Web Application

The default choice for new web applications with unknown or spiky traffic. Minimal ops burden, pay-per-use pricing, auto-scaling to zero.

```
User
 └── CloudFront (CDN, WAF, edge caching)
      ├── S3 (static assets — HTML, JS, CSS, images)
      └── API Gateway (REST or HTTP API)
           └── Lambda (business logic, per-route handlers)
                ├── DynamoDB (primary data store — single-table design)
                ├── S3 (file storage, large objects)
                └── SES / SNS (email, notifications)
```

Key decisions:
- **HTTP API vs. REST API**: HTTP API is cheaper (~70%) and lower-latency. REST API adds per-route throttling, usage plans, request/response transformation, and AWS WAF integration at the API level. Start with HTTP API; upgrade only if you need REST API features.
- **DynamoDB vs. RDS**: DynamoDB is the default for Lambda-native apps (no connection pool exhaustion). Use RDS Aurora Serverless v2 when you need relational semantics (joins, transactions, complex queries) — it scales to zero between requests.
- **Cold starts**: Lambda cold starts are 200ms-1s depending on runtime and memory. For latency-sensitive endpoints, keep functions warm (EventBridge scheduled rule + ping), use Provisioned Concurrency, or use SnapStart (Java).

When to graduate to containers: sustained traffic (Lambda concurrency costs > ECS Fargate), long-running processes, large binaries, or warm database connection pooling (RDS Proxy helps but adds cost).

### Pattern 2: Container Microservices

For teams with sustained, predictable load or services that don't fit Lambda constraints (long runtime, large binary, shared library, connection pool).

```
User
 └── Route 53 (DNS)
      └── ALB (Application Load Balancer — path-based routing, SSL termination)
           ├── ECS Service A (Fargate — API service)
           │    └── RDS Aurora (PostgreSQL — private subnet, RDS Proxy for pooling)
           ├── ECS Service B (Fargate — worker service)
           │    └── SQS Queue (decoupled task intake)
           └── ECS Service C (Fargate — background jobs)
                └── ElastiCache (Redis — sessions, rate limiting, caching)
```

Key decisions:
- **ECS Fargate vs. EKS**: Fargate is simpler and cheaper at small scale. EKS is better when you need Kubernetes-specific features (custom operators, Helm charts, K8s-native tooling) or portability across clouds.
- **RDS Proxy**: Required when many Lambda functions or short-lived ECS tasks connect to RDS. Without it, connection exhaustion causes `too many connections` errors under load.
- **Service discovery**: ECS Service Connect or App Mesh for service-to-service calls. ALB + target groups for external traffic only.
- **Blue/green deployments**: CodeDeploy + ECS handles traffic shifting automatically. Canary: 10% → 100% with health check gate.

### Pattern 3: Event-Driven Data Processing

For ETL pipelines, media processing, data ingestion, or any workflow that is too slow or complex for a single Lambda invocation.

```
Source Event (S3 upload, API call, scheduled trigger, DynamoDB stream)
 └── EventBridge (routing, filtering, scheduling)
      └── Step Functions (workflow orchestration — retry, parallel, branching)
           ├── Lambda Step A (validate / transform)
           ├── Lambda Step B (enrich / call external API)
           ├── Lambda Step C (write to destination)
           └── SQS DLQ (failed executions land here for inspection)

Outputs:
 ├── DynamoDB (structured results)
 ├── S3 (raw files, reports, exports)
 ├── Kinesis Data Firehose → S3 → Athena (analytics / data lake)
 └── SNS → SES / Slack (notifications on completion or failure)
```

Key decisions:
- **Step Functions vs. Lambda-orchestrated chains**: Step Functions externalizes workflow state, provides visual debugging, built-in retry/catch, and parallel branching. Lambda chains (Lambda A invokes Lambda B) lose state on failure and are hard to debug. Use Step Functions for any multi-step workflow.
- **Express vs. Standard workflows**: Standard = exactly-once, up to 1 year, auditable history. Express = at-least-once, up to 5 minutes, high-throughput, cheaper. Use Express for high-volume event processing; Standard for business-critical workflows.
- **Kinesis vs. SQS**: Kinesis preserves ordering within a shard and supports replay. SQS is simpler and cheaper for unordered processing. Use Kinesis when order matters or when you need multiple consumers reading the same stream.

### Pattern 4: Multi-Account Landing Zone

For organizations with 3+ engineers, production workloads, or compliance requirements. Build this before you need it, not after.

```
AWS Organizations (management account — billing root only)
 ├── Control Tower setup (30-min automated landing zone)
 │    ├── Mandatory guardrails (prevent disabling CloudTrail, etc.)
 │    └── Elective guardrails (restrict public S3 buckets, require MFA, etc.)
 ├── Account Factory (Terraform or Service Catalog template)
 │    ├── Dev account (created in minutes from template)
 │    ├── Staging account
 │    └── Production account
 ├── IAM Identity Center (SSO — one login, all accounts)
 │    ├── Permission sets (Developer, ReadOnly, Admin)
 │    └── Group mappings (GitHub teams → AWS accounts)
 └── Security baseline (auto-applied to all accounts)
      ├── CloudTrail → Log Archive account S3
      ├── Config → centralized compliance recording
      ├── GuardDuty → aggregated in Audit account
      └── Security Hub → unified findings dashboard
```

Timeline: Control Tower setup takes 30-60 minutes. Account vending from factory takes ~15 minutes per account. SSO integration with an identity provider (Okta, Azure AD) takes 1-2 hours.

The critical rule: **never run workloads in the management account.** It is the billing root. Compromising it means losing control of all accounts. Keep it empty except for Organizations and Control Tower.


## Gotchas

### 1. Multi-Region Is Almost Never the Right Answer

Going multi-region adds 2-3x infrastructure cost, requires active-active data replication (DynamoDB global tables, Aurora global database, S3 cross-region replication), doubles your operational surface, and makes every debugging session harder because you now have two of everything.

Most production applications need 99.9-99.95% availability. Multi-AZ achieves that. Multi-region is for 99.99%+ SLAs and global latency requirements. Before adding a second region, answer: "What specific failure scenario requires this, and what is the cost of that failure?"

### 2. Start With a Monolith, Extract Services With Evidence

Microservices solve organizational scaling problems and independent deployment requirements. They create distributed systems problems: network latency, partial failures, distributed tracing, eventual consistency, and service discovery. For a team of fewer than 5 engineers with a product not yet achieving product-market fit, a modular monolith on ECS Fargate or App Runner is faster to build, easier to debug, and simpler to operate. Extract services when you have: (a) a clear bounded context with different scaling needs, (b) a team large enough to own the service independently, or (c) a documented performance or reliability problem that extraction solves.

### 3. "Serverless" Still Requires Operational Maturity

Lambda eliminates patching, provisioning, and capacity planning. It does not eliminate monitoring, alerting, IAM management, cold start tuning, DLQ inspection, distributed tracing, or cost management. The ops work shifts from infrastructure ops to application ops. Before going serverless, ensure you have: CloudWatch dashboards for every function, X-Ray tracing enabled, DLQs on every async invocation, alarms on error rate and throttle count, and a cost alert on Lambda duration.

### 4. API Gateway + Lambda + DynamoDB Is Not Always the Right Stack

This trio is the default AWS serverless recommendation and it fits many use cases well. It does not fit: relational data models (use RDS), long-running operations over 15 minutes (use ECS or Step Functions), large binaries (Lambda has a 10 GB deployment size limit and 512 MB–10 GB ephemeral storage), high-throughput low-latency APIs where cold starts are unacceptable without Provisioned Concurrency (adds cost), or workloads that need a warm database connection pool (use RDS Proxy or ECS with persistent connections).

### 5. Service Quotas Will Surprise You in Production

AWS service quotas are not the same as the documented "limits." Many limits are soft and can be increased, but the increase request must be submitted before you hit the limit — not after. Common limits that bite at scale:

| Service | Common Limit |
|---------|-------------|
| Lambda concurrent executions | 1,000 per region (account-level) |
| API Gateway throttle | 10,000 req/s (regional, soft) |
| DynamoDB table count | 2,500 per region |
| EC2 instance limits | Per instance family, per region |
| SES sending rate | 1 email/second until production access granted |

Request increases proactively via Service Quotas console. Set CloudWatch alarms at 80% of quota limits.

### 6. Avoid VPCs Unless You Need Private Networking

A VPC adds NAT Gateway costs ($32.40/month minimum), subnet planning complexity, security group management, and Lambda cold start latency (slightly higher). Many serverless architectures (Lambda + DynamoDB + API Gateway) work entirely outside a VPC. Add a VPC when you need: private RDS instances, private ECS services not exposed to the internet, VPN connectivity to on-premises, or compliance requirements for network isolation. See the VPC skill for full detail.

### 7. CIDR Planning Is Permanent — Do It Upfront

VPC CIDR blocks cannot be changed after creation. They also cannot overlap between VPCs if you want to peer them or connect via Transit Gateway. A common mistake is creating multiple VPCs with `10.0.0.0/16` because it's the default — then discovering they can't be peered when you need cross-VPC connectivity.

Plan before you create:
- Production VPCs: `/16` (65,536 IPs — room for growth)
- Dev VPCs: `/20` (4,096 IPs — enough for experiments)
- Assign non-overlapping ranges: prod `10.0.0.0/16`, staging `10.1.0.0/16`, dev `10.2.0.0/16`

### 8. Avoid Chasing New AWS Services Without Understanding the Operational Cost

AWS releases 200+ new services and features per year. Most teams adopt new services without fully understanding the operational cost — monitoring, debugging, IAM permissions, pricing model, known limitations. Before adopting any service in production: read the entire pricing page, look for the service on the AWS re:Post community for known issues, check the service's SLA, and run a cost estimate for your expected load. "AWS released it, so it must be production-ready" is not a sufficient evaluation.

### 9. Design for Failure at Every Layer — Not Just the Infrastructure Layer

Every external service call can fail. Every database query can time out. Every dependency can degrade. The infrastructure being "managed" does not mean it is infallible. Design patterns to apply everywhere:

- **Timeouts**: Every SDK call should have an explicit timeout. Default timeouts are often too long.
- **Retries with exponential backoff and jitter**: AWS SDKs have this built in — ensure it is not disabled.
- **Circuit breakers**: Stop calling a failing downstream service after N failures. Give it time to recover.
- **Dead-letter queues**: Every SQS queue and async Lambda invocation should have a DLQ configured with an alarm.
- **Graceful degradation**: If a non-critical dependency fails (e.g., a recommendation service), return a degraded response — not an error.

### 10. IAM Is Architecture — Treat It That Way

IAM is not an afterthought you configure at the end. Overly permissive IAM (`*` actions, `*` resources) is the root cause of most AWS security incidents. Treat IAM as a first-class architectural concern:

- **Least privilege from day one**: Write the minimum permissions your code actually needs. Use CloudTrail + IAM Access Analyzer to identify unused permissions.
- **No long-lived credentials**: Use IAM roles everywhere — EC2 instance profiles, ECS task roles, Lambda execution roles. Never embed access keys in code or environment variables.
- **Separate roles per service**: Every Lambda function, ECS task, and EC2 instance gets its own IAM role scoped to what it needs. Shared roles mean a compromise of one service compromises all.
- **SCPs at the Org level**: Use Service Control Policies to enforce guardrails across all accounts — prevent disabling CloudTrail, prevent leaving the Organization, restrict which regions can be used.

### 11. Tagging Is Required for Cost Allocation — Start on Day One

AWS cost allocation by service, environment, and team requires tags. Tags cannot be applied retroactively to historical spend. Define your tagging strategy before creating any resources:

Minimum required tags:
- `Environment`: `production`, `staging`, `dev`
- `Team`: owning team or product
- `Project`: product or workload name
- `CostCenter`: for chargebacks

Enforce tagging via Config rules or Control Tower guardrails. Use AWS Budgets with tag-based filters to get per-project cost alerts.

### 12. Single Points of Failure Hide in "Managed" Services

Managed services have extremely high availability, but they are not immune to failure. RDS Multi-AZ provides automatic failover — but failover takes 30-120 seconds during which writes fail. ElastiCache does not have automatic failover in single-node mode. SQS and DynamoDB are designed for multi-AZ fault tolerance, but the application still needs to handle eventual consistency and retries. Document the failure modes of every managed service in your critical path, and test them with Fault Injection Simulator (FIS).


## Official Documentation

- **AWS Well-Architected Framework:** https://docs.aws.amazon.com/wellarchitected/latest/framework/
- **AWS Architecture Center** (reference architectures, whitepapers): https://aws.amazon.com/architecture/
- **AWS Serverless Land** (serverless patterns and examples): https://serverlessland.com
- **CDK Patterns** (community CDK architecture patterns): https://cdkpatterns.com
- **AWS Solutions Library** (pre-built, vetted solution architectures): https://aws.amazon.com/solutions/
- **AWS Organizations User Guide:** https://docs.aws.amazon.com/organizations/latest/userguide/
- **AWS Control Tower User Guide:** https://docs.aws.amazon.com/controltower/latest/userguide/
- **AWS Well-Architected Tool:** https://docs.aws.amazon.com/wellarchitected/latest/userguide/
- **AWS Fault Injection Simulator:** https://docs.aws.amazon.com/fis/latest/userguide/
- **AWS re:Post** (community Q&A, known issues): https://repost.aws
