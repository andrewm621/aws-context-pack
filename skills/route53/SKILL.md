---
name: route53
description: Amazon Route 53 guidance — DNS management, hosted zones, routing policies, health checks, domain registration, DNS failover. Use when configuring DNS, domains, or traffic routing.
metadata:
  priority: 5
  docs:
    - "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/"
  pathPatterns:
    - 'dns/**'
    - 'domains/**'
  bashPatterns:
    - '\baws\s+route53\b'
    - '\baws\s+route53domains\b'
  importPatterns:
    - "@aws-sdk/client-route-53"
    - "@aws-sdk/client-route-53-domains"
    - "aws-cdk-lib/aws-route53"
    - "aws-cdk-lib/aws-route53-targets"
  promptSignals:
    phrases:
      - "route 53"
      - "route53"
      - "dns"
      - "hosted zone"
      - "domain name"
      - "dns record"
      - "alias record"
      - "health check"
      - "dns failover"
      - "nameserver"
---

## What It Is & When to Use It

Amazon Route 53 is AWS's highly available, globally distributed DNS service. It handles three distinct jobs that are often used together: **domain registration**, **DNS hosting**, and **health-based traffic routing**.

**Use Route 53 when you need to:**

- Register or transfer a domain name (`.com`, `.io`, `.dev`, etc.) and have AWS manage the registrar relationship
- Host a DNS zone for a domain you own anywhere — not just domains registered through AWS
- Create records that point traffic to AWS resources (CloudFront distributions, ALBs, API Gateways, S3 static sites, etc.) using free alias records
- Route traffic intelligently across regions, availability zones, or endpoints using routing policies
- Implement automatic DNS failover when a primary endpoint goes unhealthy
- Enforce geographic or compliance-based traffic steering (EU traffic stays in EU, etc.)
- Resolve internal hostnames within a VPC without exposing them to the public internet (private hosted zones)

**Do not use Route 53 for:**

- SSL/TLS certificate issuance — use ACM for that (though Route 53 can automate DNS validation)
- Load balancing at the application layer — Route 53 is DNS-level only; use ALB/NLB for L4/L7 routing
- Sub-second failover — DNS TTLs and resolver caching mean DNS failover is measured in seconds to minutes, not milliseconds

---

## Service Surface

### Pricing

| Item | Price |
|---|---|
| Public hosted zone | $0.50/month (first 25 zones) |
| Public hosted zone | $0.10/month (26+ zones) |
| Private hosted zone | $0.50/month |
| Standard DNS queries | $0.40/million |
| Latency-based routing queries | $0.60/million |
| Geo DNS queries | $0.70/million |
| Alias record queries (to AWS resources) | Free |
| Basic health check (30s interval) | $0.50/month/endpoint |
| Fast health check (10s interval) | $1.00/month/endpoint |
| HTTPS health check | $1.00/month/endpoint |
| Calculated health check | $0.50/month/check |
| Domain registration | Varies by TLD ($9–$300+/year) |
| Domain transfer | Same as registration price |

**Cost tip:** Alias records pointing to AWS resources (CloudFront, ALB, S3, API Gateway, etc.) generate zero query charges. Default to alias over CNAME whenever the target is an AWS resource.

---

### DNS Record Types

| Type | Purpose | Notes |
|---|---|---|
| A | IPv4 address | Most common. Can be an alias record. |
| AAAA | IPv6 address | Same as A but for IPv6. Alias supported. |
| CNAME | Canonical name (redirect) | Cannot exist at zone apex. Not free. |
| MX | Mail exchange | Priority + mail server hostname. |
| TXT | Text data | Used for SPF, DKIM, domain verification. |
| NS | Name servers | Delegation record — don't change unless you know what you're doing. |
| SOA | Start of authority | One per zone, auto-created. |
| SRV | Service locator | Protocol, port, hostname for service discovery. |
| CAA | Certificate authority auth | Restricts which CAs can issue certs for your domain. |
| ALIAS | AWS-specific virtual record | Like CNAME but free, works at apex, AWS resources only. |
| PTR | Reverse DNS lookup | IP → hostname. Managed separately via AWS. |

---

### Routing Policies

