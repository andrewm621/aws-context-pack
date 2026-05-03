---
name: cloudformation
description: AWS CloudFormation guidance — infrastructure as code with YAML/JSON templates, stacks, change sets, nested stacks, stack sets, drift detection. Use when working with CloudFormation templates directly (not via CDK).
metadata:
  priority: 5
  docs:
    - "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/"
  pathPatterns:
    - 'template.yaml'
    - 'template.yml'
    - 'template.json'
    - 'cloudformation/**'
    - 'cfn/**'
    - '**/*.template.yaml'
    - '**/*.template.yml'
    - '**/*.template.json'
  bashPatterns:
    - '\baws\s+cloudformation\b'
    - '\baws\s+cfn\b'
    - '\brain\s+'
  importPatterns:
    - "@aws-sdk/client-cloudformation"
  promptSignals:
    phrases:
      - "cloudformation"
      - "cfn template"
      - "cloudformation stack"
      - "change set"
      - "nested stack"
      - "stack set"
      - "cfn"
      - "cloudformation drift"
      - "sam template"
      - "rain"
---

## What It Is & When to Use It

CloudFormation is AWS's native infrastructure-as-code service. You write declarative YAML or JSON templates describing the resources you want, submit them to CloudFormation, and the service handles provisioning, updating, and tearing down those resources in dependency order.

**Use CloudFormation directly when:**
- Your team or organization mandates YAML/JSON templates (policy, audit, or tooling reasons)
- You are maintaining or extending existing CloudFormation stacks
- You are writing SAM (Serverless Application Model) templates — SAM is a CloudFormation Transform
- Your stack is simple enough that the overhead of CDK is not justified
- You need to import existing AWS resources under CloudFormation management
- You are deploying multi-account infrastructure via StackSets

**Prefer CDK instead when:**
- Starting a new project with complex conditional logic
- You want type safety, IDE autocompletion, and reusable constructs in a real programming language
- You are generating CloudFormation but do not want to maintain raw YAML
- You need to compose many stacks with shared abstractions

**SAM relationship:** SAM templates are CloudFormation templates with `Transform: AWS::Serverless-2016-10-31`. The SAM CLI (`sam build`, `sam deploy`) transforms SAM syntax into standard CloudFormation before deploying. All CloudFormation concepts apply.

**rain relationship:** `rain` is a community CLI that wraps `aws cloudformation` with better UX — progress display, diff output, and simpler deploy commands. It is a drop-in replacement for most CloudFormation CLI workflows.

---

## Service Surface

### Pricing

| Item | Cost |
|---|---|
| CloudFormation itself | Free |
| What you pay for | The AWS resources the template creates |
| Handler operations (registry extensions) | $0.0009 per handler operation above the free tier |
| Free tier for handlers | 1,000 handler operations per month |

CloudFormation has no per-stack, per-template, or per-deployment charges. You pay only for the EC2 instances, S3 buckets, RDS clusters, and other resources the template provisions.

### Key Service Limits

| Limit | Default |
|---|---|
| Resources per stack | 500 |
| Stacks per account per region | 2,000 (was 200; increased 2024) |
| Template body size (inline) | 51,200 bytes |
| Template body size (from S3) | 1 MB |
| Parameters per template | 200 |
| Outputs per template | 200 |
| Mappings per template | 200 |
| Conditions per template | 200 |
| Nested stack depth | 5 levels |
| StackSets per account | 100 (soft limit) |
| Stack instances per StackSet | 2,000 |

Most limits except resource count and template size are soft and can be raised via a Support request.

### Template Top-Level Sections

| Section | Required | Purpose |
|---|---|---|
| `AWSTemplateFormatVersion` | No | Always `"2010-09-09"` — the only valid value |
| `Description` | No | Human-readable description (max 1,024 chars) |
| `Metadata` | No | Arbitrary metadata; used by the console for parameter grouping |
| `Parameters` | No | Runtime inputs; referenced with `!Ref` |
| `Mappings` | No | Static lookup tables; accessed with `Fn::FindInMap` |
| `Conditions` | No | Boolean flags derived from parameters; used to conditionally create resources |
| `Transform` | No | Macros to run (`AWS::Serverless-2016-10-31` for SAM, `AWS::LanguageExtensions`) |
| `Resources` | **Yes** | The only required section; defines every AWS resource |
| `Outputs` | No | Values exported for cross-stack references or CLI display |

