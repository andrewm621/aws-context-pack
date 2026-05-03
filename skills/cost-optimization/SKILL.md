---
name: cost-optimization
description: AWS cost optimization guidance — pricing models, Reserved Instances, Savings Plans, right-sizing, cost allocation, budgets, cost anomaly detection. Use when optimizing AWS spending or planning costs.
metadata:
  priority: 6
  docs:
    - "https://docs.aws.amazon.com/cost-management/latest/userguide/"
  pathPatterns:
    - 'cost/**'
    - 'billing/**'
    - 'budgets/**'
  bashPatterns:
    - '\baws\s+ce\b'
    - '\baws\s+budgets\b'
    - '\baws\s+pricing\b'
    - '\baws\s+cost-optimization-hub\b'
  importPatterns:
    - "@aws-sdk/client-cost-explorer"
    - "@aws-sdk/client-budgets"
  promptSignals:
    phrases:
      - "aws cost"
      - "aws bill"
      - "aws pricing"
      - "reserved instance"
      - "savings plan"
      - "cost optimization"
      - "right-sizing"
      - "cost allocation"
      - "aws budget"
      - "cost anomaly"
      - "aws spending"
      - "cost explorer"
---

## What It Is & When to Use It

AWS cost optimization is a continuous practice, not a one-time event. Your bill is a lagging indicator — by the time you see the spike, the spending has already happened. The goal is to build cost awareness into architecture decisions from day one rather than treating it as a cleanup exercise at month end.

AWS provides a layered toolset for visibility, alerting, and action:

- **Visibility:** Cost Explorer shows historical spend by service, account, tag, and usage type. Use it to identify your top 5 cost drivers before making any optimization decisions.
- **Alerting:** Budgets and Cost Anomaly Detection catch spending before it compounds. Budgets trigger at thresholds; Anomaly Detection uses ML to catch unusual patterns even when you are still under budget.
- **Action:** Cost Optimization Hub aggregates recommendations from Compute Optimizer, Trusted Advisor, and other services into a single prioritized list with estimated savings.

**When to use this skill:**

- Designing a new service or architecture and want to model cost before you build
- Reviewing an AWS bill and trying to find what is driving the cost
- Planning a Reserved Instance or Savings Plan purchase
- Setting up cost governance (tagging, budgets, alerts) for a new account or team
- Investigating a cost anomaly or unexpected spike
- Evaluating whether serverless vs. EC2 vs. containers is the right compute choice for your workload

Cost optimization intersects with every other AWS service. The mental models and gotchas here apply regardless of which service you are using.

---

## Service Surface

### AWS Cost Management Tools

| Service | What It Does | Key CLI Command |
|---|---|---|
| **Cost Explorer** | Historical and forecasted spend by service, account, tag, region, usage type. 13 months of data. Granularity: monthly, daily, hourly (hourly costs extra). | `aws ce get-cost-and-usage` |
| **AWS Budgets** | Alert when actual or forecasted spend crosses a threshold. Supports cost budgets, usage budgets, RI utilization/coverage, Savings Plan budgets. Up to 62 budget actions. | `aws budgets create-budget` |
| **Cost Anomaly Detection** | ML-based detection of unusual spending patterns. Works across services, accounts, and cost categories. Alerts via SNS or email. | `aws ce create-anomaly-monitor` |
| **Cost Optimization Hub** | Aggregated recommendations from Compute Optimizer, Trusted Advisor, RDS recommendations, and ECS recommendations. Filters by resource, region, and estimated savings. | `aws cost-optimization-hub list-recommendations` |
| **Billing Conductor** | Pro-rated billing for multi-account orgs — create custom pricing rules, group accounts, generate custom bills. Primarily for MSPs and organizations doing internal chargebacks. | `aws billingconductor` |
| **AWS Pricing API** | Programmatic access to AWS price lists. Useful for cost modeling in code or CI/CD pipelines. | `aws pricing get-products` |
| **Savings Plans** | Commitment-based discounts in exchange for consistent usage. More flexible than Reserved Instances. | `aws savingsplans describe-savings-plans` |
| **Compute Optimizer** | Right-sizing recommendations for EC2, Lambda, ECS on Fargate, EBS, and Auto Scaling groups. Uses CloudWatch metrics. | `aws compute-optimizer get-ec2-instance-recommendations` |