| Policy | Use Case | Behavior |
|---|---|---|
| Simple | Single endpoint, no routing logic needed | Returns one or multiple values randomly |
| Weighted | A/B testing, canary deploys, gradual migrations | Splits traffic by percentage (weights 0–255) |
| Latency | Multi-region apps, lowest-latency wins | Routes to the region with lowest measured latency from the user |
| Failover | Active/passive disaster recovery | Primary receives all traffic; secondary activates if primary health check fails |
| Geolocation | Regional content, compliance, localization | Routes based on user's geographic location (continent, country, state/US) |
| Geoproximity | Fine-grained geographic control with bias | Routes based on location + bias modifier to expand/shrink a region's coverage |
| Multivalue Answer | Basic client-side load balancing | Returns up to 8 healthy records; clients choose |
| IP-based | ISP or CIDR-based routing | Routes based on originating IP CIDR block |

---

### Key Service Limits (Default)

| Resource | Default Limit |
|---|---|
| Hosted zones per account | 500 (increase via support) |
| Records per hosted zone | 10,000 (increase via support) |
| Health checks per account | 200 |
| Reusable delegation sets | 4 |
| VPC associations per private hosted zone | 100 |
| Traffic policies | 50 |
| Policy records | 5 per hosted zone |

---

## Mental Model

Route 53 has five core primitives. Understanding how they compose is the key to using it correctly.

### 1. Hosted Zone — Your DNS Namespace

A hosted zone is a container for DNS records for a specific domain (e.g., `example.com`). It maps to the NS records that delegation authorities (like your domain registrar) point to.

- **Public hosted zone:** Answers queries from the internet. When you create one, Route 53 assigns 4 name servers — you update your registrar to delegate to those NS records.
- **Private hosted zone:** Answers queries only from within associated VPCs. Useful for internal service discovery (`api.internal`, `db.internal`) without public exposure. Requires `enableDnsHostnames` and `enableDnsSupport` enabled on the VPC.
- **One zone, multiple records:** A single hosted zone holds all the records for that domain and all subdomains you manage (unless you delegate subdomains separately).
- **Costs start immediately:** You're billed $0.50/month from the moment a zone exists, even with zero traffic.

### 2. Alias Records — AWS's Superpower

The ALIAS record is a Route 53 extension that behaves like a CNAME but with critical advantages:

- **Works at the zone apex.** You cannot have a CNAME for `example.com` itself (only for `www.example.com`) — this is a DNS spec limitation. Alias records have no such restriction.
- **Zero query cost.** Route 53 does not charge for queries to alias records pointing at AWS resources.
- **Automatically follows target.** If a CloudFront distribution's IP changes (it does), your alias record updates instantly without any action from you.
- **Targets:** CloudFront distributions, ALBs, NLBs, API Gateways, S3 website endpoints, Elastic Beanstalk, VPC endpoints, Global Accelerator, and other Route 53 records in the same zone.

**Rule:** If the target is an AWS resource, always use an alias record. Never use a CNAME for AWS resources.

### 3. Routing Policies — Traffic Steering

Routing policies transform Route 53 from a passive DNS store into an active traffic router. They work by attaching metadata to records with the same name and type:

- **Weighted:** Assign numeric weights. Route 53 returns records proportionally. Weight 100 vs weight 0 = 100% to first record. Both at 50 = 50/50 split. Set one weight to 0 to drain traffic without deleting the record.
- **Latency:** Route 53 maintains a latency database from global resolver networks to each AWS region. It routes to whichever region has lowest measured latency — this is not geographic proximity, it's actual measured latency.
- **Failover:** One record marked PRIMARY, one marked SECONDARY. Must attach a health check to PRIMARY. When health check fails, Route 53 serves the SECONDARY record instead.
- **Geolocation:** Explicit location → endpoint mapping. Requires a default record for traffic that doesn't match any location rule. Without a default, unmatched queries return NODATA.
- **Multivalue Answer:** Returns up to 8 records that are currently healthy. Unlike Simple, it integrates with health checks. Clients pick one — it's not real load balancing but helps distribute client-side.

Routing policies only apply within a single hosted zone and record name. They do not span zones.

### 4. Health Checks — The Routing Decision Engine

Health checks are Route 53's mechanism for knowing whether an endpoint is alive. They feed into routing policies to make failover automatic.

