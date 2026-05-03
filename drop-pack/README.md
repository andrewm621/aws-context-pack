# AWS Context Pack — Claude Code Plugin

> A Kit-tier Drop Pack from Builder's Loft

## What You Get

A Claude Code plugin that gives Claude deep AWS knowledge — automatically injected when you're working with AWS services. No prompting required.

- **31 service skills** covering Lambda, DynamoDB, S3, CDK, Bedrock, and 26 more
- **Contextual injection** — the right knowledge appears at the right time based on what files you're editing, commands you're running, or questions you're asking
- **8 deep-dive references** for complex patterns (single-table design, IAM policy patterns, CDK constructs, Lambda cold starts)
- **Root knowledge graph** with decision matrices for service selection

## How It Works

```
You work → Hook detects context → Skill injected → Claude knows AWS
```

The plugin uses Claude Code's hook system:

1. **Session Start** — Detects your project type (CDK, SAM, Serverless) and loads the AWS knowledge graph
2. **File Operations** — When you edit `serverless.yml`, read a Lambda handler, or write CDK stacks, relevant skills auto-inject
3. **Commands** — Running `cdk deploy`, `aws lambda`, or `sam build` triggers matching skills
4. **Questions** — Asking about DynamoDB, IAM policies, or cost optimization surfaces the right guidance

## Installation

### From GitHub (recommended)

```bash
claude plugin add github:andrewm621/aws-context-pack
```

### Manual

```bash
git clone https://github.com/andrewm621/aws-context-pack.git
cd aws-context-pack
./install.sh
claude plugin add ./
```

## What's Included

### Tier 1 — Core Services (Priority 6-8)

| Skill | Triggers |
|-------|----------|
| Lambda | `*.handler.js`, `serverless.yml`, `lambda invoke` |
| DynamoDB | `dynamodb`, `aws-sdk DynamoDB`, single-table questions |
| S3 | `s3://`, `PutObject`, bucket policy files |
| API Gateway | `apigateway`, REST/HTTP API definitions |
| IAM | `*.policy.json`, `iam:`, permission questions |
| CloudFormation | `template.yaml`, `*.cfn.json`, stack operations |
| CDK | `cdk.json`, `Stack`, `Construct` imports |
| VPC | `vpc`, subnet, security group configurations |
| ECS/Fargate | `ecs`, `Dockerfile`, container task definitions |
| RDS | `rds`, database connection strings, migration files |
| SQS/SNS | `sqs`, `sns`, queue/topic ARNs |
| CloudWatch | `logs`, `metrics`, alarm definitions |

### Tier 2 — Extended Services (Priority 5-6)

| Skill | Triggers |
|-------|----------|
| Bedrock | `bedrock`, `InvokeModel`, AI/ML questions |
| Cognito | `cognito`, `UserPool`, auth flow files |
| EventBridge | `eventbridge`, `EventBus`, rule definitions |
| Step Functions | `states`, `StateMachine`, workflow files |
| ElastiCache | `elasticache`, `redis`, cache patterns |
| Secrets Manager | `secretsmanager`, `GetSecretValue` |
| Parameter Store | `ssm`, `GetParameter`, config questions |
| Kinesis | `kinesis`, `KinesisStream`, streaming files |
| AppSync | `*.graphql`, AppSync resolver files |
| Route 53 | `route53`, DNS, hosted zone configurations |

### Tier 3 — Specialized (Priority 4)

| Skill | Triggers |
|-------|----------|
| WAF | `wafv2`, web ACL definitions |
| CloudFront | `cloudfront`, distribution configurations |
| Glue | `glue`, ETL job scripts |
| Athena | `athena`, query files against S3 |
| SageMaker | `sagemaker`, ML pipeline definitions |
| ECR | `ecr`, container registry operations |
| CodePipeline | `codepipeline`, CI/CD definitions |
| Lambda@Edge | edge function files, CloudFront + Lambda patterns |
| Transit Gateway | network topology, multi-VPC questions |

### Deep-Dive References

| Reference | What It Covers |
|-----------|---------------|
| `single-table-design.md` | DynamoDB access pattern modeling, GSI strategy, entity relationships |
| `iam-policy-patterns.md` | Least-privilege templates, condition keys, resource-based vs. identity-based |
| `cdk-constructs.md` | L1/L2/L3 constructs, custom construct patterns, escape hatches |
| `lambda-cold-starts.md` | Provisioned concurrency, init code optimization, runtime comparison |
| `vpc-networking.md` | Subnet design, NAT strategies, VPC endpoints, peering vs. TGW |
| `cost-optimization.md` | Per-service cost levers, Savings Plans, rightsizing patterns |
| `serverless-patterns.md` | Event-driven architecture, fan-out, saga pattern, idempotency |
| `cdk-testing.md` | Fine-grained assertions, snapshot tests, integration test patterns |

## Customization

- **Add your own skills:** Create `skills/your-service/SKILL.md` following the 6-section template
- **Adjust priorities:** Edit the `priority` field in any skill's frontmatter
- **Add patterns:** Extend `pathPatterns`, `bashPatterns`, or `promptSignals` in any skill to match your project's file conventions

## Building Your Own Context Pack

This kit includes `CONTEXT-PACK-FRAMEWORK.md` — a complete guide for building context packs for any platform (HubSpot, Stripe, Shopify, etc.). It covers the hook architecture, the 6-section skill template, trigger pattern design, and how to tier skills by priority.

## Requirements

- Claude Code (any plan)
- Node.js 18+

## Support

Questions? Post in the Builder's Loft community or open an issue on GitHub.
