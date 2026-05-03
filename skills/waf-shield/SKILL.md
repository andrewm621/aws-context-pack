---
name: waf-shield
description: AWS WAF and Shield guidance — web application firewall, DDoS protection, rate limiting, bot control, managed rules. Use when protecting web applications from attacks.
metadata:
  priority: 4
  docs:
    - "https://docs.aws.amazon.com/waf/latest/developerguide/"
  pathPatterns:
    - 'waf/**'
    - 'security/**'
    - 'firewall/**'
  bashPatterns:
    - '\baws\s+wafv2\b'
    - '\baws\s+shield\b'
  importPatterns:
    - "@aws-sdk/client-wafv2"
    - "@aws-sdk/client-shield"
    - "aws-cdk-lib/aws-wafv2"
  promptSignals:
    phrases:
      - "waf"
      - "web application firewall"
      - "ddos"
      - "shield"
      - "rate limiting"
      - "bot protection"
      - "ip blocking"
      - "managed rules"
---

## Mental Model

Think of WAF as a bouncer at the door checking IDs before anyone enters your application. Every incoming HTTP/S request passes through WAF first. The bouncer follows a rulebook — your Web ACL — and checks each request against rules in priority order. First match wins: the request is either allowed, blocked, or counted (logged but passed). If no rule matches, the default action applies (usually allow).

Shield is a separate but complementary service. If WAF is the bouncer checking individuals, Shield is the building's flood defense — it operates at the network level to absorb volumetric DDoS attacks before they reach your application layer.

Key architectural fact: **WAF for CloudFront distributions must always be deployed in us-east-1**, regardless of where your application runs. WAF for regional resources (ALB, API Gateway, AppSync, Cognito) must be in the same region as that resource. This is one of the most common deployment mistakes.

## What It Is & When to Use It

| Scenario | Service | Notes |
|---|---|---|
| Block SQL injection, XSS | WAF | Use AWSManagedRulesSQLiRuleSet |
| Block specific IPs or CIDR ranges | WAF | IP Set rules |
| Rate limit by IP (e.g., 1000 req/5 min) | WAF | Rate-based rules |
| Geo-block countries | WAF | Geographic match rules |
| Block bad bots, scrapers | WAF | Bot Control managed rule group (extra cost) |
| Allow only known IPs (allowlist) | WAF | IP Set + block default action |
| Volumetric DDoS (layer 3/4) | Shield Standard | Free, automatic, always on |
| Sophisticated DDoS with SRT support | Shield Advanced | $3,000/month + data transfer fees |
| DDoS cost protection (EC2 bill spikes) | Shield Advanced only | Includes WAF fees for protected resources |

Shield Standard is always active — you do not enable it. It protects against common infrastructure-layer attacks automatically. Shield Advanced is a subscription that adds 24/7 access to the DDoS Response Team (SRT), attack visibility in the console, post-attack analysis, and crucially, cost protection so AWS absorbs scaling costs caused by a DDoS event.

## Service Surface

WAF pricing is per Web ACL, per rule, and per million requests:

- **Web ACL:** $5.00/month per ACL
- **Rule:** $1.00/month per rule (within an ACL)
- **Requests:** $0.60 per million HTTP requests evaluated
- **Managed rule groups:** $1.00-$10.00/month depending on the group (Bot Control is $10/month + $1.00/million requests)
- **IP sets and regex pattern sets:** free, but rules that reference them count toward rule cost

Shield Advanced pricing:
- **$3,000/month** flat (consolidated per organization, not per resource)
- **Data transfer out:** charged at standard rates during attacks
- **Benefit:** WAF fees are included for resources protected under Shield Advanced

Cost management tip: A single Web ACL with 5 managed rule groups, attached to a CloudFront distribution serving 100 million requests/month, costs roughly: $5 + $5 (rules) + $60 (requests) + managed group fees. Add Bot Control and you're looking at $80-100+/month before traffic costs. Size your WAF to actual threat model — not every app needs every managed rule group.

## Common Patterns: Core Concepts

**Web ACL (Access Control List):** The top-level WAF resource. You create one per scope (CLOUDFRONT or REGIONAL) and associate it with one or more resources (CloudFront distributions, ALBs, API Gateways). A Web ACL contains ordered rules and a default action.

**Rules:** Individual checks inside a Web ACL. Each has a priority (lower number = evaluated first), a statement (the logic), and an action (Allow, Block, Count, CAPTCHA, Challenge). Rules are evaluated in ascending priority order — first match wins.