### Pricing Model Comparison

| Model | Discount vs. On-Demand | Commitment | Flexibility | Best For |
|---|---|---|---|---|
| **On-Demand** | None (baseline) | None | Full — start/stop anytime | Unpredictable workloads, new services, short-term |
| **Spot Instances** | Up to 90% | None — can be interrupted with 2-min notice | Low — must tolerate interruption | Batch jobs, ML training, stateless workers, CI/CD |
| **Reserved Instances (1yr, No Upfront)** | ~30-40% | 1 year, pay monthly | Instance family locked, region/AZ flexible with convertible | Steady-state EC2, RDS, ElastiCache, Redshift |
| **Reserved Instances (3yr, All Upfront)** | ~60-72% | 3 years, pay upfront | Same as above | High-confidence long-running workloads |
| **Compute Savings Plans** | Up to 66% | 1 or 3 year $/hr commitment | Highest — applies across EC2, Fargate, Lambda automatically | Most orgs — covers compute broadly |
| **EC2 Instance Savings Plans** | Up to 72% | 1 or 3 year, instance family + region locked | Lower — locked to family/region | Known stable EC2 workload in specific family |
| **SageMaker Savings Plans** | Up to 64% | 1 or 3 year | SageMaker only | Consistent ML training/inference workloads |

**RI vs. Savings Plans decision rule:** Default to Compute Savings Plans unless you need the extra 6% discount from EC2 Instance Savings Plans AND you are highly confident the instance family and region will not change. Savings Plans are forgiving; RIs can become stranded when you refactor.

---

## Mental Model

### Lever 1: The Three Levers — Right-Size, Commit, Architect

Every AWS cost optimization action fits into one of three categories:

**Right-size (use less):** Match resource capacity to actual demand. Oversized EC2 instances, over-provisioned Lambda memory, RDS instances with 5% CPU utilization — these are waste you can eliminate without any architectural change. Compute Optimizer automates this analysis.

**Commit (trade flexibility for discount):** Reserved Instances and Savings Plans let you pay less per unit in exchange for a usage commitment. The mathematics are simple: any workload running more than ~50% of the time is cheaper with a commitment than On-Demand. The risk is committing to capacity you later decommission.

**Architect (structural changes):** Move workloads to inherently cheaper patterns. Serverless eliminates idle compute. Spot replaces On-Demand for fault-tolerant jobs. S3 Intelligent-Tiering replaces Standard for infrequently accessed data. These changes require more effort but often produce the largest savings.

Apply them in this order: right-size first (immediate, no risk), then commit (lock in discount on the right-sized footprint), then architect (plan for the next iteration).

### Lever 2: Cost Allocation Tags — The Only Way to Know What is Costing You Money

AWS bills you by account and service, not by application, team, or feature. Without cost allocation tags, a $10,000 bill tells you EC2 spent $4,200 and RDS spent $2,100 — but not which product, team, or environment those resources belong to.

Tag every resource from day one with at minimum:

- `env`: `prod` / `staging` / `dev`
- `team`: engineering / data / platform / etc.
- `project` or `app`: the product or service this belongs to
- `owner`: the person or team responsible

Activate these tags in Cost Explorer under Billing > Cost allocation tags. Once active (takes 24 hours), they become filterable dimensions in Cost Explorer and usable in Budget filters.

Enforcement: use AWS Config rule `required-tags` or Service Control Policies to deny resource creation without required tags. Tag-based cost allocation is useless if it is inconsistent.

### Lever 3: The Top 10 Cost Surprises

These are the line items that generate the most "wait, what is this?" moments on AWS bills:

