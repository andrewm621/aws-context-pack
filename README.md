# AWS Context Pack

A Claude Code plugin that provides AI-consumable knowledge about AWS services. When you're working with AWS files, commands, or discussing AWS topics, relevant service guidance is automatically injected into your conversation.

## Installation

```bash
claude plugin add /path/to/aws-context-pack
```

Or from GitHub (once published):
```bash
claude plugin add github:andrewtmiller/aws-context-pack
```

## How It Works

The plugin uses Claude Code's hook system to automatically inject relevant AWS knowledge:

1. **Session Start** — Injects the AWS service knowledge graph (`aws.md`) with decision matrices and architecture patterns. Detects AWS project markers (CDK, SAM, SDK imports) to prioritize relevant skills.

2. **File Operations** — When you read, edit, or write files matching AWS patterns (e.g., `serverless.yml`, `cdk.json`, Lambda handler files), the relevant service skill is injected.

3. **Bash Commands** — When you run AWS CLI commands, CDK commands, or SAM commands, matching skills are injected.

4. **Prompt Matching** — When you ask about AWS topics, relevant skills are injected based on keyword matching.

## Skills

31 skills covering the AWS services a full-stack builder actually touches:

### Tier 1 — Core (Priority 6-8)
| Skill | Service | Key Topics |
|-------|---------|------------|
| `lambda` | AWS Lambda | Runtimes, cold starts, layers, invocation types |
| `s3` | Amazon S3 | Storage classes, access patterns, event notifications |
| `dynamodb` | Amazon DynamoDB | Single-table design, GSI patterns, capacity modes |
| `iam` | AWS IAM | Policy patterns, cross-account, least privilege |
| `api-gateway` | API Gateway | REST vs HTTP vs WebSocket, authorization |
| `vpc` | Amazon VPC | Subnet design, NAT Gateway costs, endpoints |
| `cdk` | AWS CDK | Construct patterns, deployment, testing |
| `bedrock` | Amazon Bedrock | Model catalog, agents, knowledge bases |
| `cloudwatch` | CloudWatch | Metrics, logs, alarms, Logs Insights, EMF |
| `sqs-sns` | SQS & SNS | Message queues, pub/sub, fan-out, DLQs |
| `cost-optimization` | Cost Management | Pricing models, right-sizing, cost traps |
| `aws-architecture` | Well-Architected | Patterns, multi-account, service selection |

### Tier 2 — Extended (Priority 5-6)
| Skill | Service | Key Topics |
|-------|---------|------------|
| `ecs-fargate` | ECS + Fargate | Task definitions, services, auto-scaling |
| `rds-aurora` | RDS & Aurora | Connection pooling, replicas, Serverless v2 |
| `step-functions` | Step Functions | State machines, Express vs Standard, sagas |
| `eventbridge` | EventBridge | Event bus, scheduler, pipes, patterns |
| `cloudfront` | CloudFront | CDN, caching, edge functions, signed URLs |
| `cognito` | Cognito | User pools, identity pools, JWT, MFA |
| `secrets-kms` | Secrets + KMS | Rotation, envelope encryption, key policies |
| `route53` | Route 53 | DNS, routing policies, health checks |
| `cloudformation` | CloudFormation | Templates, stacks, change sets, drift |
| `codepipeline` | CI/CD Suite | CodePipeline, CodeBuild, CodeDeploy, OIDC |

### Tier 3 — Specialized (Priority 4)
| Skill | Service | Key Topics |
|-------|---------|------------|
| `ec2` | EC2 | Instance types, AMIs, ASGs, Spot, IMDSv2 |
| `app-runner` | App Runner | Managed containers, auto-deploy, VPC connectors |
| `ebs-efs` | EBS & EFS | Volume types, shared file systems, snapshots |
| `elasticache` | ElastiCache | Redis/Memcached, caching patterns, serverless |
| `alb-nlb` | Load Balancing | ALB vs NLB, target groups, SSL termination |
| `sagemaker` | SageMaker | Training, endpoints, pipelines, Feature Store |
| `xray-cloudtrail` | X-Ray & CloudTrail | Distributed tracing, audit logging |
| `waf-shield` | WAF & Shield | Firewall rules, DDoS, rate limiting |
| `aws-security-posture` | Security Suite | Security Hub, GuardDuty, Config, Inspector |

### Deep-Dive References

Complex skills include `references/` subdirectories with extended guidance:

| Skill | References |
|-------|-----------|
| `lambda` | `cold-start-optimization.md`, `layers-and-extensions.md` |
| `dynamodb` | `single-table-design.md`, `gsi-patterns.md` |
| `iam` | `policy-patterns.md`, `cross-account.md` |
| `cdk` | `construct-patterns.md`, `deployment-patterns.md` |

## Skill Format

Each skill follows a 6-section structure:

1. **What It Is & When to Use It** — 2-3 sentence orientation
2. **Service Surface** — SKUs, limits, pricing (table format)
3. **Mental Model** — 3-5 conceptual primitives
4. **Common Patterns** — Recipes with code examples
5. **Gotchas** — Real billing traps, undocumented behaviors, common mistakes
6. **Official Documentation** — Authoritative links only

## Development

```bash
# Generate skill manifest (speeds up hook execution)
node scripts/build-manifest.mjs

# Validate all skills
node scripts/validate.mjs

# Generate skill catalog
node scripts/generate-catalog.mjs
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `AWS_PLUGIN_HOOK_DEDUP` | (enabled) | Set to `off` to re-inject skills |
| `AWS_PLUGIN_LIKELY_SKILLS` | (auto-detected) | Comma-separated skill list for priority boosting |

## License

Apache-2.0