- **How they work:** Route 53 has ~15 globally distributed health checking locations. Each polls your endpoint on the configured interval. The endpoint is considered unhealthy when more than 18% of checkers report failure (configurable).
- **Check types:**
  - HTTP/HTTPS: GET request, looks for 2xx/3xx status code
  - TCP: Establishes TCP connection only
  - String match: HTTP/HTTPS + checks response body for a specific string (first 5120 bytes)
  - Calculated: Combines results of child health checks with AND/OR logic
  - CloudWatch alarm: Marks healthy/unhealthy based on a CW alarm state
- **Interval:** Standard is 30 seconds ($0.50/month). Fast is 10 seconds ($1.00/month). Fast health checks enable faster failover at higher cost.
- **Firewall requirement:** Route 53 health checkers have published IP ranges. Your security groups/NACLs must allow inbound from those ranges for the health checks to work. See the Route 53 developer guide for the current IP list (it changes periodically).
- **Calculated health checks:** Combine multiple endpoint health checks into one parent check. Useful for marking a whole service group healthy only if N of M endpoints are healthy.

### 5. TTL — Cache Lifetime and Failover Speed

TTL (Time to Live) is how long recursive resolvers and clients cache your DNS record before re-querying.

- **High TTL (86400s / 24h):** Minimal query cost, but changes take up to a day to fully propagate. Good for stable records.
- **Low TTL (60s):** Changes propagate quickly, but query volume (and cost) increases. Good during active migrations or when planning to change records soon.
- **Alias records:** Do not have a TTL you control. They inherit the TTL of the target resource (CloudFront is typically 60s, ALB is 60s).
- **Failover timing:** Even with a 60s TTL and a 10s health check, actual failover can take 90–120 seconds. Factor this into SLA calculations. Route 53 is not a substitute for application-level redundancy.
- **Recommended pattern:** Lower TTL to 60s before any planned DNS change. After change stabilizes (24–48h), raise TTL back to reduce query costs.

---

## Common Patterns

### Pattern 1: Hosted Zone with Alias Records to CloudFront and ALB

The baseline setup for any web app: a public zone with an apex alias to CloudFront and a `www` CNAME redirecting to the apex.

```typescript
// CDK — TypeScript
import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";

export class DnsStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Look up an existing hosted zone by domain name
    const zone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: "example.com",
    });

    // Or create a new hosted zone (outputs NS records to add to your registrar)
    const newZone = new route53.PublicHostedZone(this, "NewZone", {
      zoneName: "example.com",
    });

    // Alias A record at zone apex pointing to CloudFront
    // fromDistribution() is the preferred target — free queries, auto-updates IPs
    const distribution = cloudfront.Distribution.fromDistributionAttributes(
      this,
      "Dist",
      {
        domainName: "d1234abcd.cloudfront.net",
        distributionId: "EDFDVBD6EXAMPLE",
      }
    );

    new route53.ARecord(this, "ApexAlias", {
      zone,
      recordName: "", // empty string = zone apex (example.com)
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution)
      ),
      ttl: cdk.Duration.seconds(60), // ignored for alias records, but documents intent
      comment: "Apex alias to CloudFront distribution",
    });

    // www subdomain — alias pointing to an ALB
    const alb = elbv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(
      this,
      "ALB",
      {
        loadBalancerArn: "arn:aws:elasticloadbalancing:...",
        securityGroupId: "sg-...",
        loadBalancerDnsName: "my-alb-1234567890.us-east-1.elb.amazonaws.com",
        loadBalancerCanonicalHostedZoneId: "Z35SXDOTRQ7X7K",
      }
    );

    new route53.ARecord(this, "WwwAlias", {
      zone,
      recordName: "www",
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(alb)
      ),
    });

    // TXT record for domain verification (ACM, GSuite, etc.)
    new route53.TxtRecord(this, "DomainVerification", {
      zone,
      recordName: "_acme-challenge",
      values: ["some-verification-token-here"],
      ttl: cdk.Duration.seconds(300),
    });

    // MX records for email routing
    new route53.MxRecord(this, "MailExchange", {
      zone,
      recordName: "", // apex
      values: [
        { hostName: "aspmx.l.google.com.", priority: 1 },
        { hostName: "alt1.aspmx.l.google.com.", priority: 5 },
      ],
    });
  }
}
```

**SDK v3 equivalent for creating a record programmatically:**

