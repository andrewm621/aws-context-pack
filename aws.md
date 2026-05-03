# AWS Context Pack — Service Knowledge Graph

> This document is the master reference for understanding the AWS ecosystem.
> It maps every major service — how they relate, when to use each,
> and which skills provide deeper guidance.

---

## Legend

- **[SERVICE]** — An AWS service
- **-> depends on** — Runtime or build-time dependency
- **<-> integrates with** — Bidirectional integration
- **=> alternative to** — Can substitute for
- **=> contains** — Parent/child relationship
- **=> skill:** — Link to a skill for detailed guidance

---

## 1. Compute

```
AWS COMPUTE
├── Lambda (serverless functions)                      => skill: lambda
│   => Event-driven, pay-per-invocation
│   => Runtimes: Node.js 22, Python 3.13, Java 21, .NET 8, Go, Ruby, custom
│   => Max 15 min execution, 10GB memory, 10GB /tmp
│   => ARM64 (Graviton) 20% cheaper, often faster
│   -> API Gateway (HTTP trigger)
│   -> EventBridge (scheduled trigger)
│   -> S3 / DynamoDB Streams / SQS / SNS (event sources)
│   -> CloudWatch Logs (automatic logging)
│   -> IAM (execution role)
│   <-> Step Functions (orchestration)
│
├── ECS + Fargate (containers, serverless)             => skill: ecs-fargate
│   => Long-running services, microservices
│   => Fargate: no EC2 management
│   => ECS on EC2: more control, GPU, cost optimization
│   -> VPC (networking)
│   -> ALB/NLB (load balancing)
│   -> ECR (container registry)
│   -> IAM (task role, execution role)
│   <-> CloudWatch (metrics, logs)
│   => alternative to: Lambda (for long-running), EKS (simpler than K8s)
│
├── EC2 (virtual machines)                             => skill: ec2
│   => Full control, any workload, GPU/HPC
│   => Instance families: general (M), compute (C), memory (R), storage (I), GPU (P/G)
│   => Pricing: On-Demand, Spot (up to 90% off), Reserved, Savings Plans
│   -> VPC (networking required)
│   -> EBS (block storage)
│   -> IAM (instance profile)
│
├── App Runner (fully managed containers)              => skill: app-runner
│   => Simplest container deployment
│   => Auto-scaling, HTTPS, no VPC required
│   => alternative to: Fargate (simpler), Vercel (AWS-native)
│
└── Elastic Beanstalk (PaaS, legacy)
    => Managed EC2 + ALB + Auto Scaling
    => Prefer App Runner or ECS for new projects
```

---

## 2. Storage

```
AWS STORAGE
├── S3 (object storage)                                => skill: s3
│   => Unlimited storage, 5TB max object
│   => Storage classes: Standard, IA, Glacier (3 tiers), Intelligent-Tiering
│   => Strong read-after-write consistency
│   -> CloudFront (CDN origin)
│   -> Lambda (event-driven processing)
│   -> IAM / Bucket Policies (access control)
│   <-> EventBridge (event notifications)
│
├── EBS (block storage for EC2)                        => skill: ebs-efs
│   => SSD (gp3, io2) and HDD (st1, sc1)
│   => gp3: 3000 IOPS baseline, $0.08/GB
│   -> EC2 (attached storage)
│   => Snapshots stored in S3 (incremental)
│
├── EFS (managed NFS)                                  => skill: ebs-efs
│   => Shared filesystem across AZs
│   => Elastic, pay-per-use
│   -> Lambda (mounted as /mnt)
│   -> ECS/EC2 (NFS mount)
│
└── S3 Glacier (archival storage)
    => Part of S3 storage classes
    => Deep Archive: $0.00099/GB (cheapest storage in cloud)
```

---

## 3. Databases