**Rule Groups:** Reusable collections of rules. AWS provides managed rule groups; you can also create your own. A managed rule group counts as one rule in your ACL but internally contains many checks.

**Scope:**
- `CLOUDFRONT` — must be created in us-east-1; attaches to CloudFront distributions globally
- `REGIONAL` — created in any region; attaches to ALB, API Gateway REST/HTTP APIs, AppSync, Cognito user pools, App Runner, Verified Access

**Labels:** WAF rules can add labels to requests (e.g., `awswaf:managed:aws:bot-control:bot:category:scraping`). Subsequent rules can match on these labels, enabling multi-stage logic without complex nested statements.

## Common Patterns: Creating a Web ACL and Attaching to Resources

The fundamental flow: create Web ACL → add rules → associate with a resource.

```typescript
import {
  WAFV2Client,
  CreateWebACLCommand,
  AssociateWebACLCommand,
  Scope,
  type CreateWebACLCommandInput,
} from "@aws-sdk/client-wafv2";

// IMPORTANT: CloudFront WAFs must use us-east-1
const wafClient = new WAFV2Client({ region: "us-east-1" });

// Create a Web ACL with common rules
const createWebACL = async (name: string): Promise<string> => {
  const input: CreateWebACLCommandInput = {
    Name: name,
    Scope: Scope.CLOUDFRONT,
    DefaultAction: { Allow: {} }, // allow by default; rules will block
    Description: "Web ACL for production CloudFront distribution",
    Rules: [
      // Priority 0: Rate limit aggressive IPs
      {
        Name: "RateLimitPerIP",
        Priority: 0,
        Statement: {
          RateBasedStatement: {
            Limit: 2000, // requests per 5-minute window
            AggregateKeyType: "IP",
          },
        },
        Action: { Block: {} },
        VisibilityConfig: {
          SampledRequestsEnabled: true,
          CloudWatchMetricsEnabled: true,
          MetricName: "RateLimitPerIP",
        },
      },
      // Priority 1: AWS core managed rules (SQLi, XSS, bad inputs)
      {
        Name: "AWSManagedRulesCommonRuleSet",
        Priority: 1,
        OverrideAction: { None: {} }, // use managed group's own actions
        Statement: {
          ManagedRuleGroupStatement: {
            VendorName: "AWS",
            Name: "AWSManagedRulesCommonRuleSet",
          },
        },
        VisibilityConfig: {
          SampledRequestsEnabled: true,
          CloudWatchMetricsEnabled: true,
          MetricName: "AWSManagedRulesCommonRuleSet",
        },
      },
      // Priority 2: Known bad inputs (log4j, shellshock, etc.)
      {
        Name: "AWSManagedRulesKnownBadInputsRuleSet",
        Priority: 2,
        OverrideAction: { None: {} },
        Statement: {
          ManagedRuleGroupStatement: {
            VendorName: "AWS",
            Name: "AWSManagedRulesKnownBadInputsRuleSet",
          },
        },
        VisibilityConfig: {
          SampledRequestsEnabled: true,
          CloudWatchMetricsEnabled: true,
          MetricName: "AWSManagedRulesKnownBadInputsRuleSet",
        },
      },
    ],
    VisibilityConfig: {
      SampledRequestsEnabled: true,
      CloudWatchMetricsEnabled: true,
      MetricName: name,
    },
  };

  const response = await wafClient.send(new CreateWebACLCommand(input));
  const webAclArn = response.Summary?.ARN;
  if (!webAclArn) throw new Error("Web ACL creation failed — no ARN returned");
  return webAclArn;
};

// Associate with a CloudFront distribution or ALB
const attachWebACL = async (webAclArn: string, resourceArn: string): Promise<void> => {
  await wafClient.send(
    new AssociateWebACLCommand({
      WebACLArn: webAclArn,
      ResourceArn: resourceArn,
    })
  );
};
```

**Rule evaluation order gotcha:** Rules are evaluated in ascending priority order. Priority 0 is checked first. If a rate-limit rule (priority 0) blocks a request, rules at priority 1 and 2 never run. Design priority order intentionally — put cheap, high-signal rules first (IP blocks, rate limits) before expensive managed rule groups.

## Common Patterns: IP Sets — Allowlists and Blocklists

IP sets are standalone resources you reference from rules. They support IPv4 and IPv6 CIDRs.

