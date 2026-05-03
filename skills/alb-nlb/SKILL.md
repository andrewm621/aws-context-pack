---
name: alb-nlb
description: Elastic Load Balancing guidance — ALB, NLB, target groups, health checks, SSL termination, path-based routing. Use when configuring load balancers for web applications or services.
metadata:
  priority: 4
  docs:
    - "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/"
  pathPatterns:
    - 'loadbalancer/**'
    - 'lb/**'
  bashPatterns:
    - '\baws\s+elbv2\b'
  importPatterns:
    - "@aws-sdk/client-elastic-load-balancing-v2"
    - "aws-cdk-lib/aws-elasticloadbalancingv2"
  promptSignals:
    phrases:
      - "alb"
      - "nlb"
      - "load balancer"
      - "target group"
      - "application load balancer"
      - "network load balancer"
      - "health check"
      - "ssl termination"
---

# Elastic Load Balancing — ALB and NLB

## What It Is & When to Use It

AWS Elastic Load Balancing (ELB) distributes incoming traffic across multiple targets. There are two modern load balancer types — Application Load Balancer (ALB) and Network Load Balancer (NLB). The Classic Load Balancer (CLB) is legacy and should not be used for new workloads.

**Application Load Balancer (ALB)** — Layer 7, HTTP/HTTPS/gRPC aware. Routes based on URL path, host header, query string, HTTP method, and source IP. Terminates SSL/TLS. Integrates with AWS WAF, Cognito, Lambda, and ECS natively. The default choice for web applications and REST/GraphQL APIs.

**Network Load Balancer (NLB)** — Layer 4, TCP/UDP/TLS. Preserves the client source IP. Assigns static IP addresses per AZ (optionally Elastic IPs). Handles millions of requests per second with sub-millisecond latency. Required when you need static IPs for allowlisting, non-HTTP protocols, or extreme throughput.

**Use ALB when:**
- Serving HTTP/HTTPS web traffic, REST APIs, or GraphQL
- You need path-based routing (`/api/*` → service A, `/static/*` → service B)
- You need host-based routing (`api.example.com` vs `app.example.com`)
- Integrating with AWS WAF for bot protection or rate limiting
- Authenticating users via Cognito or OIDC at the load balancer layer
- Routing to Lambda functions as targets
- Using ECS or Fargate with blue/green deployments via CodeDeploy