### Key CLI Tools

| Tool | Install | Purpose |
|---|---|---|
| `aws cloudformation` | AWS CLI | Standard CloudFormation API access |
| `rain` | `brew install rain` | Faster deploys, better diffs, built-in S3 upload |
| `cfn-lint` | `pip install cfn-lint` | Template validation beyond what CloudFormation checks |
| `sam` | `brew install aws-sam-cli` | SAM-specific build, local invoke, and deploy |
| `taskcat` | `pip install taskcat` | Multi-region integration testing of templates |
| `cfn-guard` | `brew install cfn-guard` | Policy-as-code validation using Guard rules |
| `checkov` | `pip install checkov` | Security scanning of CloudFormation templates |

---

## Mental Model

CloudFormation has five core primitives. Everything else is a detail of one of these five.

### 1. Template — Desired State

A template is a YAML or JSON document that says "I want these resources in this configuration." It is not a script; there are no loops (without macros), no conditionals in the procedural sense, and no imperative API calls. CloudFormation reads the template and figures out what API calls to make.

Templates are reusable. The same template can be deployed as a `staging` stack and a `production` stack by passing different parameter values.

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: Example template

Parameters:
  Environment:
    Type: String
    AllowedValues: [dev, staging, prod]
    Default: dev

Resources:
  MyBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "my-app-${Environment}-${AWS::AccountId}"
      VersioningConfiguration:
        Status: Enabled