```
AWS DATABASES
├── DynamoDB (NoSQL, key-value + document)              => skill: dynamodb
│   => Single-digit ms latency at any scale
│   => On-demand or provisioned capacity
│   => Global Tables (multi-region)
│   => Streams for CDC (change data capture)
│   -> Lambda (stream processor)
│   -> DAX (in-memory cache)
│   -> IAM (fine-grained access)
│   => Use when: high scale, known access patterns, key-value lookups
│
├── RDS + Aurora (relational)                          => skill: rds-aurora
│   => RDS: MySQL, PostgreSQL, MariaDB, Oracle, SQL Server
│   => Aurora: MySQL/PostgreSQL compatible, 5x throughput
│   => Aurora Serverless v2: auto-scaling, pay-per-ACU
│   -> VPC (private subnets)
│   -> Secrets Manager (credentials)
│   => Use when: complex queries, joins, ACID transactions
│
├── ElastiCache (Redis/Memcached)                      => skill: elasticache
│   => Sub-ms latency caching
│   => ElastiCache Serverless (auto-scaling)
│   -> VPC (required)
│   => Use when: session store, leaderboards, real-time analytics
│
├── DocumentDB (MongoDB-compatible)
│   => MongoDB wire protocol compatible
│   => Managed, auto-scaling storage
│
├── Neptune (graph database)
│   => Gremlin and SPARQL
│   => Use when: social networks, knowledge graphs, fraud detection
│
├── Timestream (time-series)
│   => IoT, DevOps metrics
│   => Auto-tiered storage (memory -> magnetic)
│
└── Keyspaces (Cassandra-compatible)
    => Wide-column NoSQL
    => Use when: migrating from Cassandra
```

### Database Decision Matrix

| Need | Use | Why |
|------|-----|-----|
| Key-value lookups at scale | DynamoDB | Single-digit ms, serverless |
| Complex SQL queries, joins | Aurora PostgreSQL | Best managed relational |
| Document store (MongoDB API) | DocumentDB | Wire-compatible, managed |
| Caching layer | ElastiCache Redis | Sub-ms, pub/sub |
| Time-series data | Timestream | Auto-tiered, SQL-like |
| Graph relationships | Neptune | Gremlin/SPARQL |
| Unknown/variable workload | Aurora Serverless v2 | Auto-scales to zero |

---

## 4. Networking

```
AWS NETWORKING
├── VPC (Virtual Private Cloud)                        => skill: vpc
│   => Foundation for all private networking
│   => Subnets (public, private, isolated)
│   => Route tables, NACLs, Security Groups
│   => NAT Gateway ($0.045/hr + $0.045/GB — #1 surprise cost)
│   => VPC Endpoints (avoid NAT for AWS services)
│   => VPC Peering, Transit Gateway
│
├── CloudFront (CDN)                                   => skill: cloudfront
│   => 400+ edge locations globally
│   => Origins: S3, ALB, API Gateway, custom
│   => CloudFront Functions (viewer request/response)
│   => Lambda@Edge (origin request/response)
│   -> S3 (origin)
│   -> WAF (web application firewall)
│   -> ACM (SSL certificates, free)
│
├── API Gateway                                        => skill: api-gateway
│   => REST API (full features, $3.50/million)
│   => HTTP API (simpler, $1.00/million, 70% cheaper)
│   => WebSocket API (real-time)
│   -> Lambda (integration)
│   -> Cognito (authorization)
│   -> WAF (protection)
│   => alternative to: ALB (for non-Lambda backends)
│
├── Route 53 (DNS)                                     => skill: route53
│   => Hosted zones ($0.50/month)
│   => Health checks + failover
│   => Routing policies: simple, weighted, latency, geolocation, failover
│
├── ALB / NLB (load balancing)                         => skill: alb-nlb
│   => ALB: HTTP/HTTPS, path-based routing, WebSocket
│   => NLB: TCP/UDP, ultra-low latency, static IPs
│   -> ECS / EC2 (targets)
│   -> ACM (SSL termination)
│
└── Transit Gateway
    => Hub-and-spoke for VPC connectivity
    => Use when: 3+ VPCs or hybrid cloud
```

### API Entry Point Decision Matrix

| Need | Use | Why |
|------|-----|-----|
| Lambda HTTP API (most cases) | API Gateway HTTP API | Cheapest, simplest |
| Lambda with auth, throttling, caching | API Gateway REST API | Full feature set |
| WebSocket real-time | API Gateway WebSocket | Managed connections |
| Container/EC2 HTTP | ALB | Native integration |
| gRPC or TCP | NLB | L4 load balancing |

---

## 5. Security & Identity