```typescript
import {
  WAFV2Client,
  CreateIPSetCommand,
  UpdateIPSetCommand,
  IPAddressVersion,
  Scope,
} from "@aws-sdk/client-wafv2";

const wafClient = new WAFV2Client({ region: "us-east-1" });

// Create a blocklist IP set
const createBlocklist = async (name: string, cidrs: string[]) => {
  const response = await wafClient.send(
    new CreateIPSetCommand({
      Name: name,
      Scope: Scope.CLOUDFRONT,
      IPAddressVersion: IPAddressVersion.IPV4,
      Addresses: cidrs, // e.g., ["192.0.2.0/24", "198.51.100.44/32"]
      Description: "Manual IP blocklist",
    })
  );
  return {
    id: response.Summary?.Id,
    lockToken: response.Summary?.LockToken, // required for updates
  };
};

// Update an existing IP set (lockToken required — prevents concurrent edits)
const updateBlocklist = async (
  id: string,
  name: string,
  lockToken: string,
  cidrs: string[]
) => {
  await wafClient.send(
    new UpdateIPSetCommand({
      Id: id,
      Name: name,
      Scope: Scope.CLOUDFRONT,
      LockToken: lockToken, // get this from GetIPSet before updating
      Addresses: cidrs, // full replacement — not additive
    })
  );
};

// Use IP set in a Web ACL rule (block rule example)
const ipBlockRule = {
  Name: "BlocklistIPs",
  Priority: 0,
  Statement: {
    IPSetReferenceStatement: {
      ARN: "arn:aws:wafv2:us-east-1:123456789012:global/ipset/blocklist/abc-123",
    },
  },
  Action: { Block: {} },
  VisibilityConfig: {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: "BlocklistIPs",
  },
};

// Allowlist pattern: default action = Block, allowlist rule = Allow
// This inverts the model — only listed IPs get through
const allowlistRule = {
  Name: "AllowlistedIPs",
  Priority: 0,
  Statement: {
    IPSetReferenceStatement: {
      ARN: "arn:aws:wafv2:us-east-1:123456789012:global/ipset/allowlist/xyz-456",
    },
  },
  Action: { Allow: {} },
  // Set Web ACL DefaultAction to Block{} to enforce allowlist-only access
  VisibilityConfig: {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: "AllowlistedIPs",
  },
};
```

**LockToken:** Every mutable WAF resource (IP sets, regex sets, rule groups, Web ACLs) uses optimistic locking. You must pass the current `LockToken` when updating. Always call `GetIPSet` immediately before `UpdateIPSet` to get the fresh token — don't cache it.

**Update semantics:** `UpdateIPSetCommand` replaces the entire address list. To add IPs, fetch the current list, append, then push the full list back. There is no "add one IP" API.

## Common Patterns: Rate-Based Rules and Geo-Blocking

Rate-based rules are evaluated over a rolling 5-minute window. WAF tracks per-IP (or per forwarded IP) request counts and applies the action once the threshold is crossed.

```typescript
// Rate limit with forwarded IP (for apps behind a proxy/CDN)
const rateLimitForwardedIP = {
  Name: "RateLimitForwardedIP",
  Priority: 1,
  Statement: {
    RateBasedStatement: {
      Limit: 1000, // max requests per IP per 5 minutes
      AggregateKeyType: "FORWARDED_IP",
      ForwardedIPConfig: {
        HeaderName: "X-Forwarded-For",
        FallbackBehavior: "MATCH", // treat requests without the header as matching (block them)
      },
    },
  },
  Action: { Block: {} },
  VisibilityConfig: {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: "RateLimitForwardedIP",
  },
};

// Rate limit only on specific path (API endpoint protection)
const rateLimitLoginEndpoint = {
  Name: "RateLimitLoginEndpoint",
  Priority: 2,
  Statement: {
    RateBasedStatement: {
      Limit: 20, // only 20 login attempts per IP per 5 minutes
      AggregateKeyType: "IP",
      ScopeDownStatement: {
        ByteMatchStatement: {
          SearchString: Buffer.from("/api/auth/login"),
          FieldToMatch: { UriPath: {} },
          TextTransformations: [{ Priority: 0, Type: "LOWERCASE" }],
          PositionalConstraint: "STARTS_WITH",
        },
      },
    },
  },
  Action: { Block: {} },
  VisibilityConfig: {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: "RateLimitLoginEndpoint",
  },
};

// Geo-block: deny traffic from specific countries
const geoBlockRule = {
  Name: "GeoBlockHighRiskCountries",
  Priority: 3,
  Statement: {
    GeoMatchStatement: {
      CountryCodes: ["KP", "IR", "CU", "SY"], // ISO 3166-1 alpha-2
    },
  },
  Action: { Block: {} },
  VisibilityConfig: {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: "GeoBlockHighRiskCountries",
  },
};

// Geo-allow: only allow traffic from specific countries (invert with NOT)
const geoAllowOnlyUSAndCA = {
  Name: "AllowOnlyUSAndCA",
  Priority: 3,
  Statement: {
    NotStatement: {
      Statement: {
        GeoMatchStatement: {
          CountryCodes: ["US", "CA"],
        },
      },
    },
  },
  Action: { Block: {} },
  VisibilityConfig: {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: "AllowOnlyUSAndCA",
  },
};
```

