---
name: aws-security-posture
description: AWS security posture guidance — Security Hub, GuardDuty, Config, Inspector, detective controls, compliance frameworks. Use when implementing security monitoring, compliance, or threat detection.
metadata:
  priority: 4
  docs:
    - "https://docs.aws.amazon.com/securityhub/latest/userguide/"
  pathPatterns:
    - 'security/**'
    - 'compliance/**'
  bashPatterns:
    - '\baws\s+securityhub\b'
    - '\baws\s+guardduty\b'
    - '\baws\s+inspector2\b'
    - '\baws\s+configservice\b'
  importPatterns:
    - "@aws-sdk/client-securityhub"
    - "@aws-sdk/client-guardduty"
    - "@aws-sdk/client-inspector2"
    - "@aws-sdk/client-config-service"
  promptSignals:
    phrases:
      - "security hub"
      - "guardduty"
      - "aws config"
      - "inspector"
      - "security posture"
      - "compliance"
      - "threat detection"
      - "security finding"
      - "cis benchmark"
---

# AWS Security Posture

## What It Is & When to Use It

AWS security monitoring spans four distinct services, each answering a different question. Understanding the mental model before writing code saves significant rework.

**The four services and what they answer:**

| Service | Core Question | Data Sources | Output |
|---------|--------------|--------------|--------|
| GuardDuty | "Is someone attacking me?" | VPC Flow Logs, DNS logs, CloudTrail events, S3 access logs | Threat findings (MEDIUM/HIGH/CRITICAL) |
| AWS Config | "Are my resources configured correctly?" | Config snapshots, config change events | Compliance rules — COMPLIANT / NON_COMPLIANT |
| Inspector v2 | "Do I have vulnerabilities?" | EC2 OS packages, Lambda function packages, ECR container images | CVE findings with CVSS scores |
| Security Hub | "Show me everything in one place" | Aggregates findings from GuardDuty, Config, Inspector, Macie, IAM Access Analyzer, and third-party tools | Unified findings dashboard, compliance scores |

**How they connect:** GuardDuty, Inspector, and Config each generate findings independently. Security Hub acts as the aggregation layer — it ingests findings from all three (and more) and normalizes them into the AWS Security Finding Format (ASFF). From Security Hub you build dashboards, route to EventBridge for automation, or export to a SIEM.

**Data flow:**

```
GuardDuty ──────────────────────┐
Inspector v2 ───────────────────┤──→ Security Hub ──→ EventBridge ──→ SNS / Lambda / Slack
Config (via Security Hub rules) ┘         │
IAM Access Analyzer ────────────┘         └──→ S3 (findings export)
Macie ───────────────────────────┘
```

**Critical gotchas before you start:**

- **Security Hub pricing:** $0.0001 per finding ingested per month after the 10,000 finding free tier. On a busy account ingesting GuardDuty at scale, this adds up. Audit your integrations — not every finding source needs to be enabled.
- **GuardDuty pricing:** Based on data volume analyzed (GB of VPC Flow Logs, DNS queries, CloudTrail events). High-traffic VPCs can run $200–$800/month per region. Enable GuardDuty in all regions but verify cost in your busiest regions first.
- **Config rule costs:** $0.001 per config rule evaluation. Rules evaluate on every resource configuration change. 50 rules across 1,000 resources with frequent changes = surprising monthly bills. Use periodic evaluation mode (every 24h) for rules that don't need real-time compliance.
- **Inspector v2 vs Inspector v1:** These are completely different products. Inspector v1 (classic) is deprecated. Inspector v2 uses a lightweight SSM agent and ECR registry scanning — no assessment templates, no assessment runs. If you see old documentation referencing assessment templates, it's for v1.
- **Multi-region:** GuardDuty, Config, and Inspector v2 must be enabled per region. Security Hub supports cross-region aggregation via a designated aggregation region — set this up early.
- **Organizations integration:** All four services support AWS Organizations delegated administrator. Always use Organizations integration in multi-account setups — managing member accounts individually is unscalable.

---

## Service Surface — Security Hub: Unified Findings and Compliance Scores

Security Hub is your operational dashboard and the API surface you'll query most often. Enable it first, then layer in the other services.

### Enabling Security Hub