1. **NAT Gateway** — $0.045/GB data processing + $32.40/month per gateway. A few services doing chatty API calls through NAT can hit hundreds per month. Solution: VPC Gateway Endpoints for S3 and DynamoDB (free), Interface Endpoints for other services, or restructure to avoid NAT where possible.
2. **CloudWatch Logs ingestion** — $0.50/GB. Lambda functions with `console.log` on every invocation, verbose ALB access logs, or VPC Flow Logs enabled without a log retention policy compound quickly. Set log levels, use sampling, and always set retention.
3. **Idle load balancers** — $16.20/month per ALB/NLB regardless of traffic. Delete unused load balancers. A dev environment that kept its ALB after the project ended costs $195/year for nothing.
4. **Unattached EBS volumes** — EC2 termination does not delete EBS volumes by default. You pay for provisioned capacity whether or not anything is using it. Audit with `aws ec2 describe-volumes --filters Name=status,Values=available`.
5. **Old EBS snapshots** — $0.05/GB/month for every snapshot you have ever taken and not deleted. Implement Data Lifecycle Manager policies from the start.
6. **Cross-AZ data transfer** — $0.01/GB each way between AZs. Sounds trivial; at 10TB/month bidirectional it is $200/month. Services deployed across AZs for redundancy that talk to each other constantly pay this cost continuously.
7. **S3 without lifecycle policies** — data written to S3 Standard stays there forever at $0.023/GB/month unless you set lifecycle rules. Use Intelligent-Tiering for uncertain access patterns, or set explicit transitions to Glacier for archival data.
8. **Over-provisioned RDS** — RDS instances are priced by instance type, not by actual CPU/memory used. A db.r6g.2xlarge sitting at 5% CPU costs the same as one at 95%. Multi-AZ doubles this. Dev environments almost never need Multi-AZ.
9. **Lambda at scale** — Lambda bills on duration × memory. At low invocation counts it is extremely cheap. At millions of invocations per day with non-trivial runtimes, it can exceed the cost of equivalent EC2 capacity. The crossover depends on workload but is typically around 1M+ invocations per month with >500ms average duration.
10. **Free tier expiration** — Most "always free" limits are small, but 12-month free tier items (750 hrs EC2 t2.micro, 20GB RDS storage, etc.) expire exactly 12 months after account creation. If you built anything in those first 12 months assuming free tier, budget for a step change in your bill at month 13.

### Lever 4: Serverless Doesn't Mean Cheap

The mental model that "serverless = no idle cost = cheap" is accurate at low scale and breaks down at high scale.

Lambda pricing: $0.20 per 1M requests + $0.0000166667 per GB-second of duration. A function with 512MB memory running for 200ms costs $0.0000016667 per invocation. At 10M invocations/month: $16.67 in duration + $2.00 in requests = ~$19.

Equivalent EC2 (t3.small, 2 vCPU, 2GB RAM): $15.18/month On-Demand, handling continuous traffic. At consistent high-concurrency, EC2 wins on cost. Lambda wins on operational simplicity, and the cost crossover is workload-dependent.