**Rate limit gotcha:** The 5-minute window is rolling but evaluated in real time. There can be slight delays between a threshold being crossed and the block taking effect. WAF does not enforce rate limits to sub-second precision. For extremely sensitive endpoints (OTP submission, password reset), consider additional application-layer rate limiting.

**Forwarded IP gotcha:** When your app is behind CloudFront or an ALB, the actual client IP is in `X-Forwarded-For`. If you use `AggregateKeyType: "IP"` instead of `FORWARDED_IP`, WAF will rate-limit by the CloudFront edge IP — which is shared by thousands of users. Always use `FORWARDED_IP` when behind a proxy.

## Common Patterns: Managed Rule Groups and False Positives

AWS Managed Rule Groups are pre-built rulesets maintained by AWS. They are the fastest path to broad coverage without writing custom rules.

```typescript
// Common managed rule groups and when to use them
const managedRuleGroups = [
  {
    name: "AWSManagedRulesCommonRuleSet",
    vendor: "AWS",
    cost: "$1/month",
    covers: "Core OWASP rules — SQLi, XSS, bad request patterns, size restrictions",
    useWhen: "Always — this is the baseline for every web app",
  },
  {
    name: "AWSManagedRulesKnownBadInputsRuleSet",
    vendor: "AWS",
    cost: "$1/month",
    covers: "Log4SHELL, Spring4Shell, SSRF patterns, path traversal",
    useWhen: "Always — low false positive rate, high value",
  },
  {
    name: "AWSManagedRulesSQLiRuleSet",
    vendor: "AWS",
    cost: "$1/month",
    covers: "SQL injection patterns — more aggressive than CommonRuleSet SQLi rules",
    useWhen: "Apps with database-backed endpoints that accept user input",
  },
  {
    name: "AWSManagedRulesAmazonIpReputationList",
    vendor: "AWS",
    cost: "$1/month",
    covers: "IPs associated with bots, scrapers, and known attackers",
    useWhen: "Production apps — blocks a lot of noise for minimal cost",
  },
  {
    name: "AWSManagedRulesBotControlRuleSet",
    vendor: "AWS",
    cost: "$10/month + $1/million requests",
    covers: "Browser fingerprinting, bot signatures, crawler detection",
    useWhen: "E-commerce, content sites, APIs with scraping concerns",
  },
];

// Handling false positives: override specific rules to Count instead of Block
const commonRuleSetWithOverrides = {
  Name: "AWSManagedRulesCommonRuleSet",
  Priority: 1,
  OverrideAction: { None: {} }, // respect the managed group's actions
  Statement: {
    ManagedRuleGroupStatement: {
      VendorName: "AWS",
      Name: "AWSManagedRulesCommonRuleSet",
      // Override specific rules that cause false positives
      RuleActionOverrides: [
        {
          Name: "SizeRestrictions_BODY",
          ActionToUse: { Count: {} }, // count instead of block — investigate before blocking
        },
        {
          Name: "CrossSiteScripting_BODY",
          ActionToUse: { Count: {} }, // rich text editors often trigger this
        },
      ],
    },
  },
  VisibilityConfig: {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: "AWSManagedRulesCommonRuleSet",
  },
};
```

**False positive workflow:**
1. Deploy new managed rule group in Count-only mode first (`OverrideAction: { Count: {} }` on the rule itself)
2. Monitor CloudWatch metrics and sampled requests for 1-2 weeks in production traffic
3. Identify rules generating high count volume against legitimate traffic
4. Switch the rule group to `OverrideAction: { None: {} }` but add `RuleActionOverrides` to keep specific false-positive rules in Count mode
5. Investigate and fix false positives at the application level (e.g., encode output properly) or write exclusions