```
AWS SECURITY
├── IAM (Identity and Access Management)               => skill: iam
│   => Users, groups, roles, policies
│   => Policy evaluation: explicit deny > allow > implicit deny
│   => Permission boundaries, SCPs
│   => IAM Identity Center (SSO for humans)
│   => NO COST for IAM itself
│
├── Cognito (user authentication)                      => skill: cognito
│   => User Pools (auth + user directory)
│   => Identity Pools (federated, temporary AWS creds)
│   => Social login (Google, Facebook, Apple, SAML)
│   -> API Gateway (authorizer)
│   -> ALB (OIDC integration)
│
├── Secrets Manager + KMS                              => skill: secrets-kms
│   => Secrets Manager: rotate credentials automatically
│   => KMS: encryption key management
│   => SSM Parameter Store: simpler, cheaper (free tier)
│   -> RDS (automatic rotation)
│   -> Lambda (rotation function)
│
├── WAF + Shield                                       => skill: waf-shield
│   => WAF: web application firewall (rules, rate limiting)
│   => Shield Standard: free DDoS protection
│   => Shield Advanced: $3,000/month, DDoS cost protection
│   -> CloudFront, ALB, API Gateway
│
├── GuardDuty (threat detection)
│   => ML-based anomaly detection
│   => Analyzes VPC Flow Logs, DNS logs, CloudTrail
│
├── Security Hub (posture management)
│   => Aggregates findings from GuardDuty, Inspector, etc.
│   => CIS, PCI-DSS, AWS best practice benchmarks
│
└── ACM (Certificate Manager)
    => Free SSL/TLS certificates
    => Auto-renewal
    -> CloudFront, ALB, API Gateway
```

---

## 6. AI/ML

```
AWS AI/ML
├── Bedrock (managed foundation models)                => skill: bedrock
│   => Claude, Llama, Titan, Mistral, Stable Diffusion
│   => Pay-per-token, no infrastructure
│   => Knowledge Bases (RAG with S3 + vector store)
│   => Agents (tool calling, orchestration)
│   => Guardrails (content filtering)
│   => Model evaluation
│   -> S3 (knowledge base source)
│   -> OpenSearch Serverless (vector store)
│   -> Lambda (agent action groups)
│
├── SageMaker (full ML platform)                       => skill: sagemaker
│   => Training, tuning, deployment
│   => JumpStart (pre-trained models)
│   => Studio (IDE)
│   => Real-time + batch + async inference
│   => Use when: custom models, fine-tuning, ML pipelines
│
└── AI Services (pre-built)
    => Rekognition (image/video analysis)
    => Comprehend (NLP)
    => Textract (document extraction)
    => Polly (text-to-speech)
    => Transcribe (speech-to-text)
    => Translate
```

---

## 7. Messaging & Orchestration

```
AWS MESSAGING
├── SQS + SNS                                          => skill: sqs-sns
│   => SQS: message queue (standard or FIFO)
│   => SNS: pub/sub topics (fan-out)
│   => SQS Standard: unlimited throughput, at-least-once
│   => SQS FIFO: 3,000 msg/s with batching, exactly-once
│   -> Lambda (event source mapping)
│   => Pattern: SNS fan-out to multiple SQS queues
│
├── EventBridge                                        => skill: eventbridge
│   => Event bus for event-driven architectures
│   => Rules + patterns for filtering
│   => Scheduler (cron + one-time)
│   => Pipes (source -> transform -> target)
│   => Schema registry
│   -> Lambda, SQS, Step Functions (targets)
│   => alternative to: SNS (richer filtering, more targets)
│
├── Step Functions                                     => skill: step-functions
│   => Visual workflow orchestration
│   => Standard (long-running, $25/million transitions)
│   => Express (high-volume, $1/million, 5 min max)
│   => ASL (Amazon States Language) or CDK
│   -> Lambda (task execution)
│   -> DynamoDB, SQS, SNS, ECS (direct integrations)
│   => Use when: multi-step workflows, human approval, error handling
│
└── Kinesis (real-time streaming)
    => Data Streams: real-time, ordered, replay
    => Firehose: delivery to S3/Redshift/OpenSearch
    => Use when: real-time analytics, log aggregation, IoT
```

### Messaging Decision Matrix

| Need | Use | Why |
|------|-----|-----|
| Decouple services, buffering | SQS Standard | Simplest, unlimited throughput |
| Ordered, exactly-once processing | SQS FIFO | Guaranteed ordering |
| Fan-out to multiple consumers | SNS + SQS | Pub/sub pattern |
| Event-driven with rich filtering | EventBridge | Pattern matching, schema |
| Multi-step workflow | Step Functions | Visual, error handling |
| Real-time streaming | Kinesis Data Streams | Ordered, replay |
| Log/event delivery to S3 | Kinesis Firehose | Managed delivery |