```

### 2. Stack — Running Instance

A stack is a deployed instance of a template. Creating a stack provisions all the resources. Deleting a stack (by default) deletes all the resources. Updating a stack applies only the diff.

Stacks are the unit of lifecycle management. Resources inside a stack cannot be selectively deleted — you update or delete the whole stack.

### 3. Change Sets — Preview Before Apply

A change set shows you exactly what CloudFormation will do before it does it. It lists every resource that will be Added, Modified, or Removed, and for modifications it shows whether the change is an in-place update or a replacement (which destroys and recreates the resource).

**Always use change sets for production updates.** Surprises in change sets are far better than surprises in production.

```
Action     LogicalId        ResourceType              Replacement
------     ---------        ------------              -----------
Add        WebACL           AWS::WAFv2::WebACL        N/A
Modify     ApiGateway       AWS::ApiGateway::RestApi  False
Remove     OldLambda        AWS::Lambda::Function     N/A
```

### 4. Drift Detection — Actual vs. Template State

Drift detection compares the live state of your resources against what the template says they should be. Resources modified outside CloudFormation (via the console, CLI, or another tool) show as "DRIFTED."

Drift detection does not fix drift — it only reports it. To remediate, either update the template to match reality or update the resource to match the template, then re-deploy.

### 5. Intrinsic Functions — The Templating Layer

Intrinsic functions are how you connect resources and inject dynamic values inside a template.

| Function | Shorthand | Purpose |
|---|---|---|
| `Ref` | `!Ref` | Reference a parameter or resource's primary identifier (ARN, name, ID — varies by resource type) |
| `Fn::Sub` | `!Sub` | String interpolation: `!Sub "arn:aws:s3:::${BucketName}"` |
| `Fn::GetAtt` | `!GetAtt` | Get a specific attribute of a resource: `!GetAtt MyBucket.Arn` |
| `Fn::If` | `!If` | Conditional value: `!If [IsProd, prod-value, dev-value]` |
| `Fn::Join` | `!Join` | Join a list with a delimiter |
| `Fn::Select` | `!Select` | Pick one item from a list by index |
| `Fn::ImportValue` | (no shorthand) | Import an Output exported by another stack |
| `Fn::FindInMap` | `!FindInMap` | Lookup a value in a Mappings table |
| `Fn::Split` | `!Split` | Split a string into a list |
| `Fn::Base64` | `!Base64` | Base64-encode a value (used for EC2 UserData) |

---

## Common Patterns

### Pattern 1: VPC with Public and Private Subnets

Foundational networking template. Every non-trivial deployment starts here.

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: VPC with public and private subnets across two AZs

Parameters:
  VpcCidr:
    Type: String
    Default: "10.0.0.0/16"
  Environment:
    Type: String
    Default: dev

Resources:
  VPC:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: !Ref VpcCidr
      EnableDnsHostnames: true
      EnableDnsSupport: true
      Tags:
        - Key: Name
          Value: !Sub "${Environment}-vpc"

  InternetGateway:
    Type: AWS::EC2::InternetGateway
    Properties:
      Tags:
        - Key: Name
          Value: !Sub "${Environment}-igw"

  VPCGatewayAttachment:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: !Ref VPC
      InternetGatewayId: !Ref InternetGateway

  PublicSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: "10.0.1.0/24"
      AvailabilityZone: !Select [0, !GetAZs ""]
      MapPublicIpOnLaunch: true
      Tags:
        - Key: Name
          Value: !Sub "${Environment}-public-a"

  PublicSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: "10.0.2.0/24"
      AvailabilityZone: !Select [1, !GetAZs ""]
      MapPublicIpOnLaunch: true
      Tags:
        - Key: Name
          Value: !Sub "${Environment}-public-b"

  PrivateSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: "10.0.11.0/24"
      AvailabilityZone: !Select [0, !GetAZs ""]
      Tags:
        - Key: Name
          Value: !Sub "${Environment}-private-a"

  PrivateSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: "10.0.12.0/24"
      AvailabilityZone: !Select [1, !GetAZs ""]
      Tags:
        - Key: Name
          Value: !Sub "${Environment}-private-b"

  PublicRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref VPC

  PublicRoute:
    Type: AWS::EC2::Route
    DependsOn: VPCGatewayAttachment
    Properties:
      RouteTableId: !Ref PublicRouteTable
      DestinationCidrBlock: "0.0.0.0/0"
      GatewayId: !Ref InternetGateway

  PublicSubnetARouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PublicSubnetA
      RouteTableId: !Ref PublicRouteTable

  PublicSubnetBRouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PublicSubnetB
      RouteTableId: !Ref PublicRouteTable

  AppSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Security group for application tier
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 443
          ToPort: 443
          CidrIp: "0.0.0.0/0"
        - IpProtocol: tcp
          FromPort: 80
          ToPort: 80
          CidrIp: "0.0.0.0/0"
      SecurityGroupEgress:
        - IpProtocol: "-1"
          CidrIp: "0.0.0.0/0"

Outputs:
  VpcId:
    Value: !Ref VPC
    Export:
      Name: !Sub "${Environment}-VpcId"

  PublicSubnetIds:
    Value: !Join [",", [!Ref PublicSubnetA, !Ref PublicSubnetB]]
    Export:
      Name: !Sub "${Environment}-PublicSubnetIds"

  PrivateSubnetIds:
    Value: !Join [",", [!Ref PrivateSubnetA, !Ref PrivateSubnetB]]
    Export:
      Name: !Sub "${Environment}-PrivateSubnetIds"

  AppSecurityGroupId:
    Value: !Ref AppSecurityGroup
    Export:
      Name: !Sub "${Environment}-AppSecurityGroupId"
```

### Pattern 2: Lambda Function with API Gateway (SAM Transform)

SAM simplifies Lambda + API Gateway boilerplate significantly. The `Transform` directive activates SAM's macro.

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Description: Serverless API using SAM

Globals:
  Function:
    Runtime: nodejs22.x
    Timeout: 30
    MemorySize: 256
    Environment:
      Variables:
        NODE_ENV: !Ref Environment

Parameters:
  Environment:
    Type: String
    Default: dev