```typescript
import {
  SecurityHubClient,
  EnableSecurityHubCommand,
  GetFindingsCommand,
  BatchUpdateFindingsCommand,
  UpdateStandardsControlCommand,
  type AwsSecurityFinding,
} from "@aws-sdk/client-securityhub";

const client = new SecurityHubClient({ region: "us-east-1" });

// Enable Security Hub with default standards (CIS + AWS Foundational)
// In most cases, do this via Organizations delegated admin instead
const enableHub = async () => {
  await client.send(
    new EnableSecurityHubCommand({
      EnableDefaultStandards: true, // Enables CIS AWS Foundations + AWS Foundational Security Best Practices
      Tags: { Environment: "production" },
    })
  );
};
```

### Querying Findings

Security Hub findings use ASFF (AWS Security Finding Format). The `GetFindings` API accepts filter objects — learn the filter shape before building dashboards.

```typescript
import {
  SecurityHubClient,
  GetFindingsCommand,
  type StringFilter,
  type NumberFilter,
} from "@aws-sdk/client-securityhub";

const client = new SecurityHubClient({ region: "us-east-1" });

// Fetch all CRITICAL and HIGH findings that are active and not suppressed
const getCriticalFindings = async () => {
  const findings: AwsSecurityFinding[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new GetFindingsCommand({
        Filters: {
          SeverityLabel: [
            { Value: "CRITICAL", Comparison: "EQUALS" },
            { Value: "HIGH", Comparison: "EQUALS" },
          ],
          RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
          WorkflowStatus: [
            { Value: "NEW", Comparison: "EQUALS" },
            { Value: "NOTIFIED", Comparison: "EQUALS" },
          ],
        },
        SortCriteria: [{ Field: "SeverityNormalized", SortOrder: "DESCENDING" }],
        MaxResults: 100,
        NextToken: nextToken,
      })
    );

    findings.push(...(response.Findings ?? []));
    nextToken = response.NextToken;
  } while (nextToken);

  return findings;
};

// Filter findings by specific AWS service product
const getGuardDutyFindings = async () => {
  const response = await client.send(
    new GetFindingsCommand({
      Filters: {
        ProductName: [{ Value: "GuardDuty", Comparison: "EQUALS" }],
        RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
      },
      MaxResults: 100,
    })
  );
  return response.Findings ?? [];
};
```

### Updating Finding Workflow Status