**Common false positives by rule group:**
- `SizeRestrictions_BODY` — file upload endpoints, rich text editors with large payloads
- `CrossSiteScripting_BODY` — WYSIWYG editors that submit HTML content
- `GenericRFI_BODY` — apps that accept URLs as parameters (link shorteners, feed readers)
- Bot Control — legitimate bots your business needs (Googlebot, monitoring tools)

## Common Patterns: Logging, Monitoring, and Alerts

WAF logs every evaluated request (when enabled) to S3, CloudWatch Logs, or Kinesis Data Firehose. Without logging, you are flying blind.

```typescript
import {
  WAFV2Client,
  PutLoggingConfigurationCommand,
  GetSampledRequestsCommand,
  Scope,
} from "@aws-sdk/client-wafv2";

const wafClient = new WAFV2Client({ region: "us-east-1" });

// Enable full request logging to CloudWatch Logs
const enableLogging = async (webAclArn: string, logGroupArn: string) => {
  await wafClient.send(
    new PutLoggingConfigurationCommand({
      LoggingConfiguration: {
        ResourceArn: webAclArn,
        LogDestinationConfigs: [logGroupArn],
        // Redact sensitive fields from logs
        RedactedFields: [
          { SingleHeader: { Name: "authorization" } },
          { SingleHeader: { Name: "cookie" } },
        ],
        // Filter to only log blocked requests (reduces cost)
        LoggingFilter: {
          DefaultBehavior: "DROP",
          Filters: [
            {
              Behavior: "KEEP",
              Requirement: "MEETS_ANY",
              Conditions: [
                { ActionCondition: { Action: "BLOCK" } },
                { ActionCondition: { Action: "COUNT" } },
              ],
            },
          ],
        },
      },
    })
  );
};

// Get sampled requests for a specific rule (debugging)
const getSampledRequests = async (webAclArn: string, ruleName: string) => {
  const response = await wafClient.send(
    new GetSampledRequestsCommand({
      WebAclArn: webAclArn,
      RuleMetricName: ruleName,
      Scope: Scope.CLOUDFRONT,
      TimeWindow: {
        StartTime: new Date(Date.now() - 3600 * 1000), // last hour
        EndTime: new Date(),
      },
      MaxItems: 100,
    })
  );
  return response.SampledRequests;
};
```

**Essential CloudWatch metrics to alarm on:**
- `BlockedRequests` — sudden spike indicates active attack or new false positive rule
- `CountedRequests` — rising count on a managed rule may precede a decision to block
- `AllowedRequests` — unexpected drops may indicate WAF is blocking legitimate traffic
- Rule-specific metrics — each rule emits its own metric using the `MetricName` you set

**CloudWatch Alarm example (CLI):**
```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "WAF-BlockedRequests-Spike" \
  --namespace "AWS/WAFV2" \
  --metric-name "BlockedRequests" \
  --dimensions Name=WebACL,Value=my-web-acl Name=Region,Value=us-east-1 Name=Rule,Value=ALL \
  --statistic Sum \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 1000 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:us-east-1:123456789012:waf-alerts
```

**Logging cost gotcha:** Full request logging for a high-traffic application can generate significant CloudWatch Logs costs. Use `LoggingFilter` to log only blocked/counted requests in production unless debugging. S3 logging is cheaper for archival; CloudWatch is better for real-time alerting.

## Gotchas & Operational Patterns

**Deployment region (the most common mistake):**
WAF for CloudFront must be in `us-east-1`. The AWS SDK client must be instantiated with `region: "us-east-1"` regardless of where your application runs. WAF for ALB/API Gateway must match the resource's region. Creating a WAF in the wrong region will succeed but association will fail with a cryptic error.

```typescript
// CloudFront WAF — always us-east-1
const cloudfrontWAF = new WAFV2Client({ region: "us-east-1" });

// Regional WAF — match your ALB/API Gateway region
const regionalWAF = new WAFV2Client({ region: "ap-southeast-1" });
```

**Rule capacity units (WCU):** Each rule type costs WCU. A Web ACL has a hard limit of 1,500 WCU. Rate-based rules cost 2 WCU, managed rule groups vary (CommonRuleSet is 700 WCU). You can run out of capacity before running out of rules. Check WCU consumption when adding rule groups.