Resources:
  ApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: dist/index.handler
      CodeUri: ./dist
      Description: Main API handler
      Policies:
        - AWSLambdaBasicExecutionRole
        - Version: "2012-10-17"
          Statement:
            - Effect: Allow
              Action:
                - dynamodb:GetItem
                - dynamodb:PutItem
                - dynamodb:UpdateItem
                - dynamodb:Query
              Resource: !GetAtt DataTable.Arn
      Events:
        ApiEvent:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /{proxy+}
            Method: ANY

  HttpApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      StageName: !Ref Environment
      CorsConfiguration:
        AllowOrigins:
          - "https://myapp.com"
        AllowHeaders:
          - Content-Type
          - Authorization
        AllowMethods:
          - GET
          - POST
          - PUT
          - DELETE
          - OPTIONS

  DataTable:
    Type: AWS::DynamoDB::Table
    DeletionPolicy: Retain
    Properties:
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: pk
          AttributeType: S
        - AttributeName: sk
          AttributeType: S
      KeySchema:
        - AttributeName: pk
          KeyType: HASH
        - AttributeName: sk
          KeyType: RANGE

Outputs:
  ApiUrl:
    Value: !Sub "https://${HttpApi}.execute-api.${AWS::Region}.amazonaws.com/${Environment}"
  FunctionArn:
    Value: !GetAtt ApiFunction.Arn
```

**Deploy with SAM:**
```bash
sam build
sam deploy --guided  # first time, generates samconfig.toml
sam deploy           # subsequent deploys use samconfig.toml
```

### Pattern 3: Nested Stacks for Modular Architecture

Nested stacks let you split a large template into composable modules. The parent stack references child templates stored in S3.

```yaml
# parent-stack.yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: Parent stack that composes nested stacks

Parameters:
  Environment:
    Type: String
    Default: dev
  TemplatesBucketUrl:
    Type: String
    Description: S3 URL prefix where nested templates are stored

Resources:
  NetworkStack:
    Type: AWS::CloudFormation::Stack
    Properties:
      TemplateURL: !Sub "${TemplatesBucketUrl}/network.yaml"
      Parameters:
        Environment: !Ref Environment
      TimeoutInMinutes: 15

  DatabaseStack:
    Type: AWS::CloudFormation::Stack
    DependsOn: NetworkStack
    Properties:
      TemplateURL: !Sub "${TemplatesBucketUrl}/database.yaml"
      Parameters:
        Environment: !Ref Environment
        VpcId: !GetAtt NetworkStack.Outputs.VpcId
        SubnetIds: !GetAtt NetworkStack.Outputs.PrivateSubnetIds
      TimeoutInMinutes: 30

  ApplicationStack:
    Type: AWS::CloudFormation::Stack
    DependsOn: DatabaseStack
    Properties:
      TemplateURL: !Sub "${TemplatesBucketUrl}/application.yaml"
      Parameters:
        Environment: !Ref Environment
        VpcId: !GetAtt NetworkStack.Outputs.VpcId
        SubnetIds: !GetAtt NetworkStack.Outputs.PublicSubnetIds
        DatabaseEndpoint: !GetAtt DatabaseStack.Outputs.ClusterEndpoint

Outputs:
  ApplicationUrl:
    Value: !GetAtt ApplicationStack.Outputs.Url
```

**Upload templates and deploy:**
```bash
# Upload nested templates to S3
aws s3 sync ./templates/ s3://my-cfn-templates/stacks/

# Deploy parent stack
aws cloudformation deploy \
  --template-file parent-stack.yaml \
  --stack-name my-app-prod \
  --parameter-overrides \
    Environment=prod \
    TemplatesBucketUrl=https://s3.amazonaws.com/my-cfn-templates/stacks \
  --capabilities CAPABILITY_NAMED_IAM