```typescript
import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
} from "@aws-sdk/client-route-53";

const client = new Route53Client({ region: "us-east-1" });

// Route 53 is a global service — region is ignored but required by the SDK
// All API calls go to a single global endpoint regardless of region

const command = new ChangeResourceRecordSetsCommand({
  HostedZoneId: "Z1PA6795UKMFR9",
  ChangeBatch: {
    Comment: "Add alias record for apex domain",
    Changes: [
      {
        Action: "UPSERT", // CREATE | DELETE | UPSERT — UPSERT is idempotent
        ResourceRecordSet: {
          Name: "example.com",
          Type: "A",
          AliasTarget: {
            // Alias record — no TTL, no ResourceRecords
            DNSName: "d1234abcd.cloudfront.net",
            EvaluateTargetHealth: false, // true = only return this record if target is healthy
            HostedZoneId: "Z2FDTNDATAQYW2", // CloudFront's canonical hosted zone ID (always this value)
          },
        },
      },
    ],
  },
});

const response = await client.send(command);
console.log("Change submitted:", response.ChangeInfo?.Id);
console.log("Status:", response.ChangeInfo?.Status); // PENDING | INSYNC
```

---

### Pattern 2: Weighted Routing for Canary Deployments

Deploy v2 to a new ALB and route 10% of traffic to it, then ramp up.

```typescript
// CDK
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";

// v1 receives 90% of traffic (weight 90 out of 90+10=100)
new route53.ARecord(this, "ApiV1", {
  zone,
  recordName: "api",
  target: route53.RecordTarget.fromAlias(
    new route53Targets.LoadBalancerTarget(albV1)
  ),
  weight: 90,
  setIdentifier: "v1", // required when using routing policies — must be unique within the record name
  comment: "Production v1 — 90% traffic",
});

// v2 receives 10% of traffic
new route53.ARecord(this, "ApiV2", {
  zone,
  recordName: "api",
  target: route53.RecordTarget.fromAlias(
    new route53Targets.LoadBalancerTarget(albV2)
  ),
  weight: 10,
  setIdentifier: "v2",
  comment: "Canary v2 — 10% traffic",
});

// To drain traffic from v1 without deleting: set weight to 0
// To fully cut over: set v1 weight 0, v2 weight 100
// To roll back: set v1 weight 100, v2 weight 0
```

**SDK v3 — update weights programmatically (e.g., from a deployment script):**

```typescript
import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
} from "@aws-sdk/client-route-53";

const client = new Route53Client({ region: "us-east-1" });
const hostedZoneId = "Z1PA6795UKMFR9";

// Step 1: Read current state before modifying
const listCmd = new ListResourceRecordSetsCommand({
  HostedZoneId: hostedZoneId,
  StartRecordName: "api.example.com",
  StartRecordType: "A",
  MaxItems: 10,
});
const current = await client.send(listCmd);
console.log("Current records:", JSON.stringify(current.ResourceRecordSets, null, 2));

// Step 2: Shift to 50/50 split
const shiftCommand = new ChangeResourceRecordSetsCommand({
  HostedZoneId: hostedZoneId,
  ChangeBatch: {
    Comment: "Canary promotion — shift to 50/50",
    Changes: [
      {
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: "api.example.com",
          Type: "A",
          SetIdentifier: "v1",
          Weight: 50,
          AliasTarget: {
            DNSName: "v1-alb.us-east-1.elb.amazonaws.com",
            EvaluateTargetHealth: true,
            HostedZoneId: "Z35SXDOTRQ7X7K", // ALB hosted zone ID (region-specific)
          },
        },
      },
      {
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: "api.example.com",
          Type: "A",
          SetIdentifier: "v2",
          Weight: 50,
          AliasTarget: {
            DNSName: "v2-alb.us-east-1.elb.amazonaws.com",
            EvaluateTargetHealth: true,
            HostedZoneId: "Z35SXDOTRQ7X7K",
          },
        },
      },
    ],
  },
});

await client.send(shiftCommand);
console.log("Traffic shifted to 50/50");
```

---

### Pattern 3: Failover Routing with Health Checks

Active/passive DNS failover. Primary endpoint gets all traffic; secondary activates automatically when primary health check fails.

