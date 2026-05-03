---
name: vpc
description: Amazon VPC guidance — networking, subnets, security groups, NAT gateway costs, VPC endpoints, peering. Use when configuring networking, debugging connectivity, or optimizing network costs.
metadata:
  priority: 7
  docs:
    - "https://docs.aws.amazon.com/vpc/latest/userguide/"
  pathPatterns:
    - 'vpc/**'
    - 'network/**'
    - 'networking/**'
  bashPatterns:
    - '\baws\s+ec2\s+(describe-vpcs|create-vpc|describe-subnets|describe-security-groups|describe-nat-gateways)\b'
    - '\baws\s+ec2\s+describe-vpc-endpoints\b'
  importPatterns:
    - "@aws-sdk/client-ec2"
  promptSignals:
    phrases:
      - "vpc"
      - "subnet"
      - "security group"
      - "nat gateway"
      - "vpc endpoint"
      - "vpc peering"
      - "private subnet"
      - "public subnet"
      - "network acl"
      - "transit gateway"
      - "cidr block"
---

# Amazon VPC

## What It Is & When to Use It

Amazon Virtual Private Cloud (VPC) is the networking foundation for AWS. Every resource that needs an IP address (EC2, RDS, ECS, Lambda in VPC mode, etc.) lives in a VPC. VPC provides network isolation, routing control, and security. You must understand VPC to deploy anything beyond serverless in AWS.

## Service Surface

| Component | Description | Cost |
|-----------|-------------|------|
| **VPC** | Isolated virtual network | Free |
| **Subnet** | IP range within a VPC + AZ | Free |
| **Route Table** | Routing rules for subnets | Free |
| **Internet Gateway** | VPC ↔ internet | Free |
| **NAT Gateway** | Private subnet → internet (outbound only) | **$0.045/hr + $0.045/GB** |
| **NAT Instance** | Self-managed NAT on EC2 | EC2 cost only |
| **VPC Endpoint (Gateway)** | Free access to S3 + DynamoDB | **Free** |
| **VPC Endpoint (Interface)** | Private access to AWS services | $0.01/hr + $0.01/GB |
| **VPC Peering** | VPC-to-VPC connectivity | Data transfer only |
| **Transit Gateway** | Hub-and-spoke multi-VPC | $0.05/hr + $0.02/GB |
| **Security Group** | Stateful firewall (instance level) | Free |
| **Network ACL** | Stateless firewall (subnet level) | Free |

| Limit | Value |
|-------|-------|
| **VPCs per region** | 5 (soft, requestable to 100+) |
| **Subnets per VPC** | 200 |
| **Security groups per VPC** | 2,500 |
| **Rules per security group** | 60 inbound + 60 outbound |
| **CIDR blocks per VPC** | 5 (primary + 4 secondary) |

## Mental Model

1. **The 3-tier subnet pattern**:
   - **Public subnet**: Has route to Internet Gateway. For ALBs, NAT Gateways, bastion hosts.
   - **Private subnet**: Routes to NAT Gateway for outbound internet. For application servers, Lambda, ECS tasks.
   - **Isolated subnet**: No internet route at all. For databases, internal services. Uses VPC endpoints for AWS services.

2. **Security Groups vs NACLs**:
   - **Security Groups**: Stateful (return traffic automatically allowed), allow rules only, attached to ENIs (instances). **Use for almost everything.**
   - **NACLs**: Stateless (must allow both directions), allow AND deny rules, attached to subnets. Use sparingly for subnet-level blocking.

3. **NAT Gateway is the #1 surprise cost**: $32.40/month just for running + $0.045/GB processed. A single NAT Gateway processing 100 GB/month = $36.90/month. Multi-AZ pattern (one per AZ) multiplies this. **Always use VPC Gateway Endpoints for S3 and DynamoDB (free).**

4. **VPC Endpoints eliminate NAT for AWS services**: Gateway endpoints (S3, DynamoDB) are free and route traffic privately. Interface endpoints (all other services) cost $0.01/hr but avoid NAT Gateway data processing charges.