```

**Or with rain (handles S3 upload automatically):**
```bash
rain deploy parent-stack.yaml my-app-prod
```

### Pattern 4: Cross-Stack References with Outputs and ImportValue

Cross-stack references let stacks share values without nesting. The producing stack exports an Output; consuming stacks import it with `Fn::ImportValue`.

```yaml
# Producing stack: network-stack.yaml
Outputs:
  VpcId:
    Description: VPC ID for application stacks
    Value: !Ref VPC
    Export:
      Name: !Sub "${AWS::StackName}-VpcId"   # Export name must be unique per region

  PrivateSubnetIds:
    Value: !Join [",", [!Ref PrivateSubnetA, !Ref PrivateSubnetB]]
    Export:
      Name: !Sub "${AWS::StackName}-PrivateSubnetIds"
```

```yaml
# Consuming stack: app-stack.yaml
Resources:
  ECSCluster:
    Type: AWS::ECS::Cluster
    Properties:
      ClusterName: !Sub "${AWS::StackName}-cluster"

  Service:
    Type: AWS::ECS::Service
    Properties:
      Cluster: !Ref ECSCluster
      NetworkConfiguration:
        AwsvpcConfiguration:
          Subnets: !Split
            - ","
            - Fn::ImportValue: "network-stack-PrivateSubnetIds"
          SecurityGroups:
            - !Ref ServiceSecurityGroup

  ServiceSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      VpcId:
        Fn::ImportValue: "network-stack-VpcId"
      GroupDescription: ECS service security group
```

**Constraints on cross-stack references:**
- You cannot delete a stack that has exports being consumed by another stack
- Export names must be unique within a region and account
- `!Sub` shorthand does not work with `Fn::ImportValue` — use the long form

### Pattern 5: SDK-Driven Stack Management (AWS SDK v3)

Use the CloudFormation SDK client to manage stacks programmatically — CI/CD pipelines, custom tooling, or automation scripts.

```typescript
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  ExecuteChangeSetCommand,
  DescribeStacksCommand,
  waitUntilChangeSetCreateComplete,
  waitUntilStackUpdateComplete,
  ChangeSetType,
  ChangeSetStatus,
} from "@aws-sdk/client-cloudformation";
import { readFileSync } from "fs";

const client = new CloudFormationClient({ region: "us-east-1" });

async function deployStack(
  stackName: string,
  templatePath: string,
  parameters: Record<string, string>
): Promise<void> {
  const templateBody = readFileSync(templatePath, "utf-8");
  const changeSetName = `deploy-${Date.now()}`;

  // Determine if stack exists to set change set type
  let changeSetType: ChangeSetType = "CREATE";
  try {
    await client.send(
      new DescribeStacksCommand({ StackName: stackName })
    );
    changeSetType = "UPDATE";
  } catch {
    // Stack does not exist — use CREATE
  }

  // Create change set
  await client.send(
    new CreateChangeSetCommand({
      StackName: stackName,
      ChangeSetName: changeSetName,
      ChangeSetType: changeSetType,
      TemplateBody: templateBody,
      Parameters: Object.entries(parameters).map(([key, value]) => ({
        ParameterKey: key,
        ParameterValue: value,
      })),
      Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
    })
  );

  // Wait for change set to be ready
  await waitUntilChangeSetCreateComplete(
    { client, maxWaitTime: 120 },
    { StackName: stackName, ChangeSetName: changeSetName }
  );

  // Check if there are actual changes
  const changeSet = await client.send(
    new DescribeChangeSetCommand({
      StackName: stackName,
      ChangeSetName: changeSetName,
    })
  );

  if (changeSet.Status === ChangeSetStatus.FAILED) {
    if (changeSet.StatusReason?.includes("didn't contain changes")) {
      console.log("No changes to deploy.");
      return;
    }
    throw new Error(`Change set failed: ${changeSet.StatusReason}`);
  }

  console.log("Changes to apply:");
  changeSet.Changes?.forEach((c) => {
    const r = c.ResourceChange!;
    console.log(`  ${r.Action} ${r.LogicalResourceId} (${r.ResourceType}) replacement=${r.Replacement}`);
  });

  // Execute
  await client.send(
    new ExecuteChangeSetCommand({
      StackName: stackName,
      ChangeSetName: changeSetName,
    })
  );

  // Wait for completion
  await waitUntilStackUpdateComplete(
    { client, maxWaitTime: 900 },
    { StackName: stackName }
  );

  console.log(`Stack ${stackName} deployed successfully.`);
}
```

---

## Gotchas

### 1. UPDATE_ROLLBACK_FAILED Is the Worst State

When an update fails and the rollback also fails, the stack enters `UPDATE_ROLLBACK_FAILED`. You cannot update or delete the stack. The only escape:

```bash
aws cloudformation continue-update-rollback \
  --stack-name my-stack \
  --resources-to-skip LogicalIdOfProblematicResource