```typescript
// CDK
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";

// Health check on the primary endpoint
const primaryHealthCheck = new route53.CfnHealthCheck(
  this,
  "PrimaryHealthCheck",
  {
    healthCheckConfig: {
      type: "HTTPS",
      fullyQualifiedDomainName: "primary-alb.us-east-1.elb.amazonaws.com",
      port: 443,
      resourcePath: "/health", // must return 2xx for endpoint to be considered healthy
      requestInterval: 30, // 10 for fast health check (higher cost)
      failureThreshold: 3, // number of consecutive failures before marking unhealthy
      enableSni: true,
    },
    healthCheckTags: [{ key: "Name", value: "primary-endpoint-health" }],
  }
);

// Primary record — receives all traffic when healthy
new route53.CfnRecordSet(this, "PrimaryRecord", {
  hostedZoneId: zone.hostedZoneId,
  name: "api.example.com",
  type: "A",
  setIdentifier: "primary",
  failover: "PRIMARY",
  healthCheckId: primaryHealthCheck.attrHealthCheckId, // required on PRIMARY
  aliasTarget: {
    dnsName: "primary-alb.us-east-1.elb.amazonaws.com",
    evaluateTargetHealth: true,
    hostedZoneId: "Z35SXDOTRQ7X7K",
  },
});

// Secondary record — receives traffic only when primary is unhealthy
// No health check required on SECONDARY (it becomes active by default when primary fails)
new route53.CfnRecordSet(this, "SecondaryRecord", {
  hostedZoneId: zone.hostedZoneId,
  name: "api.example.com",
  type: "A",
  setIdentifier: "secondary",
  failover: "SECONDARY",
  aliasTarget: {
    dnsName: "secondary-alb.us-west-2.elb.amazonaws.com",
    evaluateTargetHealth: true,
    hostedZoneId: "Z1H1FL5HABSF5", // us-west-2 ALB hosted zone ID
  },
});
```

**SDK v3 — create a health check and failover records from scratch:**

```typescript
import {
  Route53Client,
  CreateHealthCheckCommand,
  ChangeResourceRecordSetsCommand,
} from "@aws-sdk/client-route-53";
import { randomUUID } from "crypto";

const client = new Route53Client({ region: "us-east-1" });

// Create the health check first
const healthCheckResult = await client.send(
  new CreateHealthCheckCommand({
    CallerReference: randomUUID(), // unique string — prevents duplicate creation on retry
    HealthCheckConfig: {
      Type: "HTTPS_STR_MATCH",
      FullyQualifiedDomainName: "api.example.com",
      Port: 443,
      ResourcePath: "/health",
      SearchString: '"status":"ok"', // optional: string that must appear in response body
      RequestInterval: 30,
      FailureThreshold: 3,
      EnableSNI: true,
      Regions: [
        // Specify which Route 53 checker regions to use (default: all)
        "us-east-1",
        "eu-west-1",
        "ap-southeast-1",
      ],
    },
  })
);

const healthCheckId = healthCheckResult.HealthCheck?.Id;
console.log("Created health check:", healthCheckId);

// Now create the failover records
await client.send(
  new ChangeResourceRecordSetsCommand({
    HostedZoneId: "Z1PA6795UKMFR9",
    ChangeBatch: {
      Changes: [
        {
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: "api.example.com",
            Type: "A",
            SetIdentifier: "primary-us-east-1",
            Failover: "PRIMARY",
            HealthCheckId: healthCheckId,
            TTL: 60,
            ResourceRecords: [{ Value: "1.2.3.4" }], // or use AliasTarget
          },
        },
        {
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: "api.example.com",
            Type: "A",
            SetIdentifier: "secondary-us-west-2",
            Failover: "SECONDARY",
            TTL: 60,
            ResourceRecords: [{ Value: "5.6.7.8" }],
          },
        },
      ],
    },
  })
);
```

---

### Pattern 4: Domain Registration + Automatic Zone Creation

Register a domain through Route 53 and wire it to a hosted zone automatically — no manual NS copy/paste.