The right question is not "serverless vs. EC2 on cost" but "what is my actual invocation pattern?" Spiky/unpredictable → serverless wins. Consistent high-throughput → compute savings + EC2/containers likely wins. Use the [AWS Pricing Calculator](https://calculator.aws) to model both before committing.

### Lever 5: Data Transfer Is the Hidden Architecture Tax

Data transfer costs are invisible during design but persistent in production. Key rates (us-east-1):

- **Internet egress:** $0.09/GB for first 10TB/month, $0.085/GB next 40TB — outbound to the internet from EC2/RDS/etc.
- **Cross-AZ:** $0.01/GB each way — applies to EC2, RDS, ElastiCache, ELB, and any other service communicating across AZs
- **CloudFront to internet:** $0.0085/GB for first 10TB — CloudFront is cheaper for internet egress than direct from EC2
- **S3 to EC2 in same region:** Free — use this. S3 to EC2 in different region: $0.01/GB
- **VPC peering, same region:** $0.01/GB each way
- **Transit Gateway:** $0.02/GB processed + $0.05/hr per attachment

Architecture decisions that incur transfer costs: placing a database in one AZ and application servers in another (cross-AZ every query), using a centralized logging aggregator that pulls data across regions, streaming data from S3 in a different region, or routing all inter-service traffic through a Transit Gateway when direct peering is cheaper.

---

## Common Patterns

### Pattern 1: Query Last 30 Days Cost by Service (AWS SDK)

```typescript
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";

const client = new CostExplorerClient({ region: "us-east-1" });

async function getCostByService(days = 30) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const formatDate = (d: Date) => d.toISOString().split("T")[0];

  const response = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: {
        Start: formatDate(start),
        End: formatDate(end),
      },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost", "UsageQuantity"],
      GroupBy: [
        {
          Type: "DIMENSION",
          Key: "SERVICE",
        },
      ],
    })
  );

  const results = response.ResultsByTime?.[0]?.Groups ?? [];

  return results
    .map((group) => ({
      service: group.Keys?.[0] ?? "Unknown",
      cost: parseFloat(group.Metrics?.UnblendedCost?.Amount ?? "0"),
      unit: group.Metrics?.UnblendedCost?.Unit ?? "USD",
    }))
    .sort((a, b) => b.cost - a.cost);
}

// Usage
const costs = await getCostByService(30);
costs.slice(0, 10).forEach(({ service, cost, unit }) => {
  console.log(`${service}: ${cost.toFixed(2)} ${unit}`);
});
```

### Pattern 2: Monthly Budget with SNS Alert (AWS CDK)

```typescript
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

export class BudgetStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const alertTopic = new sns.Topic(this, "BudgetAlerts", {
      topicName: "budget-alerts",
    });

    alertTopic.addSubscription(
      new subscriptions.EmailSubscription("ops@yourcompany.com")
    );

    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "monthly-total",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: {
          amount: 1000, // $1,000/month
          unit: "USD",
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80, // Alert at 80% of budget
            thresholdType: "PERCENTAGE",
          },
          subscribers: [
            {
              subscriptionType: "SNS",
              address: alertTopic.topicArn,
            },
          ],
        },
        {
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 100, // Alert when forecasted to exceed
            thresholdType: "PERCENTAGE",
          },
          subscribers: [
            {
              subscriptionType: "SNS",
              address: alertTopic.topicArn,
            },
          ],
        },
      ],
    });
  }
}
```

### Pattern 3: Cost Allocation Tagging Strategy (CDK Aspects)

Apply tags to every resource in a stack automatically using CDK Aspects, then enforce required tags with a Config rule.

```typescript
import { IAspect, Tags, Aspects } from "aws-cdk-lib";
import { IConstruct } from "constructs";
import * as config from "aws-cdk-lib/aws-config";

// Aspect to apply standard tags to every resource in a scope
class RequiredTagsAspect implements IAspect {
  constructor(
    private readonly tags: Record<string, string>
  ) {}

  visit(node: IConstruct): void {
    for (const [key, value] of Object.entries(this.tags)) {
      Tags.of(node).add(key, value);
    }
  }
}

// Apply in your stack
export class MyAppStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // All resources in this stack get these tags
    Aspects.of(this).add(
      new RequiredTagsAspect({
        env: "prod",
        team: "platform",
        project: "my-app",
        owner: "platform-team",
        "cost-center": "engineering",
      })
    );

    // AWS Config rule to enforce required tags on EC2 and RDS
    new config.ManagedRule(this, "RequiredTagsRule", {
      identifier: config.ManagedRuleIdentifiers.REQUIRED_TAGS,
      inputParameters: {
        tag1Key: "env",
        tag2Key: "team",
        tag3Key: "project",
      },
    });
  }
}
```

### Pattern 4: Right-Sizing Checklist

Run these queries before and after any right-sizing effort to establish baselines.

**Lambda memory right-sizing:**
```bash
# Get Lambda function configurations — look for over-provisioned memory
aws lambda list-functions --query 'Functions[*].[FunctionName,MemorySize,Runtime]' \
  --output table

# Get average duration and max memory used from CloudWatch Insights
aws logs start-query \
  --log-group-name "/aws/lambda/your-function-name" \
  --start-time $(date -d '7 days ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'filter @type = "REPORT"
    | stats avg(@duration), max(@duration), avg(@maxMemoryUsed), max(@maxMemoryUsed)
    by bin(1d)'
```

**EC2 right-sizing — find instances with low CPU utilization:**
```bash
# List EC2 recommendations from Compute Optimizer
aws compute-optimizer get-ec2-instance-recommendations \
  --query 'instanceRecommendations[?finding==`OVER_PROVISIONED`].{
    Instance:instanceArn,
    CurrentType:currentInstanceType,
    RecommendedType:recommendationOptions[0].instanceType,
    EstimatedMonthlySavings:recommendationOptions[0].estimatedMonthlySavings.value
  }' \
  --output table
```

**Unattached EBS volumes — immediate quick win:**
```bash
aws ec2 describe-volumes \
  --filters Name=status,Values=available \
  --query 'Volumes[*].{ID:VolumeId,Size:Size,Type:VolumeType,Created:CreateTime}' \
  --output table
```

**Old snapshots — audit before deleting:**
```bash
# Find snapshots older than 90 days owned by your account
aws ec2 describe-snapshots \
  --owner-ids self \
  --query 'Snapshots[?StartTime<=`2025-01-01`].{ID:SnapshotId,Size:VolumeSize,Date:StartTime,Desc:Description}' \
  --output table
```

**RDS instance utilization:**
```bash
# Get Compute Optimizer recommendations for RDS
aws compute-optimizer get-rds-database-recommendations \
  --query 'rdsDBRecommendations[?finding==`OVER_PROVISIONED`].{
    DB:resourceArn,
    CurrentClass:currentDBInstanceClass,
    Finding:finding,
    Savings:recommendationOptions[0].estimatedMonthlySavings.value
  }' \
  --output table
```

---

## Gotchas

**1. NAT Gateway is almost always your biggest surprise.**
At $0.045/GB processing plus $32.40/month per gateway, a single NAT handling 200GB/month costs $41.40. In a multi-AZ setup with one NAT per AZ, triple that. The fix: deploy VPC Gateway Endpoints for S3 and DynamoDB (free, no data processing charge). For other services, evaluate whether you need internet access at all, or whether Interface Endpoints are cheaper than the NAT cost.

**2. CloudWatch Logs retention defaults to "never expire."**
Every log group created without an explicit retention policy stores data forever at $0.03/GB/month storage after the first free tier period. Lambda functions, ECS tasks, and API Gateway all create log groups automatically. Add a default retention policy to all log groups: 7 days for dev, 30 days for staging, 90 days for prod (adjust to your compliance requirements). The CDK `aws-cdk-lib/aws-logs` `RetentionDays` enum makes this a one-liner.

**3. Reserved Instances are stranded when you change instance types.**
If you buy an m5.xlarge Standard RI and later migrate to Graviton (m7g.xlarge), the RI applies to nothing. You still pay for the commitment. Convertible RIs let you exchange for different instance types but offer ~10% less discount. Compute Savings Plans are more forgiving — they apply to any EC2 instance type and automatically cover Fargate and Lambda. For most teams, Compute Savings Plans are the better choice unless you need the extra 6% discount from EC2 Instance Savings Plans and are certain of the instance family.

**4. Savings Plans commit to $/hr — understand what that means.**
A $0.10/hr Compute Savings Plan covers $0.10 worth of compute every hour. If you use $0.08/hr at 2 AM and $0.25/hr at 2 PM, the plan applies only to the first $0.10/hr — the rest is On-Demand. You cannot "bank" unused hours. Size your commitment to your minimum expected usage, not your average or peak.

**5. Cross-AZ data transfer is invisible until it is not.**
Services in private subnets talking to RDS in a different AZ, ECS tasks in us-east-1a calling ElastiCache in us-east-1b, ALB distributing traffic to targets in multiple AZs — all of these incur $0.01/GB each way. At low traffic, negligible. At high throughput (multi-TB/month), can be hundreds of dollars. The solution depends on the workload: pin latency-sensitive caches to a single AZ (accept the redundancy tradeoff), use same-AZ routing where possible, or architect to minimize cross-AZ chattiness.

**6. S3 Intelligent-Tiering has a minimum object size and monitoring fee.**
Intelligent-Tiering adds $0.0025 per 1,000 objects/month for monitoring, and objects smaller than 128KB are not tiered (they stay at Standard price). For a bucket with millions of tiny files (thumbnails, small JSON blobs), Intelligent-Tiering's monitoring cost can exceed the storage savings. Evaluate object size distribution before enabling it at scale.

**7. CloudFront invalidations are not free in bulk.**
The first 1,000 invalidation paths per month are free. After that: $0.005 per path. If your CI/CD pipeline invalidates `/*` on every deploy, that counts as one path (wildcard) — still $0.005 per deploy after the first 1,000. If you are invalidating individual file paths for cache-busting, enumerate carefully or switch to versioned URLs instead, which never need invalidation.

**8. RDS Multi-AZ and Read Replicas double (or more) your instance cost.**
Multi-AZ: your primary instance runs in one AZ, a standby in another — you pay for both, plus synchronous replication data transfer. Read Replicas: each replica is a full instance at full price plus async replication transfer. Dev and staging environments almost never need either. Staging can run single-AZ with daily snapshots for recovery. Only production environments with actual HA requirements warrant Multi-AZ.

**9. The 12-month free tier catches teams off guard at month 13.**
750 hours/month of t2.micro or t3.micro EC2, 750 hours of RDS db.t2.micro or db.t3.micro, 5GB S3, 15GB data transfer — all free for 12 months from account creation. Teams that scaffold a dev environment in a new account and then largely ignore billing until month 13 get a step-change bill. Set a Budget alarm at account creation that triggers if any service exceeds its free tier threshold. The `FREE_TIER` budget type in AWS Budgets does this automatically.

**10. Lambda charges for allocated memory, not used memory.**
If your function allocates 1024MB but only uses 200MB at runtime, you pay for 1024MB. However, Lambda allocates proportional CPU to memory — more memory = more CPU = faster execution. The optimization is not always "use less memory"; sometimes increasing memory reduces duration enough to lower total cost. Use AWS Lambda Power Tuning (open source) to find the optimal memory/duration cost curve for your specific function.

**11. Transferring data out of AWS is expensive; getting it in is (mostly) free.**
Inbound data transfer to AWS is free. Outbound to the internet starts at $0.09/GB. This asymmetry means data-intensive workloads that need to serve large responses (video, large file downloads, bulk data exports) should route through CloudFront, which has lower egress rates ($0.0085/GB first 10TB) and caches content at edge locations to reduce origin calls.

**12. Cost Anomaly Detection requires setup — it does not work out of the box.**
You must create an anomaly monitor (by service, account, cost category, or tag) and a subscription (email or SNS). Without setup, you have no automated anomaly alerting. One monitor per account is usually sufficient to start; add tag-based monitors once cost allocation tags are consistent.

---

## Official Documentation

- **AWS Cost Management User Guide** — Full reference for Cost Explorer, Budgets, Anomaly Detection, Cost Categories, and Billing Conductor: https://docs.aws.amazon.com/cost-management/latest/userguide/
- **AWS Well-Architected — Cost Optimization Pillar** — The canonical reference for cost optimization as an architectural concern, covering expenditure awareness, cost-effective resources, and managing demand: https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html
- **AWS Pricing Calculator** — Model costs before you build. Supports EC2, RDS, Lambda, S3, data transfer, and most major services: https://calculator.aws/
- **AWS Cost Optimization Hub** — Aggregated right-sizing and pricing model recommendations with estimated savings: https://docs.aws.amazon.com/cost-management/latest/userguide/cost-optimization-hub.html
- **Compute Optimizer** — ML-based resource right-sizing recommendations for EC2, Lambda, ECS, EBS, and Auto Scaling: https://docs.aws.amazon.com/compute-optimizer/latest/ug/what-is-compute-optimizer.html
- **AWS Lambda Power Tuning** (open source) — Step Functions state machine to find the optimal memory setting for a Lambda function by testing across memory configurations and measuring cost/performance: https://github.com/alexcasalboni/aws-lambda-power-tuning
- **Data Transfer Cost Reference** — Complete pricing for cross-AZ, cross-region, internet egress, CloudFront, and VPC peering: https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer
- **Savings Plans User Guide** — Covers Compute, EC2 Instance, and SageMaker Savings Plans with commitment mechanics, coverage reports, and purchase recommendations: https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html