```

The `--resources-to-skip` flag tells CloudFormation to skip the resource that is blocking rollback. After the rollback completes, manually reconcile the skipped resource. Common cause: a resource was manually deleted outside CloudFormation, so the rollback cannot restore it.

### 2. Replacement Updates Delete and Recreate Resources

Not all updates are in-place. Some property changes require CloudFormation to delete the old resource and create a new one. The documentation page for each resource type lists "Update requires: Replacement" for affected properties.

Dangerous examples:
- `AWS::RDS::DBInstance`: changing `DBInstanceClass` is an in-place update, but changing `DBSubnetGroupName` or `MasterUsername` is a replacement — the database is deleted and recreated, losing all data.
- `AWS::EC2::Instance`: changing `ImageId` (AMI) replaces the instance, which changes its IP and instance ID.
- `AWS::ElasticLoadBalancingV2::LoadBalancer`: changing `Scheme` (internal → internet-facing) replaces the ALB and changes its DNS name.

Always review the change set for `Replacement: True` before executing against production.

### 3. Circular Dependencies Lock the Stack

If Resource A references Resource B and Resource B also references Resource A, CloudFormation cannot determine deployment order and will fail with a circular dependency error. Common scenario: a Lambda function and an SNS topic that each reference the other.

Solutions:
- Use `DependsOn` explicitly to force ordering, and remove one of the cross-references
- Restructure: create a third resource (e.g., an SQS queue) to break the cycle
- For IAM: grant permissions via a separate `AWS::IAM::Policy` resource that references both, rather than embedding the policy in each resource

### 4. Template Size Limits Require S3

CloudFormation's inline template limit is 51,200 bytes. Once your template exceeds that, you must upload it to S3 and reference the S3 URL:

```bash
aws s3 cp template.yaml s3://my-bucket/templates/template.yaml

aws cloudformation create-stack \
  --stack-name my-stack \
  --template-url https://s3.amazonaws.com/my-bucket/templates/template.yaml
```

`rain deploy` handles this automatically. For large templates, S3 upload is the norm, not the exception.

### 5. Stack Deletion Can Get Stuck

A DELETE_FAILED state usually means one of:
- **Non-empty S3 bucket**: CloudFormation will not delete a bucket with objects. Add a Lambda-backed Custom Resource to empty the bucket, or set `DeletionPolicy: Retain` and empty it manually.
- **Non-empty ECR repository**: Same issue — images must be deleted first.
- **Security group in use**: Another resource (not in this stack) is referencing the security group.
- **VPC with dependencies**: ENIs, peering connections, or VPN gateways must be removed before the VPC.

For stuck deletions, you can force-delete by retaining the blocking resource:
```bash
aws cloudformation delete-stack \
  --stack-name my-stack \
  --retain-resources BlockingLogicalResourceId
```

### 6. Parameter Changes Alone Do Not Trigger Resource Updates

If a parameter value changes but no resource property references it has changed in a way that produces a different value, CloudFormation may not update the resource. This is expected behavior. To force an update when a parameter changes but CloudFormation does not detect a diff, you can add a metadata field that references the parameter.

### 7. Output Export Names Are Global Per Region

Export names in Outputs must be unique across all stacks in the same account and region. A naming collision causes the stack update or creation to fail. Use the stack name as a prefix:

```yaml
Export:
  Name: !Sub "${AWS::StackName}-MyExportedValue"