Use `BatchUpdateFindings` (not `BatchImportFindings` — that's for third-party integrations) to update workflow state on existing findings.

```typescript
import {
  SecurityHubClient,
  BatchUpdateFindingsCommand,
} from "@aws-sdk/client-securityhub";

const client = new SecurityHubClient({ region: "us-east-1" });

// Suppress a finding (mark as resolved or suppressed)
const suppressFinding = async (findingId: string, productArn: string) => {
  await client.send(
    new BatchUpdateFindingsCommand({
      FindingIdentifiers: [{ Id: findingId, ProductArn: productArn }],
      Workflow: { Status: "SUPPRESSED" },
      Note: {
        Text: "Accepted risk — internal tooling account, no external exposure",
        UpdatedBy: "security-automation",
      },
    })
  );
};

// Mark a finding as resolved after remediation
const resolveFinding = async (findingId: string, productArn: string) => {
  await client.send(
    new BatchUpdateFindingsCommand({
      FindingIdentifiers: [{ Id: findingId, ProductArn: productArn }],
      Workflow: { Status: "RESOLVED" },
    })
  );
};
```

### Compliance Score via Standards

```typescript
import {
  SecurityHubClient,
  GetComplianceSummaryCommand,
  ListStandardsControlAssociationsCommand,
  DescribeStandardsControlsCommand,
} from "@aws-sdk/client-securityhub";

const client = new SecurityHubClient({ region: "us-east-1" });

// Get compliance summary across all enabled standards
// Note: No single "get compliance score" API — you derive it from control statuses
const getComplianceSummary = async (subscriptionArn: string) => {
  const controls = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new DescribeStandardsControlsCommand({
        StandardsSubscriptionArn: subscriptionArn,
        MaxResults: 100,
        NextToken: nextToken,
      })
    );
    controls.push(...(response.Controls ?? []));
    nextToken = response.NextToken;
  } while (nextToken);

  const passed = controls.filter((c) => c.ControlStatus === "ENABLED").length;
  const total = controls.length;
  const score = Math.round((passed / total) * 100);

  return { passed, total, score, controls };
};
```

---

## Mental Model — GuardDuty: Threat Detection

GuardDuty runs continuous threat detection without any agents. It analyzes VPC Flow Logs, Route 53 DNS queries, CloudTrail management events, and (when enabled) S3 data events and EKS audit logs.

### Enabling GuardDuty

```typescript
import {
  GuardDutyClient,
  CreateDetectorCommand,
  ListDetectorsCommand,
  GetDetectorCommand,
  ListFindingsCommand,
  GetFindingsCommand,
  type Finding,
} from "@aws-sdk/client-guardduty";

const client = new GuardDutyClient({ region: "us-east-1" });

// Enable GuardDuty in the current region
const enableGuardDuty = async () => {
  // Check if already enabled
  const existing = await client.send(new ListDetectorsCommand({}));
  if (existing.DetectorIds && existing.DetectorIds.length > 0) {
    return existing.DetectorIds[0];
  }

  const response = await client.send(
    new CreateDetectorCommand({
      Enable: true,
      FindingPublishingFrequency: "SIX_HOURS", // FIFTEEN_MINUTES | ONE_HOUR | SIX_HOURS
      DataSources: {
        S3Logs: { Enable: true },
        Kubernetes: { AuditLogs: { Enable: true } },
        MalwareProtection: {
          ScanEc2InstanceWithFindings: { EbsVolumes: true },
        },
      },
      Tags: { Environment: "production" },
    })
  );

  return response.DetectorId;
};
```

### Querying GuardDuty Findings

GuardDuty findings live in GuardDuty itself — Security Hub ingests a copy, but the GuardDuty API gives you richer detail and filtering.

```typescript
import {
  GuardDutyClient,
  ListFindingsCommand,
  GetFindingsCommand,
  CreateFilterCommand,
} from "@aws-sdk/client-guardduty";

const client = new GuardDutyClient({ region: "us-east-1" });

const getHighSeverityFindings = async (detectorId: string) => {
  // Step 1: List finding IDs with filters
  const listResponse = await client.send(
    new ListFindingsCommand({
      DetectorId: detectorId,
      FindingCriteria: {
        Criterion: {
          severity: {
            GreaterThanOrEqual: 7, // 7.0+ = HIGH, 9.0+ = CRITICAL
          },
          service.archived: {
            Eq: ["false"],
          },
        },
      },
      SortCriteria: {
        AttributeName: "severity",
        OrderBy: "DESC",
      },
      MaxResults: 50,
    })
  );

  const findingIds = listResponse.FindingIds ?? [];
  if (findingIds.length === 0) return [];

  // Step 2: Fetch full finding details (max 50 IDs per call)
  const findingsResponse = await client.send(
    new GetFindingsCommand({
      DetectorId: detectorId,
      FindingIds: findingIds,
    })
  );

  return findingsResponse.Findings ?? [];
};

// Create a suppression filter to reduce noise from known-safe activity
const createSuppressionFilter = async (detectorId: string) => {
  await client.send(
    new CreateFilterCommand({
      DetectorId: detectorId,
      Name: "suppress-internal-scanner",
      Description: "Suppress findings from internal security scanner IPs",
      Action: "ARCHIVE", // AUTO_ARCHIVE matching findings
      Rank: 1,
      FindingCriteria: {
        Criterion: {
          "service.action.networkConnectionAction.remoteIpDetails.ipAddressV4": {
            Eq: ["10.0.1.50", "10.0.1.51"], // Internal scanner IPs
          },
        },
      },
    })
  );
};
```

### Common GuardDuty Finding Types to Know

| Finding Type | What it means | Severity |
|-------------|---------------|----------|
| `UnauthorizedAccess:EC2/SSHBruteForce` | Someone is brute-forcing SSH on your instance | MEDIUM |
| `Recon:EC2/PortProbeUnprotectedPort` | External reconnaissance on open ports | LOW |
| `CryptoCurrency:EC2/BitcoinTool.B` | Instance is mining crypto | HIGH |
| `Backdoor:EC2/C&CActivity.B` | Instance is communicating with known C&C server | HIGH |
| `UnauthorizedAccess:IAMUser/ConsoleLoginSuccess.B` | Console login from unusual location | MEDIUM |
| `Persistence:IAMUser/NetworkPermissions` | IAM policy change granting network access | HIGH |
| `Exfiltration:S3/ObjectRead.Unusual` | Unusual S3 data access pattern | HIGH |
| `PrivilegeEscalation:IAMUser/AnomalousBehavior` | Anomalous privilege escalation attempt | HIGH |

---

## Common Patterns — AWS Config: Resource Configuration Compliance

Config continuously records resource configuration changes and evaluates them against rules. It answers "are my resources configured the way they should be?" — not threat detection, but drift detection and compliance.

### Core Concepts

- **Configuration recorder:** Records configuration snapshots for supported resource types. Enable it first.
- **Delivery channel:** Sends config snapshots and change notifications to S3 and SNS.
- **Config rules:** Evaluate resources for compliance. Can be AWS Managed (100+ prebuilt) or custom Lambda-backed.
- **Conformance packs:** Bundles of Config rules representing a compliance framework (CIS, NIST, PCI-DSS).

```typescript
import {
  ConfigServiceClient,
  PutConfigurationRecorderCommand,
  PutDeliveryChannelCommand,
  StartConfigurationRecorderCommand,
  PutConfigRuleCommand,
  DescribeComplianceByResourceCommand,
  GetComplianceDetailsByConfigRuleCommand,
  type ConfigRule,
} from "@aws-sdk/client-config-service";

const client = new ConfigServiceClient({ region: "us-east-1" });

// Enable Config recording for all supported resources
const enableConfig = async (roleArn: string, bucketName: string) => {
  // Create the configuration recorder
  await client.send(
    new PutConfigurationRecorderCommand({
      ConfigurationRecorder: {
        name: "default",
        roleARN: roleArn, // IAM role with AWSConfigRole managed policy
        recordingGroup: {
          allSupported: true,
          includeGlobalResourceTypes: true, // Includes IAM resources (only enable in one region)
        },
      },
    })
  );

  // Set up the delivery channel (S3 bucket required, SNS optional)
  await client.send(
    new PutDeliveryChannelCommand({
      DeliveryChannel: {
        name: "default",
        s3BucketName: bucketName,
        configSnapshotDeliveryProperties: {
          deliveryFrequency: "TwentyFour_Hours", // One_Hour | Three_Hours | Six_Hours | Twelve_Hours | TwentyFour_Hours
        },
      },
    })
  );

  // Start recording
  await client.send(
    new StartConfigurationRecorderCommand({
      ConfigurationRecorderName: "default",
    })
  );
};

// Add a managed Config rule — S3 bucket should not be publicly accessible
const addS3PublicAccessRule = async () => {
  await client.send(
    new PutConfigRuleCommand({
      ConfigRule: {
        ConfigRuleName: "s3-bucket-public-read-prohibited",
        Description: "Checks that S3 buckets do not allow public read access",
        Source: {
          Owner: "AWS",
          SourceIdentifier: "S3_BUCKET_PUBLIC_READ_PROHIBITED",
        },
        // No scope = evaluates ALL S3 buckets
        // Scope: { ComplianceResourceTypes: ["AWS::S3::Bucket"] },
        MaximumExecutionFrequency: "TwentyFour_Hours", // For periodic rules
      },
    })
  );
};

// Query compliance status for a specific rule
const getRuleCompliance = async (ruleName: string) => {
  const response = await client.send(
    new GetComplianceDetailsByConfigRuleCommand({
      ConfigRuleName: ruleName,
      ComplianceTypes: ["NON_COMPLIANT"],
      Limit: 100,
    })
  );

  return response.EvaluationResults ?? [];
};
```

### Useful Managed Rules Reference

| Rule Identifier | What it checks |
|----------------|----------------|
| `S3_BUCKET_PUBLIC_READ_PROHIBITED` | S3 bucket not publicly readable |
| `S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED` | S3 bucket has default encryption |
| `ENCRYPTED_VOLUMES` | EBS volumes are encrypted |
| `RDS_STORAGE_ENCRYPTED` | RDS instances use encrypted storage |
| `ROOT_ACCOUNT_MFA_ENABLED` | Root account has MFA enabled |
| `IAM_PASSWORD_POLICY` | IAM account password policy meets requirements |
| `CLOUD_TRAIL_ENABLED` | CloudTrail is enabled |
| `VPC_FLOW_LOGS_ENABLED` | VPC flow logs are enabled |
| `RESTRICTED_INCOMING_TRAFFIC` | Security groups don't allow unrestricted access on risky ports |
| `LAMBDA_FUNCTION_PUBLIC_ACCESS_PROHIBITED` | Lambda functions have no public resource-based policies |

### Conformance Packs for Compliance Frameworks

Use conformance packs instead of adding rules individually when targeting a compliance framework.

```typescript
import {
  ConfigServiceClient,
  PutConformancePackCommand,
} from "@aws-sdk/client-config-service";

const client = new ConfigServiceClient({ region: "us-east-1" });

// Deploy the CIS AWS Foundations Benchmark conformance pack
// AWS provides managed conformance pack templates at:
// https://docs.aws.amazon.com/config/latest/developerguide/conformancepack-sample-templates.html
const deployCISConformancePack = async (bucketName: string) => {
  await client.send(
    new PutConformancePackCommand({
      ConformancePackName: "cis-aws-foundations-benchmark",
      TemplateS3Uri: `s3://${bucketName}/conformance-packs/cis-aws-foundations-benchmark.yaml`,
      // Or use TemplateBody for inline YAML
    })
  );
};
```

---

## Gotchas — Inspector v2: Vulnerability Scanning

Inspector v2 continuously scans EC2 instances, Lambda functions, and ECR container images for known CVEs. It requires the SSM agent for EC2 scanning and uses the ECR registry integration for container images — no separate agents to deploy.

### Enabling Inspector v2

```typescript
import {
  Inspector2Client,
  EnableCommand,
  ListFindingsCommand,
  GetFindingsReportStatusCommand,
  CreateFindingsReportCommand,
  type ResourceType,
  type Finding,
} from "@aws-sdk/client-inspector2";