```typescript
// CDK — domain registration is not directly supported as a CDK construct
// Use SDK v3 from a custom resource or a one-time script

import {
  Route53DomainsClient,
  RegisterDomainCommand,
  CheckDomainAvailabilityCommand,
} from "@aws-sdk/client-route-53-domains";
import {
  Route53Client,
  CreateHostedZoneCommand,
  GetHostedZoneCommand,
} from "@aws-sdk/client-route-53";
import { randomUUID } from "crypto";

// Route53Domains is a GLOBAL service — must use us-east-1
const domainsClient = new Route53DomainsClient({ region: "us-east-1" });
const r53Client = new Route53Client({ region: "us-east-1" });

async function registerAndSetupDomain(domainName: string) {
  // Step 1: Check availability
  const availability = await domainsClient.send(
    new CheckDomainAvailabilityCommand({ DomainName: domainName })
  );
  console.log("Availability:", availability.Availability);
  if (availability.Availability !== "AVAILABLE") {
    throw new Error(`Domain ${domainName} is not available`);
  }

  // Step 2: Create hosted zone first (so we have NS records)
  const zoneResult = await r53Client.send(
    new CreateHostedZoneCommand({
      Name: domainName,
      CallerReference: randomUUID(),
      HostedZoneConfig: {
        Comment: `Zone for ${domainName}`,
        PrivateZone: false,
      },
    })
  );

  const hostedZoneId = zoneResult.HostedZone?.Id?.split("/").pop()!;
  const nameServers = zoneResult.DelegationSet?.NameServers ?? [];
  console.log("Created zone:", hostedZoneId);
  console.log("Name servers:", nameServers);

  // Step 3: Register the domain, pointing to our new zone's NS records
  const contactInfo = {
    FirstName: "Andrew",
    LastName: "Miller",
    ContactType: "PERSON" as const,
    OrganizationName: "Rebel Ops",
    AddressLine1: "123 Main St",
    City: "Austin",
    State: "TX",
    CountryCode: "US" as const,
    ZipCode: "78701",
    PhoneNumber: "+1.5125551234",
    Email: "andrew@example.com",
  };

  const registration = await domainsClient.send(
    new RegisterDomainCommand({
      DomainName: domainName,
      DurationInYears: 1,
      AutoRenew: true,
      AdminContact: contactInfo,
      RegistrantContact: contactInfo,
      TechContact: contactInfo,
      PrivacyProtectAdminContact: true, // hide contact info from WHOIS
      PrivacyProtectRegistrantContact: true,
      PrivacyProtectTechContact: true,
      // Route 53 will automatically use the NS records from your hosted zone
      // when the domain is registered through Route 53 — no manual NS update needed
    })
  );

  console.log("Registration operation ID:", registration.OperationId);
  // Registration is async — check status via GetOperationDetail
  // Typically completes within minutes for common TLDs

  return { hostedZoneId, nameServers, operationId: registration.OperationId };
}
```

---

## Gotchas

**1. CNAME records cannot exist at the zone apex.**
The DNS specification (RFC 1912) prohibits CNAME records at the zone apex (`example.com`). Many services hand you a CNAME to point at their infrastructure — if they do, you cannot use that CNAME at your naked domain. Use Route 53 alias records instead. Alias records are exempt from this restriction, are free, and serve the same purpose for AWS resources.

**2. EvaluateTargetHealth on alias records is disabled by default — and that matters.**
When `EvaluateTargetHealth` is false, Route 53 serves the alias record even if the underlying target (CloudFront, ALB, etc.) is unhealthy. Set it to `true` on failover configurations so Route 53 skips unhealthy alias targets when building its response.

**3. The Route 53 Domains service is always us-east-1.**
The `@aws-sdk/client-route-53-domains` client must be instantiated with `region: "us-east-1"`. It does not matter which region your infrastructure lives in — domain registration is a global control plane API that only operates out of us-east-1. Setting any other region causes confusing errors.

**4. Health checkers need inbound access through your security groups.**
Route 53's distributed health checking fleet has published IP ranges (in the AWS IP range JSON published at `https://ip-ranges.amazonaws.com/ip-ranges.json` — filter by `"service": "ROUTE53_HEALTHCHECKS"`). Your EC2 instances, ALB security groups, or WAF rules must allow inbound HTTP/HTTPS/TCP from these ranges. If you block them, your endpoint will appear unhealthy even when it's working fine.

**5. NS TTL is 172800 seconds (48 hours) by default.**
When you update your registrar's delegation to point to Route 53 name servers, the old NS records can remain cached at recursive resolvers for up to 48 hours. Factor this into migrations. Lower the TTL on existing NS records well before cutover if your current registrar supports it.