```

Avoid generic export names like `VpcId` or `DatabaseEndpoint` — they will collide.

### 8. You Cannot Delete a Stack with Consumed Exports

If Stack B is importing an Output from Stack A, you cannot delete Stack A until Stack B is deleted first. CloudFormation enforces this. There is no override. Plan your deletion order.

### 9. Custom Resources Hang for One Hour on Failure

Lambda-backed Custom Resources signal success or failure by making an HTTP PUT to a pre-signed S3 URL. If your Lambda crashes before sending the signal, CloudFormation waits the full one-hour timeout before moving on. This is the most painful part of Custom Resource development.

Best practice: always wrap your Custom Resource Lambda handler in try/catch and explicitly send a FAILED response on error rather than letting the Lambda crash silently.

```typescript
// Always send a response, even on failure
try {
  // do work
  await sendResponse(event, context, "SUCCESS", { Result: "done" });
} catch (err) {
  await sendResponse(event, context, "FAILED", {}, String(err));
}
```

### 10. Importing Existing Resources Requires Exact Property Match

You can bring existing AWS resources under CloudFormation management using resource imports, but every property in your template must exactly match the current resource state. One mismatch causes the import to fail with a confusing error. Before importing, use the console or CLI to inspect the resource and copy every relevant property.

```bash
aws cloudformation create-change-set \
  --stack-name my-stack \
  --change-set-name import-existing \
  --change-set-type IMPORT \
  --resources-to-import '[{"ResourceType":"AWS::S3::Bucket","LogicalResourceId":"MyBucket","ResourceIdentifier":{"BucketName":"my-existing-bucket"}}]' \
  --template-body file://template.yaml
```

### 11. StackSets Require Careful IAM Setup

For StackSets deploying across accounts, two IAM roles must exist:
- `AWSCloudFormationStackSetAdministrationRole` in the admin account — trusts `cloudformation.amazonaws.com`
- `AWSCloudFormationStackSetExecutionRole` in each target account — trusts the admin account

AWS publishes CloudFormation templates for both roles. Skipping this setup is the most common StackSets onboarding failure.

### 12. `!Ref` Returns Different Things for Different Resource Types

`!Ref` on a resource does not always return the ARN. What it returns depends on the resource type:
- `AWS::S3::Bucket` → bucket name
- `AWS::SQS::Queue` → queue URL
- `AWS::SNS::Topic` → topic ARN
- `AWS::DynamoDB::Table` → table name
- `AWS::Lambda::Function` → function name
- `AWS::IAM::Role` → role name (not ARN — use `!GetAtt Role.Arn` for the ARN)

Check the documentation "Return values" section for each resource type before assuming `!Ref` gives you an ARN.

### 13. Conditions Cannot Reference Other Conditions Directly in All Contexts

Conditions can reference other conditions using `Fn::And`, `Fn::Or`, and `Fn::Not`, but you cannot use `!If` inside a Condition definition. Structure compound conditions using the logical functions:

```yaml
Conditions:
  IsProd: !Equals [!Ref Environment, prod]
  IsUsEast1: !Equals [!Ref AWS::Region, us-east-1]
  IsProdUsEast1: !And
    - !Condition IsProd
    - !Condition IsUsEast1
```

---

## Official Documentation

| Resource | URL |
|---|---|
| CloudFormation User Guide | https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/ |
| Template Reference | https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-reference.html |
| Resource Types Reference | https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-template-resource-type-ref.html |
| Intrinsic Function Reference | https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference.html |
| CloudFormation Limits | https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html |
| Change Sets | https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html |
| Drift Detection | https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-drift.html |
| StackSets | https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/what-is-cfnstacksets.html |
| Resource Import | https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import.html |
| Custom Resources | https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-custom-resources.html |
| SAM Developer Guide | https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/ |
| AWS SDK v3 CloudFormation Client | https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cloudformation/ |
| rain CLI | https://github.com/aws-cloudformation/rain |
| cfn-lint | https://github.com/aws-cloudformation/cfn-lint |
| cfn-guard | https://github.com/aws-cloudformation/cloudformation-guard |