**Use NLB when:**
- You need a static IP address (for DNS allowlisting, firewall rules, or customer requirements)
- You need to handle TCP/UDP protocols (database proxying, game servers, IoT MQTT, DNS)
- You need TLS passthrough (encrypt traffic end-to-end without terminating at the load balancer)
- Ultra-low latency is required (sub-millisecond vs ALB's ~1ms overhead)
- You need to handle millions of requests per second (NLB scales to 10M+ RPS; ALB scales well but at higher cost per LCU)
- You're a target behind an ALB and need to preserve source IPs (NLB → ALB chaining)

**When both work:** Either can front ECS Fargate, EC2, or IP targets. ALB is generally simpler to operate for HTTP workloads. NLB adds complexity (no request-level routing, no WAF integration) that is only justified by the specific requirements above.


## Service Surface

### Pricing (us-east-1, verified 2025)

Both load balancer types have identical base hourly costs but different capacity unit pricing.

| Component | ALB | NLB |
|-----------|-----|-----|
| **Hourly rate** | $0.0225/hour (~$16.20/month) | $0.0225/hour (~$16.20/month) |
| **Capacity units** | LCU — $0.008/LCU-hour | NLCU — $0.006/NLCU-hour |
| **Minimum cost** | ~$16/month if idle | ~$16/month if idle |

**ALB LCU** — you pay for the highest of: new connections (25/s per LCU), active connections (3,000 per LCU), processed bytes (1 GB/hour per LCU for EC2/IP targets, 0.4 GB/hour for Lambda), or rule evaluations (1,000/s per LCU).

**NLB NLCU** — charged per dimension: new TCP connections (800/s), active TCP connections (100,000), processed bytes (1 GB/hour), new UDP flows (400/s), active UDP flows (50,000).

**Key cost insight:** Both load balancers cost ~$16/month minimum even with zero traffic. An idle ALB for a dev environment still costs $16/month. Shared ALBs with multiple services via path-based routing reduce this cost — one ALB can serve dozens of services using listener rules.

### Key Limits

| Limit | ALB | NLB |
|-------|-----|-----|
| Listeners per load balancer | 50 | 50 |
| Rules per listener | 100 | N/A (NLB listeners route by port only) |
| Target groups per load balancer | 100 | 100 |
| Targets per target group | 1,000 | 500 |
| AZs per load balancer | All enabled AZs | All enabled AZs |
| Cross-zone load balancing | Enabled by default (free) | Disabled by default (costs extra) |
| SSL certificates per HTTPS listener | 25 (via SNI) | 25 (via SNI) |

### Target Types

| Type | ALB | NLB | Use When |
|------|-----|-----|----------|
| **Instance** | Yes | Yes | EC2 instances registered by instance ID |
| **IP** | Yes | Yes | ECS Fargate tasks, containers with awsvpc, on-premises via Direct Connect/VPN |
| **Lambda** | Yes | No | Serverless backends behind HTTP routing |
| **ALB** | No | Yes | NLB in front of ALB — preserves static IPs while using ALB features |


## Mental Model

### The Four-Layer Stack

```
Internet / Client
        ↓
Load Balancer (ALB or NLB)
  ├── Listener (port 80 / 443 / TCP 3306)
  │     └── Rules (ALB only — match by path, host, header)
  │           └── Action → Target Group
  └── Target Group
        ├── Health Check (per target group)
        └── Targets (EC2 / IP / Lambda / ALB)
```

Every load balancer consists of:

**1. Load Balancer** — The front door. Has DNS name (`my-alb-1234.us-east-1.elb.amazonaws.com`), security groups (ALB only), and AZ configuration. You never interact with individual nodes — AWS manages horizontal scaling automatically.

**2. Listener** — Binds to a port and protocol. An HTTPS listener holds the SSL certificate. You can have multiple listeners on one load balancer (e.g., port 80 and 443 on the same ALB). NLB listeners route all matching traffic to one target group. ALB listeners evaluate rules.

**3. Rules (ALB only)** — Ordered match conditions evaluated top-down. Each rule has conditions (path pattern, host header, HTTP header, query string, source IP, HTTP method) and an action (forward to target group, redirect, return fixed response, authenticate via Cognito/OIDC). The default rule (lowest priority, always matches) catches unmatched requests. Rules are evaluated every request — keep them simple.

**4. Target Group** — A pool of targets with a health check. The load balancer only routes to targets that pass the health check. Target groups decouple routing from capacity — you can drain a target group, update it, and re-attach without touching the load balancer or listeners.

### Health Checks

Health checks run against every registered target independently. The load balancer marks a target healthy or unhealthy based on consecutive successes/failures. Traffic is only sent to healthy targets.

| Setting | Default | Recommendation |
|---------|---------|---------------|
| Protocol | HTTP (ALB), TCP (NLB) | Use HTTP for ALB, TCP or HTTPS for NLB |
| Path | `/` | Use a dedicated `/health` endpoint |
| Interval | 30s | 15–30s for most apps |
| Timeout | 5s | Must be < Interval |
| Healthy threshold | 5 successes | 2–3 is usually sufficient |
| Unhealthy threshold | 2 failures | 2–3 |
| Success codes (ALB) | 200 | Narrow to `200` unless your health endpoint returns other codes |

**Dedicated health endpoints** should: return 200 quickly (< 2s), check database connectivity if your app is useless without it, not require authentication, and be cheap to invoke (no business logic). Returning 200 for a partially broken app causes traffic to pile into a broken target.

### SSL/TLS Termination

**ALB** terminates SSL at the load balancer. Traffic between ALB and targets is unencrypted HTTP by default (acceptable within a VPC; encrypt for compliance requirements). ALB supports SNI — one HTTPS listener can serve multiple certificates for multiple domains. Use ACM (AWS Certificate Manager) for free, auto-renewing certificates.

**NLB** can either terminate TLS (NLB-managed, similar to ALB) or do TLS passthrough — forwarding the encrypted connection directly to the target so the target decrypts it. Passthrough is useful when you need end-to-end encryption that you control (e.g., mutual TLS with client certificates the NLB can't see).

### Cross-Zone Load Balancing

**ALB:** Always enabled, no extra charge. Traffic from each AZ's load balancer nodes is distributed evenly across all healthy targets in all AZs. The effective result: traffic distributes evenly regardless of how many targets are in each AZ.

**NLB:** Disabled by default, and costs extra when enabled ($0.01/GB cross-AZ data transfer). When disabled, each AZ's NLB node only routes to targets in that AZ. This means uneven target distribution across AZs causes traffic imbalance. Best practice: keep equal target counts across AZs, or enable cross-zone load balancing and pay the data transfer cost.


## Common Patterns

### Pattern 1: ALB with HTTPS, Path-Based Routing, and HTTP Redirect (CDK)

The canonical ALB configuration for a web application — HTTPS with ACM certificate, HTTP → HTTPS redirect, and multiple services behind path-based rules.

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

export class AlbStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly httpsListener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });

    // Security group: allow inbound 80 and 443 from internet
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB security group',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      // Enable deletion protection in production
      // deletionProtection: true,
    });

    // HTTP → HTTPS redirect
    this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({ port: '443', protocol: 'HTTPS', permanent: true }),
    });

    // ACM certificate (must be same region as ALB; us-east-1 for CloudFront)
    const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: 'example.com' });
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: 'app.example.com',
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // HTTPS listener — terminates SSL, evaluates rules
    this.httpsListener = this.alb.addListener('HttpsListener', {
      port: 443,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'application/json',
        messageBody: JSON.stringify({ error: 'Not found' }),
      }),
    });

    // Target group for the API service (IP type for ECS Fargate/awsvpc)
    const apiTargetGroup = new elbv2.ApplicationTargetGroup(this, 'ApiTg', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      // Deregistration delay — how long to wait for in-flight requests
      // before removing a draining target. Reduce for faster deployments.
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // Target group for the web frontend
    const webTargetGroup = new elbv2.ApplicationTargetGroup(this, 'WebTg', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Path-based routing rules — evaluated in priority order (lower number = higher priority)
    this.httpsListener.addTargetGroups('ApiRule', {
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/*', '/api']),
      ],
      targetGroups: [apiTargetGroup],
    });

    // Host-based routing — route api.example.com to API targets
    this.httpsListener.addTargetGroups('ApiHostRule', {
      priority: 5,
      conditions: [
        elbv2.ListenerCondition.hostHeaders(['api.example.com']),
      ],
      targetGroups: [apiTargetGroup],
    });

    // Default: route app.example.com (and everything else) to web frontend
    this.httpsListener.addTargetGroups('WebRule', {
      priority: 100,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/*']),
      ],
      targetGroups: [webTargetGroup],
    });

    // DNS alias record for the ALB
    new route53.ARecord(this, 'AlbDns', {
      zone: hostedZone,
      recordName: 'app',
      target: route53.RecordTarget.fromAlias(
        new route53targets.LoadBalancerTarget(this.alb)
      ),
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
    });
  }
}
```

### Pattern 2: NLB with Static Elastic IPs

Use NLB with Elastic IPs when customers need to allowlist specific IPs in their firewall rules.

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export class NlbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: false });

    // Allocate Elastic IPs — one per AZ
    // These IPs are fixed and can be shared with customers for allowlisting
    const eipA = new ec2.CfnEIP(this, 'EipA', { domain: 'vpc' });
    const eipB = new ec2.CfnEIP(this, 'EipB', { domain: 'vpc' });

    // NLB does not use security groups — control access via NACLs or target security groups
    const nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
      vpc,
      internetFacing: true,
      // Assign Elastic IPs per subnet/AZ for static IPs
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      crossZoneEnabled: false, // Disabled by default — costs extra when enabled
    });

    // TCP target group — NLB routes Layer 4, no HTTP awareness
    const tcpTargetGroup = new elbv2.NetworkTargetGroup(this, 'TcpTg', {
      vpc,
      port: 443,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      // NLB health checks can be TCP (connection check) or HTTP/HTTPS
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
        path: '/health',
        port: '8080', // Can health-check on a different port than traffic
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
      },
      // Connection termination — closes connections immediately on deregistration
      // (NLB default is to let connections drain; set to true for faster deploys)
      connectionTermination: true,
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // TLS listener — NLB terminates TLS, forwards plain TCP to targets
    nlb.addListener('TlsListener', {
      port: 443,
      protocol: elbv2.Protocol.TLS,
      certificates: [
        elbv2.ListenerCertificate.fromArn(
          'arn:aws:acm:us-east-1:123456789012:certificate/abc-123'
        ),
      ],
      defaultTargetGroups: [tcpTargetGroup],
      // Preserve client source IP (NLB default; ALB requires X-Forwarded-For)
      // sslPolicy: elbv2.SslPolicy.TLS13_RES, // Restrict to TLS 1.3
    });

    // TCP passthrough listener — encrypted traffic goes straight to target
    const passthroughTargetGroup = new elbv2.NetworkTargetGroup(this, 'PassthroughTg', {
      vpc,
      port: 8443,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        interval: cdk.Duration.seconds(30),
      },
    });

    nlb.addListener('PassthroughListener', {
      port: 8443,
      protocol: elbv2.Protocol.TCP, // TCP passthrough — NLB does not decrypt
      defaultTargetGroups: [passthroughTargetGroup],
    });

    new cdk.CfnOutput(this, 'NlbDnsName', {
      value: nlb.loadBalancerDnsName,
    });
  }
}
```

### Pattern 3: AWS SDK v3 — Programmatic Target Group Management

Use these when you need to register/deregister targets programmatically (e.g., on EC2 Auto Scaling events, custom deployment scripts, or dynamic backend registration).

```typescript
import {
  ElasticLoadBalancingV2Client,
  DescribeTargetHealthCommand,
  RegisterTargetsCommand,
  DeregisterTargetsCommand,
  DescribeTargetGroupsCommand,
  ModifyTargetGroupAttributesCommand,
  TargetHealthStateEnum,
} from '@aws-sdk/client-elastic-load-balancing-v2';

const elbv2 = new ElasticLoadBalancingV2Client({ region: 'us-east-1' });

// Check health of all targets in a target group
export async function getTargetHealth(targetGroupArn: string) {
  const response = await elbv2.send(new DescribeTargetHealthCommand({
    TargetGroupArn: targetGroupArn,
  }));

  const healthy = response.TargetHealthDescriptions?.filter(
    t => t.TargetHealth?.State === TargetHealthStateEnum.HEALTHY
  ) ?? [];

  const unhealthy = response.TargetHealthDescriptions?.filter(
    t => t.TargetHealth?.State !== TargetHealthStateEnum.HEALTHY
  ) ?? [];

  return { healthy, unhealthy, all: response.TargetHealthDescriptions ?? [] };
}

// Register new IP targets (e.g., ECS Fargate task IPs)
export async function registerIpTargets(
  targetGroupArn: string,
  targets: Array<{ ip: string; port: number }>
) {
  await elbv2.send(new RegisterTargetsCommand({
    TargetGroupArn: targetGroupArn,
    Targets: targets.map(t => ({
      Id: t.ip,    // IP address for IP target type
      Port: t.port,
    })),
  }));
}

// Graceful deregistration — waits for connections to drain before removing target
export async function drainAndDeregister(
  targetGroupArn: string,
  targetId: string,
  port: number,
  pollIntervalMs = 5000,
  timeoutMs = 120_000,
): Promise<void> {
  // Initiate deregistration — target enters 'draining' state
  await elbv2.send(new DeregisterTargetsCommand({
    TargetGroupArn: targetGroupArn,
    Targets: [{ Id: targetId, Port: port }],
  }));

  const deadline = Date.now() + timeoutMs;

  // Poll until target is fully deregistered (no longer appears in health results)
  while (Date.now() < deadline) {
    const response = await elbv2.send(new DescribeTargetHealthCommand({
      TargetGroupArn: targetGroupArn,
      Targets: [{ Id: targetId, Port: port }],
    }));

    const state = response.TargetHealthDescriptions?.[0]?.TargetHealth?.State;

    if (!state || state === TargetHealthStateEnum.UNUSED) {
      return; // Target successfully deregistered
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timed out waiting for target ${targetId}:${port} to deregister`);
}

// Enable slow-start mode — ramp up new targets gradually to avoid overwhelm
export async function enableSlowStart(
  targetGroupArn: string,
  rampDurationSeconds = 60,
) {
  await elbv2.send(new ModifyTargetGroupAttributesCommand({
    TargetGroupArn: targetGroupArn,
    Attributes: [
      {
        Key: 'slow_start.duration_seconds',
        Value: String(rampDurationSeconds), // 30–900 seconds
      },
    ],
  }));
}

// Enable sticky sessions (ALB only) — routes a client to the same target
export async function enableStickySessions(
  targetGroupArn: string,
  durationSeconds = 86400, // 24 hours
) {
  await elbv2.send(new ModifyTargetGroupAttributesCommand({
    TargetGroupArn: targetGroupArn,
    Attributes: [
      { Key: 'stickiness.enabled', Value: 'true' },
      { Key: 'stickiness.type', Value: 'lb_cookie' },
      { Key: 'stickiness.lb_cookie.duration_seconds', Value: String(durationSeconds) },
    ],
  }));
}
```

### Pattern 4: ALB Cognito Authentication (Offload Auth to the Load Balancer)

ALB can authenticate users via Cognito User Pool or any OIDC provider before forwarding requests to your backend. The backend receives the user's identity in HTTP headers — no auth code in your app.

```typescript
import * as cdk from 'aws-cdk-lib';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';

// Assuming an existing ALB HTTPS listener and target group
declare const httpsListener: elbv2.ApplicationListener;
declare const appTargetGroup: elbv2.ApplicationTargetGroup;

const userPool = new cognito.UserPool(this, 'UserPool', {
  selfSignUpEnabled: false,
  signInAliases: { email: true },
});

const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
  userPool,
  generateSecret: true, // Required for ALB authentication
  oAuth: {
    flows: { authorizationCodeGrant: true },
    scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
    callbackUrls: ['https://app.example.com/oauth2/idpresponse'],
  },
});

const userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
  userPool,
  cognitoDomain: { domainPrefix: 'my-app-auth' },
});

// Add authenticated route — ALB handles the Cognito redirect flow
httpsListener.addTargetGroups('AuthenticatedApp', {
  priority: 10,
  conditions: [elbv2.ListenerCondition.pathPatterns(['/app/*'])],
  // Authenticate action: redirect to Cognito, then forward to target group on success
  // The backend receives X-Amzn-Oidc-Identity, X-Amzn-Oidc-Accesstoken, X-Amzn-Oidc-Data headers
  action: elbv2.ListenerAction.authenticateCognito({
    userPool,
    userPoolClient,
    userPoolDomain,
    next: elbv2.ListenerAction.forward([appTargetGroup]),
    // 'deny' returns 401 for unauthenticated requests (good for APIs)
    // 'authenticate' (default) redirects to Cognito login
    onUnauthenticatedRequest: elbv2.UnauthenticatedAction.AUTHENTICATE,
    sessionCookieName: 'AWSELBAuthSessionCookie',
    sessionTimeout: cdk.Duration.days(7),
  }),
  targetGroups: [appTargetGroup],
});
```


## Gotchas

### 1. Idle ALBs and NLBs Cost ~$16/Month Each

Both ALB and NLB charge $0.0225/hour regardless of traffic. An ALB standing up in dev/staging 24/7 that receives no traffic costs ~$16/month. At scale, a common mistake is creating one load balancer per service instead of sharing one ALB across multiple services via path-based or host-based routing.

**Mitigation:** Use a single ALB with multiple listener rules for dev/staging environments. A single ALB can route to dozens of services. Consider tearing down dev load balancers outside business hours using scheduled Lambda functions or using DNS-based routing (Route 53) to toggle services on/off without ALB cost.

### 2. Cross-Zone Load Balancing Costs Extra on NLB (Not ALB)

ALB cross-zone load balancing is always enabled and free — traffic from any AZ is distributed across all healthy targets. NLB cross-zone load balancing is disabled by default, and when enabled costs $0.01/GB for cross-AZ data transfer.

If you have 3 AZ NLB nodes and unevenly distributed targets (e.g., 8 targets in us-east-1a, 2 in us-east-1b), cross-zone must be enabled to balance traffic properly — but this adds cost for a high-throughput NLB. The alternative is maintaining equal target counts per AZ so each NLB node has a fair share.

### 3. Health Check Grace Period vs. Deregistration Delay Are Different Settings

**Health check grace period** (`healthCheckGracePeriodSeconds` on ECS Service): How long ECS waits after a task starts before the ALB begins health checking it. Prevents the ALB from killing newly-launched tasks that haven't finished starting. Defaults to 0 — must be set explicitly for slow-starting containers. Set to 1.5x your observed startup time.

**Deregistration delay** (`deregistrationDelay` on the target group, default 300s): How long the ALB keeps sending traffic to a target after it is deregistered (starts draining). Too short = in-flight requests get cut off. Too long = deployments are slow because old tasks wait 5 minutes before terminating.

For most web applications: `deregistrationDelay` = 30–60s is sufficient. The default 300s (5 minutes) is conservatively long.

### 4. ALB Security Groups — Inbound from Internet, Outbound to Targets

ALB requires a security group (NLB does not use security groups). Two common mistakes:

1. **Missing outbound rule**: The ALB security group needs outbound rules allowing traffic to your targets' security groups on the target port. The default outbound "allow all" works but violates least-privilege. Explicitly allow outbound to the target security group.

2. **Target security group missing ALB inbound rule**: Your EC2/ECS target's security group must allow inbound traffic from the ALB security group. Forgetting this causes mysterious "504 Gateway Timeout" errors where the ALB can't reach any targets.

```typescript
// Correct security group wiring in CDK
const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc });
const appSg = new ec2.SecurityGroup(this, 'AppSg', { vpc });

// ALB accepts internet traffic
albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

// ALB can reach app on port 3000
albSg.addEgressRule(appSg, ec2.Port.tcp(3000));

// App accepts traffic from ALB only (not open to internet)
appSg.addIngressRule(albSg, ec2.Port.tcp(3000));
```

### 5. NLB Preserves Source IP — Targets Must Allow Client IPs

NLB forwards the original client IP to targets (the target sees the actual internet IP, not the NLB's IP). This means your target's security group or application-level IP allowlist must permit client IP ranges — you cannot restrict to just the NLB's IP address like you can with ALB.

For ALB: targets see the ALB's IP; real client IP is in `X-Forwarded-For` header.
For NLB: targets see the actual client IP directly in the TCP/IP layer.

This also means NLB targets behind strict VPC security groups need to allow traffic from `0.0.0.0/0` or the expected client CIDR range, which can be a security concern. For internet-facing NLBs, target security groups typically need to allow `0.0.0.0/0` on the target port (the NLB itself is the security boundary).

### 6. Slow-Start Mode Prevents New Targets from Being Overwhelmed

By default, when a new target is registered and passes health checks, the load balancer immediately sends it its full fair share of traffic. For applications with JVM warm-up, connection pool initialization, or cache warming, the sudden traffic burst can cause high latency or errors.

Enable slow-start mode (ALB only): the target receives a linearly increasing share of traffic over the slow-start duration (30–900 seconds). After the period ends, it receives its full share.

```bash
aws elbv2 modify-target-group-attributes \
  --target-group-arn arn:aws:elasticloadbalancing:... \
  --attributes Key=slow_start.duration_seconds,Value=60
```

Do not use slow-start with weighted target groups (used in blue/green deployments) — they conflict.

### 7. Sticky Sessions Break Even Distribution and Should Be Avoided if Possible

ALB sticky sessions (lb_cookie or app_cookie) pin a user's requests to a specific target for the duration of the cookie. This defeats load balancing — if one target becomes slow or overloaded, users pinned to it are stuck on it.

Better alternatives:
- Store session state in ElastiCache (Redis) or DynamoDB — any target can handle any user
- Use JWT tokens — stateless authentication requires no server-side session
- Use application-level affinity (route by user ID via consistent hashing in your app)

When sticky sessions are unavoidable (legacy apps, WebSocket long-polling), set the shortest viable duration and monitor target load distribution for imbalance.

### 8. ALB Access Logs Are Not Enabled by Default

ALB access logs capture every request (including rejected ones) with timing, target response, and error codes. They are off by default. Enable them for production workloads — they're essential for debugging 5xx errors, slow response patterns, and unexpected client behavior.

Access logs go to S3. The S3 bucket must have a bucket policy allowing the ELB service account to write. Cost: S3 storage at $0.023/GB; ALB logging itself is free.

```typescript
const logBucket = new s3.Bucket(this, 'AlbLogsBucket', {
  lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
});

const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', { /* ... */ });
alb.logAccessLogs(logBucket, 'alb-logs');
```

### 9. Weighted Routing for Canary Deployments (ALB Only)

ALB supports weighted target groups on a single rule — forward X% to target group A and Y% to target group B. This enables canary deployments without CodeDeploy.

```typescript
// 90% to stable v1, 10% to new v2
httpsListener.addAction('WeightedRoute', {
  priority: 10,
  conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*'])],
  action: elbv2.ListenerAction.weightedForward([
    { targetGroup: stableTargetGroup, weight: 9 },
    { targetGroup: canaryTargetGroup, weight: 1 },
  ]),
});
```

Weights are relative, not percentages — `{ weight: 9 }` and `{ weight: 1 }` means ~90%/10% split. Update weights via CDK re-deploy or the SDK to shift traffic incrementally. When canary looks healthy, set stable weight to 0 to drain it.

### 10. Connection Draining Applies During Deregistration, Not Scale-In

When a target is deregistered (explicitly, or due to failing health checks), ALB stops sending new requests but keeps the connection open for in-flight requests up to the deregistration delay timeout. This is "connection draining."

When a target fails health checks without being explicitly deregistered — it was just unhealthy — ALB immediately stops sending new requests (no draining period). In-flight requests already routed to that target are not retried. Plan your application error handling accordingly.

For zero-downtime deployments, always deregister targets explicitly (via SDK or deployment tooling) before stopping your application process, and wait for draining to complete before terminating.


## Official Documentation

- **ALB Developer Guide:** https://docs.aws.amazon.com/elasticloadbalancing/latest/application/
- **NLB Developer Guide:** https://docs.aws.amazon.com/elasticloadbalancing/latest/network/
- **ELB Pricing:** https://aws.amazon.com/elasticloadbalancing/pricing/
- **ALB Listener Rules:** https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-update-rules.html
- **ALB Authenticate Users with Cognito:** https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html
- **Target Group Health Checks:** https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html
- **Sticky Sessions:** https://docs.aws.amazon.com/elasticloadbalancing/latest/application/sticky-sessions.html
- **Slow-Start Mode:** https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html#slow-start-mode
- **Cross-Zone Load Balancing:** https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html#cross-zone-load-balancing
- **ALB Access Logs:** https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-access-logs.html
- **ALB Weighted Target Groups:** https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html#target-group-routing-algorithm
- **AWS SDK v3 ELBv2 Client:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/elastic-load-balancing-v2/
- **CDK aws-elasticloadbalancingv2 Reference:** https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_elasticloadbalancingv2-readme.html