const client = new Inspector2Client({ region: "us-east-1" });

// Enable Inspector v2 for EC2, ECR, and Lambda
const enableInspector = async () => {
  const response = await client.send(
    new EnableCommand({
      resourceTypes: ["EC2", "ECR", "LAMBDA"], // ResourceType enum values
    })
  );

  // Check for failures
  const failures = response.failedAccounts ?? [];
  if (failures.length > 0) {
    console.error("Inspector enable failures:", failures);
  }

  return response;
};
```

### Querying Inspector Findings

```typescript
import {
  Inspector2Client,
  ListFindingsCommand,
  type StringFilter,
  type NumberFilter,
} from "@aws-sdk/client-inspector2";

const client = new Inspector2Client({ region: "us-east-1" });

// Get all CRITICAL severity findings, sorted by CVSS score
const getCriticalVulnerabilities = async () => {
  const findings: Finding[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new ListFindingsCommand({
        filterCriteria: {
          severity: [{ comparison: "EQUALS", value: "CRITICAL" }],
          findingStatus: [{ comparison: "EQUALS", value: "ACTIVE" }],
        },
        sortCriteria: {
          field: "INSPECTOR_SCORE",
          sortOrder: "DESC",
        },
        maxResults: 100,
        nextToken,
      })
    );

    findings.push(...(response.findings ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  return findings;
};

// Get findings for a specific ECR image (useful in CI/CD gates)
const getImageVulnerabilities = async (imageUri: string) => {
  const response = await client.send(
    new ListFindingsCommand({
      filterCriteria: {
        ecrImageRepositoryName: [
          {
            comparison: "EQUALS",
            value: imageUri.split("/").pop()?.split(":")[0] ?? "",
          },
        ],
        findingStatus: [{ comparison: "EQUALS", value: "ACTIVE" }],
      },
      sortCriteria: {
        field: "SEVERITY",
        sortOrder: "DESC",
      },
      maxResults: 100,
    })
  );

  return response.findings ?? [];
};

// Export findings to S3 as CSV or JSON
const exportFindings = async (bucketName: string, kmsKeyArn: string) => {
  const response = await client.send(
    new CreateFindingsReportCommand({
      reportFormat: "JSON", // CSV | JSON
      s3Destination: {
        bucketName,
        kmsKeyArn,
        keyPrefix: `inspector-reports/${new Date().toISOString().split("T")[0]}`,
      },
      filterCriteria: {
        findingStatus: [{ comparison: "EQUALS", value: "ACTIVE" }],
        severity: [
          { comparison: "EQUALS", value: "CRITICAL" },
          { comparison: "EQUALS", value: "HIGH" },
        ],
      },
    })
  );

  return response.reportId;
};
```

### Inspector v2 Finding Structure

Inspector findings include the CVE details, affected resource, network reachability, and an Inspector score (0–10, derived from CVSS + network exposure context). The score is higher than the raw CVSS score when Inspector determines the vulnerability is network-reachable.

```typescript
// Key fields on an Inspector Finding
interface InspectorFindingFields {
  findingArn: string;
  severity: "INFORMATIONAL" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  inspectorScore: number; // 0–10, context-adjusted severity
  packageVulnerabilityDetails: {
    vulnerabilityId: string; // CVE ID e.g. "CVE-2023-12345"
    cvss: Array<{ score: number; version: string }>;
    vulnerablePackages: Array<{
      name: string;
      version: string;
      fixedInVersion?: string; // The version that patches the CVE
    }>;
  };
  networkReachabilityDetails?: {
    networkPath: { steps: Array<{ componentId: string; componentType: string }> };
    openPortRange: { begin: number; end: number };
    protocol: "TCP" | "UDP";
  };
  resources: Array<{
    type: "AWS_EC2_INSTANCE" | "AWS_ECR_CONTAINER_IMAGE" | "AWS_LAMBDA_FUNCTION";
    id: string;
    region: string;
    tags: Record<string, string>;
  }>;
}
```

---

## 6. Automation Patterns — Closing the Loop

Findings are only useful if they trigger action. The standard pattern is: Security Hub findings → EventBridge rule → Lambda → remediation or notification.

### EventBridge Rule for Critical Findings

```typescript
// CDK / infrastructure example showing the wiring
// EventBridge pattern for Security Hub findings
const securityHubFindingPattern = {
  source: ["aws.securityhub"],
  "detail-type": ["Security Hub Findings - Imported"],
  detail: {
    findings: {
      Severity: {
        Label: ["CRITICAL", "HIGH"],
      },
      Workflow: {
        Status: ["NEW"],
      },
      RecordState: ["ACTIVE"],
    },
  },
};
```

### Lambda Remediation Handler

```typescript
import {
  SecurityHubClient,
  BatchUpdateFindingsCommand,
} from "@aws-sdk/client-securityhub";
import type { EventBridgeEvent } from "aws-lambda";

interface SecurityHubDetail {
  findings: Array<{
    Id: string;
    ProductArn: string;
    Title: string;
    Severity: { Label: string };
    Types: string[];
    Resources: Array<{ Type: string; Id: string }>;
  }>;
}

const hubClient = new SecurityHubClient({});

export const handler = async (
  event: EventBridgeEvent<"Security Hub Findings - Imported", SecurityHubDetail>
) => {
  const findings = event.detail.findings;

  for (const finding of findings) {
    console.log(`Processing finding: ${finding.Title} (${finding.Severity.Label})`);

    // Route to Slack, PagerDuty, or Jira based on severity and type
    await routeFinding(finding);

    // Update workflow status to NOTIFIED so it doesn't re-alert
    await hubClient.send(
      new BatchUpdateFindingsCommand({
        FindingIdentifiers: [
          { Id: finding.Id, ProductArn: finding.ProductArn },
        ],
        Workflow: { Status: "NOTIFIED" },
        Note: {
          Text: "Routed to on-call via Lambda automation",
          UpdatedBy: "security-automation-lambda",
        },
      })
    );
  }
};

async function routeFinding(finding: SecurityHubDetail["findings"][number]) {
  // GuardDuty threat findings → PagerDuty P1
  if (finding.Types.some((t) => t.includes("TTPs"))) {
    await notifyPagerDuty(finding);
    return;
  }

  // Config/Inspector compliance findings → Jira ticket
  if (finding.Severity.Label === "HIGH") {
    await createJiraTicket(finding);
    return;
  }

  // Everything else → Slack channel
  await notifySlack(finding);
}

// Stubs — implement with your notification provider SDK
async function notifyPagerDuty(finding: unknown) { /* ... */ }
async function createJiraTicket(finding: unknown) { /* ... */ }
async function notifySlack(finding: unknown) { /* ... */ }
```

### Automated Remediation Examples

Some findings have deterministic remediations that are safe to automate. Always scope auto-remediation narrowly and add safeguards.

```typescript
import { S3Client, PutPublicAccessBlockCommand } from "@aws-sdk/client-s3";
import { EC2Client, RevokeSecurityGroupIngressCommand } from "@aws-sdk/client-ec2";

const s3Client = new S3Client({});
const ec2Client = new EC2Client({});

// Auto-remediate: Block S3 public access when Config flags it
export const remediateS3PublicAccess = async (bucketName: string) => {
  // Safety check: only remediate buckets without a specific opt-out tag
  // In practice, check tags first before remediating
  await s3Client.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    })
  );
  console.log(`Blocked public access on S3 bucket: ${bucketName}`);
};