---

## 8. Observability

```
AWS OBSERVABILITY
├── CloudWatch                                         => skill: cloudwatch
│   => Metrics (built-in + custom)
│   => Logs (structured, insights queries)
│   => Alarms (threshold + anomaly detection)
│   => Dashboards
│   => Contributor Insights
│   => COST WARNING: Logs ingestion $0.50/GB, storage $0.03/GB
│
├── X-Ray + CloudTrail                                 => skill: xray-cloudtrail
│   => X-Ray: distributed tracing
│   => CloudTrail: API audit trail (who did what, when)
│   => CloudTrail Insights: anomaly detection
│
└── AWS Distro for OpenTelemetry (ADOT)
    => OTel-compatible collection
    => Sends to CloudWatch, X-Ray, third-party
```

---

## 9. CI/CD & Infrastructure as Code

```
AWS CI/CD & IaC
├── CDK (Cloud Development Kit)                        => skill: cdk
│   => TypeScript, Python, Java, C#, Go
│   => L1 (CloudFormation), L2 (opinionated), L3 (patterns)
│   => `cdk synth` -> CloudFormation template
│   => `cdk deploy` -> CloudFormation stack
│   => `cdk diff` -> preview changes
│   -> CloudFormation (underlying engine)
│   => alternative to: Terraform, SAM, Serverless Framework
│
├── CloudFormation                                     => skill: cloudformation
│   => Declarative YAML/JSON templates
│   => Stack-based resource management
│   => Drift detection, change sets
│   => StackSets (multi-account/region)
│   => Foundation for CDK, SAM, Amplify
│
├── SAM (Serverless Application Model)
│   => CloudFormation extension for serverless
│   => `sam local` for local testing
│   => `sam build && sam deploy`
│   => Best for pure-serverless projects
│
├── CodePipeline + CodeBuild + CodeDeploy              => skill: codepipeline
│   => CodePipeline: CI/CD orchestration
│   => CodeBuild: managed build environment
│   => CodeDeploy: deployment strategies (rolling, blue/green, canary)
│   => CodeCommit: (deprecated, use GitHub/GitLab)
│
└── Terraform (third-party)
    => HCL, state management, multi-cloud
    => Larger community, more providers
    => alternative to: CDK (different philosophy)
```

### IaC Decision Matrix

| Need | Use | Why |
|------|-----|-----|
| TypeScript/Python-first, AWS-only | CDK | Full programming language, L2/L3 constructs |
| Declarative YAML, AWS-only | CloudFormation | Direct, no transpilation |
| Serverless-focused, local testing | SAM | CLI tools, sam local |
| Multi-cloud, large team | Terraform | Mature, multi-provider |
| Quick serverless deploy | Serverless Framework | Simple config, plugins |

---

## 10. Cost Optimization

```
AWS COST                                               => skill: cost-optimization
├── Pricing Models
│   => On-Demand (pay as you go, no commitment)
│   => Savings Plans (1-3 year, up to 72% off compute)
│   => Reserved Instances (1-3 year, specific instance type)
│   => Spot Instances (up to 90% off, can be interrupted)
│
├── Cost Tools
│   => Cost Explorer (visualization, forecasting)
│   => Budgets + Alerts (proactive notifications)
│   => Cost Anomaly Detection (ML-based)
│   => Trusted Advisor (optimization recommendations)
│   => Compute Optimizer (right-sizing)
│
├── Top Cost Surprises
│   1. NAT Gateway ($0.045/hr + $0.045/GB processed)
│   2. CloudWatch Logs ingestion ($0.50/GB)
│   3. S3 LIST/PUT requests at scale
│   4. Data transfer between AZs ($0.01/GB each way)
│   5. Idle Elastic IPs ($0.005/hr)
│   6. EBS snapshots accumulating ($0.05/GB-month)
│   7. Provisioned IOPS (io2) if gp3 suffices
│   8. Unused Elastic Load Balancers ($0.0225/hr minimum)
│   9. CloudFront invalidations (first 1000 free, then $0.005 each)
│   10. KMS API calls at scale ($0.03/10,000 requests)
│
└── Optimization Strategies
    => Right-size instances (Compute Optimizer)
    => Use Graviton (ARM64) — 20% cheaper, often faster
    => VPC Endpoints instead of NAT Gateway for AWS services
    => S3 Intelligent-Tiering for unknown access patterns
    => Spot instances for fault-tolerant workloads
    => Reserved capacity for steady-state (RDS, ElastiCache)
    => Lambda ARM64 + right-size memory
    => Delete unused resources (Trusted Advisor)
```

