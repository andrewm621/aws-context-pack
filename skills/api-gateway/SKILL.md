---
name: api-gateway
description: Amazon API Gateway guidance — REST API, HTTP API, WebSocket API, authorization, throttling, custom domains. Use when building or configuring API endpoints on AWS.
metadata:
  priority: 7
  docs:
    - "https://docs.aws.amazon.com/apigateway/latest/developerguide/"
  pathPatterns:
    - 'api/**'
    - 'apis/**'
    - '*-api.ts'
    - '*-api.js'
    - 'openapi.yaml'
    - 'openapi.yml'
    - 'openapi.json'
    - 'swagger.yaml'
    - 'swagger.json'
  bashPatterns:
    - '\baws\s+apigateway\b'
    - '\baws\s+apigatewayv2\b'
  importPatterns:
    - "@aws-sdk/client-api-gateway"
    - "@aws-sdk/client-apigatewayv2"
  promptSignals:
    phrases:
      - "api gateway"
      - "rest api"
      - "http api"
      - "websocket api"
      - "api endpoint"
      - "api throttling"
      - "api authorizer"
      - "custom domain"
---

# Amazon API Gateway

## What It Is & When to Use It

Amazon API Gateway is a fully managed service for creating, publishing, and managing APIs at any scale. It handles request routing, authorization, throttling, and monitoring. Use API Gateway as the entry point for Lambda-backed APIs or as a proxy to any HTTP backend. Choose HTTP API for most new projects (cheaper, simpler) and REST API only when you need advanced features.

## Service Surface

| API Type | Price per million | Max payload | Timeout | Key Features |
|----------|------------------|-------------|---------|--------------|
| **HTTP API** | $1.00 | 10 MB | 30s | JWT auth, OIDC, CORS, auto-deploy, Lambda/HTTP proxy |
| **REST API** | $3.50 | 10 MB | 29s | API keys, usage plans, caching, request validation, WAF, resource policies |
| **WebSocket API** | $1.00 + $0.25/million msgs | 128 KB frames | 29s (route) / 10min (idle) | Bidirectional, connection management, routes |

**Free tier**: 1 million HTTP API calls + 1 million REST API calls + 1 million messages + 750,000 connection minutes per month (12 months).

| Limit | Value |
|-------|-------|
| **Throttle (account)** | 10,000 req/s burst, 5,000 req/s sustained (soft) |
| **Routes per API** | 300 |
| **Stages per API** | 10 |
| **Custom domains** | 120 per account |
| **Integration timeout** | 50ms – 29s (REST) / 50ms – 30s (HTTP) |

## Mental Model

1. **HTTP API vs REST API**: HTTP API is the default choice — 70% cheaper, lower latency, simpler configuration. Use REST API only when you need: API key management + usage plans, request/response transformation, caching, WAF integration, resource policies, or AWS X-Ray tracing.

2. **Integration types**:
   - **Lambda proxy** (most common) — API Gateway passes entire request to Lambda, Lambda returns structured response
   - **HTTP proxy** — forwards to any HTTP endpoint
   - **AWS service proxy** — direct integration with SQS, Step Functions, DynamoDB (no Lambda needed)
   - **Mock** — returns hardcoded responses (useful for CORS preflight)

3. **Authorization**: HTTP API supports JWT authorizers (Cognito, Auth0, any OIDC provider) and Lambda authorizers. REST API adds IAM auth, API keys, and Cognito authorizers.

4. **Stages**: Deployment snapshots of your API. Common pattern: `dev`, `staging`, `prod` stages with stage variables for configuration. HTTP API has `$default` auto-deploy stage.

5. **Custom domains**: Map your domain to API Gateway with ACM certificate. REST API uses edge-optimized (CloudFront) or regional endpoints. HTTP API is regional only.

## Common Patterns

### HTTP API + Lambda (CDK)
```typescript
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const api = new HttpApi(this, 'Api', {
  corsPreflight: {
    allowOrigins: ['https://myapp.com'],
    allowMethods: [HttpMethod.GET, HttpMethod.POST],
    allowHeaders: ['Content-Type', 'Authorization'],
  },
});

api.addRoutes({
  path: '/items/{id}',
  methods: [HttpMethod.GET],
  integration: new HttpLambdaIntegration('GetItem', getItemFn),
});
```

### JWT Authorization (HTTP API)
```typescript
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';

const authorizer = new HttpJwtAuthorizer('CognitoAuth', cognitoIssuerUrl, {
  jwtAudience: [userPoolClientId],
});

api.addRoutes({
  path: '/protected',
  methods: [HttpMethod.GET],
  integration: new HttpLambdaIntegration('Protected', protectedFn),
  authorizer,
});
```

### Direct SQS Integration (no Lambda)
```typescript
// REST API can send requests directly to SQS without Lambda
// Useful for async ingestion patterns — decouple API from processing
import { AwsIntegration } from 'aws-cdk-lib/aws-apigateway';

const sqsIntegration = new AwsIntegration({
  service: 'sqs',
  path: `${account}/${queue.queueName}`,
  integrationHttpMethod: 'POST',
  options: {
    requestParameters: {
      'integration.request.header.Content-Type': "'application/x-www-form-urlencoded'",
    },
    requestTemplates: {
      'application/json': 'Action=SendMessage&MessageBody=$input.body',
    },
    integrationResponses: [{ statusCode: '200' }],
  },
});
```

## Gotchas

1. **29-30 second timeout is hard**: Integration timeout cannot exceed 29s (REST) or 30s (HTTP). For longer operations, return 202 Accepted and use Step Functions or SQS for async processing.

2. **10 MB payload limit**: Both request and response max 10 MB. For larger files, use S3 presigned URLs.

3. **REST API caching costs**: $0.02/hr for 0.5 GB cache. Caching is per-stage and per-method. Invalidation requires a header (`Cache-Control: max-age=0`), which clients can abuse.

4. **Throttling is account-wide**: The 10,000 req/s burst limit is shared across ALL APIs in a region. A spike in one API can throttle others. Use usage plans (REST API only) for per-client throttling.

5. **CORS must be configured explicitly**: HTTP API has built-in CORS support. REST API requires manual OPTIONS method with mock integration — easy to get wrong. Use `defaultCorsPreflightOptions` in CDK.

6. **Binary media handling**: API Gateway doesn't handle binary data by default. You need to configure binary media types and use base64 encoding. For file uploads, prefer presigned S3 URLs.

7. **CloudWatch Logs for debugging**: Enable execution logging ($0.50/GB) during development. The request/response transformation mapping templates are notoriously hard to debug without logs.

8. **Custom domain requires ACM cert in us-east-1**: For edge-optimized REST APIs, the ACM certificate must be in us-east-1 regardless of API region. Regional endpoints use the API's region.

9. **$default stage auto-deploys**: HTTP API's `$default` stage auto-deploys on changes. Great for dev, but for production use explicit stages with manual deployment.

10. **Lambda authorizer cold starts**: Lambda authorizers add latency on cold starts. Use result caching (TTL up to 3600s) to avoid re-invoking the authorizer for every request.

## Official Documentation

- [API Gateway Developer Guide](https://docs.aws.amazon.com/apigateway/latest/developerguide/)
- [HTTP API vs REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)
- [API Gateway Pricing](https://aws.amazon.com/api-gateway/pricing/)
- [API Gateway Quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html)