5. **Multi-AZ is required for production**: Deploy subnets in at least 2 AZs. ALBs require 2+ AZ subnets. RDS Multi-AZ is a different feature (standby replica). ECS Fargate tasks should spread across AZs.

## Common Patterns

### Standard 3-Tier VPC (CDK)
```typescript
import { Vpc, SubnetType } from 'aws-cdk-lib/aws-ec2';

const vpc = new Vpc(this, 'AppVpc', {
  maxAzs: 2,
  natGateways: 1, // Cost optimization: 1 NAT instead of per-AZ
  subnetConfiguration: [
    { name: 'Public', subnetType: SubnetType.PUBLIC, cidrMask: 24 },
    { name: 'Private', subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
    { name: 'Isolated', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
  // Free VPC endpoints for S3 and DynamoDB
  gatewayEndpoints: {
    S3: { service: GatewayVpcEndpointAwsService.S3 },
    DynamoDB: { service: GatewayVpcEndpointAwsService.DYNAMODB },
  },
});
```

### Security Group for Common Patterns
```typescript
import { SecurityGroup, Port, Peer } from 'aws-cdk-lib/aws-ec2';

// ALB security group — public internet access
const albSg = new SecurityGroup(this, 'AlbSg', { vpc });
albSg.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS from internet');

// App security group — only from ALB
const appSg = new SecurityGroup(this, 'AppSg', { vpc });
appSg.addIngressRule(albSg, Port.tcp(8080), 'From ALB only');

// DB security group — only from app
const dbSg = new SecurityGroup(this, 'DbSg', { vpc });
dbSg.addIngressRule(appSg, Port.tcp(5432), 'Postgres from app only');
```

## Gotchas

1. **NAT Gateway cost**: #1 AWS bill surprise. At $32.40/month base + $0.045/GB, it easily costs $100+/month. Mitigations: use VPC Gateway Endpoints (free for S3/DynamoDB), use 1 NAT Gateway instead of per-AZ (trades availability for cost), use NAT instances for dev.

2. **VPC Gateway Endpoints are free — use them**: S3 and DynamoDB Gateway Endpoints cost nothing and keep traffic off NAT. If your Lambda/ECS talks to S3 or DynamoDB, this alone can save hundreds per month.

3. **Security Groups are stateful, NACLs are not**: If you allow inbound port 443 in a Security Group, return traffic is automatically allowed. With NACLs, you must explicitly allow the ephemeral return port range (1024-65535).

4. **CIDR planning matters**: VPC CIDRs can't overlap if you want peering or Transit Gateway. Plan ahead: use /16 for production VPCs, /20 for dev. Reserve ranges for future VPCs.

5. **Cross-AZ data transfer costs $0.01/GB each way**: Traffic between AZs is $0.02/GB round-trip. For high-throughput services, keep communicating services in the same AZ when possible.

6. **Lambda VPC mode**: Lambda in a VPC uses Hyperplane ENIs (fast attachment) but still adds ~1-2s on first cold start in a new ENI. Lambda in VPC can't access the internet without a NAT Gateway.

7. **Default VPC exists but don't use it for production**: Every region has a default VPC with public subnets. Fine for experiments, but production workloads need explicit VPC with private subnets.

8. **DNS resolution**: VPC has `enableDnsHostnames` and `enableDnsSupport` settings. Both must be true for VPC endpoints and many AWS service integrations to work.

9. **Security Group rule limits**: 60 rules per direction. If you need more, use prefix lists or reference other security groups instead of listing individual IPs.

10. **Peering is not transitive**: VPC A peers with B, B peers with C — A cannot reach C through B. Use Transit Gateway for hub-and-spoke connectivity.

## Official Documentation

- [VPC User Guide](https://docs.aws.amazon.com/vpc/latest/userguide/)
- [VPC Pricing](https://aws.amazon.com/vpc/pricing/)
- [Security Group Rules Reference](https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules-reference.html)
- [VPC Endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints.html)