```bash
# Check WCU consumption of your Web ACL
aws wafv2 check-capacity \
  --scope CLOUDFRONT \
  --rules file://rules.json \
  --region us-east-1
```

**Testing without blocking:** Before going live with a new Web ACL, deploy rules in Count mode (`Action: { Count: {} }` on rate/IP rules, `OverrideAction: { Count: {} }` on managed groups). Monitor sampled requests for a week. Switch to Block only after validating no legitimate traffic is affected.

**CDK pattern for WAF + CloudFront:**
```typescript
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { Stack, StackProps } from "aws-cdk-lib";

// WAF stack must be in us-east-1
class WAFStack extends Stack {
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, { ...props, env: { region: "us-east-1" } });

    const webAcl = new wafv2.CfnWebACL(this, "WebACL", {
      defaultAction: { allow: {} },
      scope: "CLOUDFRONT",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "WebACL",
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSet",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    this.webAclArn = webAcl.attrArn;
  }
}

// CloudFront stack (any region) references WAF ARN cross-stack
class CDNStack extends Stack {
  constructor(scope: Construct, id: string, webAclArn: string, props?: StackProps) {
    super(scope, id, props);

    new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: { origin: /* your origin */ },
      webAclId: webAclArn, // WAF association
    });
  }
}
```

**Shield Advanced enrollment:**
```bash
# Enroll in Shield Advanced (irreversible — $3,000/month commitment, 1-year term)
aws shield create-subscription

# Add a resource to Shield Advanced protection
aws shield create-protection \
  --name "Production CloudFront" \
  --resource-arn arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE

# List current protections
aws shield list-protections
```

Shield Advanced enrollment is irreversible within the commitment period. Once subscribed, you cannot cancel mid-term. Evaluate carefully — most applications are adequately protected by Shield Standard (free) plus WAF. Shield Advanced is primarily valuable for: financial services or e-commerce with SLA requirements during attacks, applications that could face massive scaling bills from volumetric DDoS, or teams that want direct access to AWS DDoS response engineers.

**Debugging a blocked request:**
1. Check CloudWatch sampled requests in the WAF console — it shows which rule matched
2. Use `GetSampledRequestsCommand` programmatically to pull match details
3. Enable full request logging temporarily to capture complete headers/URI for analysis
4. Use the WAF testing feature in the console to evaluate a specific request against your ACL without live traffic
5. Override the matching rule to Count mode to stop the block while investigating

**Automation pattern — dynamic IP blocking from application events:**
```typescript
// Application detects abuse → adds IP to WAF blocklist automatically
import { WAFV2Client, GetIPSetCommand, UpdateIPSetCommand } from "@aws-sdk/client-wafv2";

const blockAbusiveIP = async (ipAddress: string, ipSetId: string, ipSetName: string) => {
  const client = new WAFV2Client({ region: "us-east-1" });

  // Always fetch current state and lockToken before updating
  const current = await client.send(
    new GetIPSetCommand({ Id: ipSetId, Name: ipSetName, Scope: "CLOUDFRONT" })
  );

  const existingAddresses = current.IPSet?.Addresses ?? [];
  const cidr = `${ipAddress}/32`;

  if (existingAddresses.includes(cidr)) return; // already blocked

  await client.send(
    new UpdateIPSetCommand({
      Id: ipSetId,
      Name: ipSetName,
      Scope: "CLOUDFRONT",
      LockToken: current.LockToken!, // required
      Addresses: [...existingAddresses, cidr],
    })
  );
};
```

This pattern works well when your application detects credential stuffing, account takeovers, or other abuse signals that WAF alone cannot see. The app adds the IP to the WAF blocklist via SDK, cutting off the attacker at the network edge for all subsequent requests.

## Official Documentation

| Resource | URL |
|---|---|
| AWS WAF Developer Guide | https://docs.aws.amazon.com/waf/latest/developerguide/ |
| AWS Shield Developer Guide | https://docs.aws.amazon.com/waf/latest/developerguide/shield-chapter.html |
| WAF Managed Rule Groups | https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html |
| AWS SDK v3 — WAFV2Client | https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/wafv2/ |
| WAF Pricing | https://aws.amazon.com/waf/pricing/ |
| Shield Pricing | https://aws.amazon.com/shield/pricing/ |