// Auto-remediate: Remove overly permissive 0.0.0.0/0 SSH rules
export const remediateOpenSSH = async (
  groupId: string,
  fromPort: number,
  toPort: number
) => {
  await ec2Client.send(
    new RevokeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [
        {
          IpProtocol: "tcp",
          FromPort: fromPort,
          ToPort: toPort,
          IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          Ipv6Ranges: [{ CidrIpv6: "::/0" }],
        },
      ],
    })
  );
  console.log(`Revoked open SSH rule from security group: ${groupId}`);
};
```

### Security Hub Custom Insight for Tracking

Custom insights are saved filters you can monitor as a panel in Security Hub.

```typescript
import {
  SecurityHubClient,
  CreateInsightCommand,
} from "@aws-sdk/client-securityhub";

const client = new SecurityHubClient({ region: "us-east-1" });

// Create a custom insight: unresolved critical findings by AWS account
const createCriticalFindingsInsight = async () => {
  await client.send(
    new CreateInsightCommand({
      Name: "Unresolved Critical Findings by Account",
      Filters: {
        SeverityLabel: [{ Value: "CRITICAL", Comparison: "EQUALS" }],
        WorkflowStatus: [
          { Value: "NEW", Comparison: "EQUALS" },
          { Value: "NOTIFIED", Comparison: "EQUALS" },
        ],
        RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
      },
      GroupByAttribute: "AwsAccountId", // Group results by account
    })
  );
};
```

---

## Cost Optimization Quick Reference

| Service | Main Cost Driver | Optimization |
|---------|-----------------|-------------|
| Security Hub | Findings ingested per month | Disable integrations you don't act on; use finding filters to suppress noise before ingestion |
| GuardDuty | GB of VPC Flow Logs + DNS + CloudTrail analyzed | Use malware protection and EKS audit logs selectively; review per-region cost monthly |
| Config | Number of rule evaluations | Use `TwentyFour_Hours` delivery frequency for non-real-time rules; avoid `allSupported` if you only care about specific resource types |
| Inspector v2 | EC2 instances scanned + ECR images scanned | Exclude dev environments; use tag-based exclusions for non-production Lambda functions |

**Recommended rollout order:**
1. Enable Config + CloudTrail (audit foundation, relatively cheap)
2. Enable Security Hub (aggregation layer, enable integrations progressively)
3. Enable GuardDuty (verify cost in busy regions before org-wide rollout)
4. Enable Inspector v2 for ECR first (lowest cost, highest CI/CD value), then EC2 and Lambda

---

## Official Documentation

- [Security Hub User Guide](https://docs.aws.amazon.com/securityhub/latest/userguide/)
- [GuardDuty User Guide](https://docs.aws.amazon.com/guardduty/latest/ug/)
- [AWS Config Developer Guide](https://docs.aws.amazon.com/config/latest/developerguide/)
- [Inspector v2 User Guide](https://docs.aws.amazon.com/inspector/latest/user/)
- [AWS Security Finding Format (ASFF) Reference](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-findings-format.html)
- [Config Managed Rules Reference](https://docs.aws.amazon.com/config/latest/developerguide/managed-rules-by-aws-config.html)
- [GuardDuty Finding Types](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_finding-types-active.html)
- [Security Hub Pricing](https://aws.amazon.com/security-hub/pricing/)
- [GuardDuty Pricing](https://aws.amazon.com/guardduty/pricing/)