**6. Alias records inherit the target's TTL — you cannot override it.**
When you create an alias record, the `TTL` field is ignored. The TTL clients see is whatever the target service publishes (CloudFront = 60s, ALB = 60s). You cannot increase it to reduce query costs. Design accordingly.

**7. Private hosted zones require specific VPC settings to be enabled.**
VPCs must have both `enableDnsHostnames` and `enableDnsSupport` set to `true` for private hosted zone resolution to work. In CDK, these default to false for VPCs you create (unless you enable them) and to true for the default VPC. Missing these settings causes silent DNS resolution failures inside the VPC.

**8. Geolocation routing requires a default record or unmatched queries return NODATA.**
If you create geolocation records for specific countries/continents but a user's IP doesn't match any rule, Route 53 returns NODATA (not NXDOMAIN). The result is an empty DNS response — the request fails silently. Always create a default geolocation record (continent: `*` or equivalent) as a catch-all.

**9. Deleting a hosted zone requires deleting all non-default records first.**
Route 53 will refuse to delete a hosted zone if it contains any records other than the auto-created NS and SOA records. You must delete all custom records first. CDK and CloudFormation handle this in the correct order automatically during stack deletion. Manual deletion via console or SDK requires iterating and deleting records first.

**10. DNSSEC requires careful key management — one mistake causes full DNS outage.**
Route 53 supports DNSSEC signing for public hosted zones. Enabling it requires generating a key-signing key (KSK) in AWS KMS (must be in us-east-1 regardless of zone region), activating DNSSEC signing in Route 53, and adding a DS record at your registrar. If the DS record at your registrar exists but your KSK expires or is deleted, DNSSEC-validating resolvers will refuse to resolve your domain entirely. Plan key rotation carefully. DNSSEC is not enabled by default and should be approached as an advanced configuration.

**11. Split-horizon DNS: one public zone + one private zone with the same name.**
You can have a public hosted zone and a private hosted zone for the same domain name. Inside associated VPCs, Route 53 Resolver returns private zone records. Outside, public zone records are returned. This is the standard pattern for internal endpoints that shadow public DNS. The two zones are completely independent — changes to one do not affect the other.

**12. Propagation delay ≠ TTL.**
Changes to Route 53 records propagate to Route 53's authoritative name servers within ~60 seconds (usually faster). But downstream resolvers only pick up those changes when their cached TTL expires. A record with a 24h TTL will serve the old value to cached resolvers for up to 24h even after you've made the change. The fix is to lower TTL ahead of planned changes, not to expect instant propagation.

**13. Traffic policies have a hard limit of 5 policy records per hosted zone.**
Traffic policies (the GUI-based visual routing editor) are limited to 5 policy records per hosted zone by default. This is a lower limit than most people expect. If you need more complex routing, use standard weighted/failover/latency records instead of traffic policies — they have much higher limits.

**14. Route 53 change batches are atomic.**
A `ChangeResourceRecordSets` call with multiple changes in the `ChangeBatch` is applied atomically. Either all changes succeed or none do. This is useful for atomic cutover (delete old record, create new record in one call) but means a single invalid record in a batch fails the entire batch.

---

## Official Documentation

| Resource | URL |
|---|---|
| Route 53 Developer Guide | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/ |
| DNS Record Types | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/ResourceRecordTypes.html |
| Routing Policies | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html |
| Alias Records | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-choosing-alias-non-alias.html |
| Health Checks | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover.html |
| Health Checker IP Ranges | https://ip-ranges.amazonaws.com/ip-ranges.json |
| Pricing | https://aws.amazon.com/route53/pricing/ |
| ALB Hosted Zone IDs by Region | https://docs.aws.amazon.com/general/latest/gr/elb.html |
| Route 53 SDK v3 — client-route-53 | https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/route-53/ |
| Route 53 SDK v3 — client-route-53-domains | https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/route-53-domains/ |
| CDK Route53 Constructs | https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_route53-readme.html |
| CDK Route53 Targets | https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_route53_targets-readme.html |
| DNSSEC in Route 53 | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-configuring-dnssec.html |
| Private Hosted Zones | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/hosted-zones-private.html |
| Domain Registration Guide | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/registrar.html |