---

## 11. Architecture Patterns                           => skill: aws-architecture

### Serverless Web App
```
CloudFront -> S3 (static assets)
           -> API Gateway -> Lambda -> DynamoDB
                                    -> S3 (uploads)
           -> Cognito (auth)
```

### Microservices
```
Route 53 -> ALB -> ECS Fargate (services)
                -> Aurora Serverless (shared DB)
                -> ElastiCache (caching)
                -> SQS (async communication)
```

### Event-Driven Processing
```
S3 (upload) -> EventBridge -> Step Functions -> Lambda (process)
                                            -> Lambda (notify)
                                            -> DynamoDB (store)
```

### AI/ML Application
```
API Gateway -> Lambda -> Bedrock (inference)
                      -> S3 (RAG documents)
                      -> DynamoDB (session state)
                      -> Bedrock Knowledge Base (retrieval)
```

### Multi-Account Strategy
```
Management Account (billing, SCPs)
├── Security Account (GuardDuty, Security Hub, CloudTrail)
├── Shared Services (DNS, CI/CD, artifact repos)
├── Dev Account
├── Staging Account
└── Production Account
```

---

## 12. Cross-Cutting Decisions

### Compute Decision Matrix

| Need | Use | Why |
|------|-----|-----|
| Event-driven, short tasks (<15 min) | Lambda | Zero management, pay-per-use |
| Long-running HTTP services | ECS Fargate | Containers, auto-scaling |
| GPU, HPC, custom OS | EC2 | Full control |
| Simple container deployment | App Runner | Fastest path |
| Batch processing | Lambda (small) or ECS (large) | Depends on duration/size |
| WebSocket connections | API Gateway WebSocket + Lambda | Or ALB + Fargate |

### When to Use Serverless vs Containers vs VMs

| Factor | Lambda | Fargate | EC2 |
|--------|--------|---------|-----|
| Cold start tolerance | Must accept (~200ms-2s) | None (always running) | None |
| Execution time | Max 15 min | Unlimited | Unlimited |
| Memory | Up to 10 GB | Up to 120 GB | Instance-dependent |
| Cost at low traffic | Cheapest (pay per invoke) | Higher (min task running) | Highest (always on) |
| Cost at high traffic | Can be expensive | Moderate | Cheapest (reserved) |
| Operational complexity | Lowest | Medium | Highest |

### SDK Version Guidance

**Always use AWS SDK v3** (`@aws-sdk/client-*`). SDK v2 (`aws-sdk`) entered maintenance mode in 2024 and reaches end-of-support in 2025.

| SDK v2 | SDK v3 |
|--------|--------|
| `const AWS = require('aws-sdk')` | `import { S3Client } from '@aws-sdk/client-s3'` |
| `new AWS.S3()` | `new S3Client({ region })` |
| `s3.getObject(params).promise()` | `await s3.send(new GetObjectCommand(params))` |
| Bundles all services (>80MB) | Tree-shakeable, import only what you need |

---

## 13. Common Anti-Patterns

1. **Using root account for anything** — Create IAM users/roles, enable MFA on root
2. **Long-lived access keys** — Use IAM roles with temporary credentials
3. **Public S3 buckets** — Enable Block Public Access at account level
4. **No VPC endpoints** — NAT Gateway charges for S3/DynamoDB traffic are wasteful
5. **Over-provisioning** — Start small, monitor, right-size with Compute Optimizer
6. **Ignoring multi-AZ** — Single-AZ deployments are not production-ready
7. **No backup strategy** — Enable automated backups for RDS, DynamoDB PITR
8. **CloudWatch Logs without retention** — Set retention policy or costs grow forever
9. **Hardcoded credentials** — Use Secrets Manager or SSM Parameter Store
10. **Monolithic Lambda functions** — Keep functions focused, <50MB deployment package
