---
name: cloudfront
description: Amazon CloudFront guidance — CDN, edge caching, origins, behaviors, functions, Lambda@Edge, signed URLs, cache invalidation. Use when serving content globally with low latency.
metadata:
  priority: 5
  docs:
    - "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/"
  pathPatterns:
    - 'cdn/**'
    - 'cloudfront/**'
    - 'edge/**'
  bashPatterns:
    - '\baws\s+cloudfront\b'
  importPatterns:
    - "@aws-sdk/client-cloudfront"
    - "aws-cdk-lib/aws-cloudfront"
    - "aws-cdk-lib/aws-cloudfront-origins"
  promptSignals:
    phrases:
      - "cloudfront"
      - "cdn"
      - "edge cache"
      - "cache invalidation"
      - "signed url"
      - "lambda@edge"
      - "cloudfront function"
      - "origin"
      - "cache behavior"
      - "content delivery"
validate:
  - pattern: 'new AWS\.CloudFront\('
    message: 'AWS SDK v2 CloudFront constructor — use new CloudFrontClient({}) from @aws-sdk/client-cloudfront'
    severity: error
  - pattern: 'import.*from.*[''"]aws-sdk[''"]'
    message: 'AWS SDK v2 detected — use @aws-sdk/client-cloudfront (v3) for tree-shaking'
    severity: error
  - pattern: 'OriginAccessIdentity'
    message: 'Origin Access Identity (OAI) is legacy — use Origin Access Control (OAC) instead (S3BucketOrigin.withOriginAccessControl in CDK)'
    severity: recommended
---

# Amazon CloudFront

## What It Is & When to Use It

Amazon CloudFront is AWS's global content delivery network with 450+ edge locations (Points of Presence) worldwide. It caches content close to users, reducing latency and offloading traffic from your origin. CloudFront also provides DDoS protection via AWS Shield Standard (included at no extra cost), SSL/TLS termination at the edge, and two edge compute options for request/response manipulation.

**Use CloudFront for:**
- Static assets (S3 + CloudFront is the canonical AWS static hosting pattern)
- SPA hosting with client-side routing (combine with CloudFront Functions for URL rewriting)
- API acceleration — caching GET responses at the edge to reduce origin load and latency
- Video streaming — both on-demand (HLS, DASH) and live streaming (with MediaPackage or MediaStore origins)
- Private content distribution via signed URLs or signed cookies
- Any globally-distributed web content where latency matters

**Do not use CloudFront for:**
- Internal or VPC-only traffic — use a private ALB or VPC endpoints instead
- Real-time bidirectional communication (WebSockets) — CloudFront does support WebSocket proxying but does not cache it; use API Gateway WebSocket APIs or ALB directly for lower overhead
- Sub-10ms latency requirements where even a cache miss adds meaningful delay
- Content that must never be cached and is entirely dynamic per-user — you still can use CloudFront as a pass-through with caching disabled, but evaluate whether the added hop is worth it

## Service Surface

### Pricing (US East / EU, verified 2025)

| Component | Price |
|-----------|-------|
| **Data transfer out — first 10 TB/mo** | $0.085/GB |
| **Data transfer out — next 40 TB/mo** | $0.080/GB |
| **Data transfer out — next 100 TB/mo** | $0.060/GB |
| **HTTPS requests** | $0.0075 per 10,000 |
| **HTTP requests** | $0.0075 per 10,000 |
| **Origin Shield data transfer** | $0.0081/GB (US/EU) |
| **Invalidation paths — first 1,000/mo** | Free |
| **Invalidation paths — additional** | $0.005 per path |
| **CloudFront Functions invocations** | $0.10 per 1M |
| **Lambda@Edge invocations** | $0.60 per 1M (+ duration charges) |
| **Field-Level Encryption** | $0.02 per 10,000 requests |

Data transfer from S3 to CloudFront within the same region is free. Data transfer from EC2/ALB to CloudFront is charged at standard data transfer rates.

### Edge Compute Options

| Feature | CloudFront Functions | Lambda@Edge |
|---------|---------------------|-------------|
| **Runtime** | JavaScript (ES 5.1 subset) | Node.js 18/20, Python 3.11 |
| **Max execution time** | 1ms | 5s (viewer) / 30s (origin) |
| **Max package size** | 10 KB | 1 MB (zip), 50 MB (container, origin only) |
| **Trigger points** | viewer-request, viewer-response | viewer-request, viewer-response, origin-request, origin-response |
| **Network access** | No | Yes |
| **File system access** | No | No |
| **Scale** | Millions of req/s | Thousands of req/s |
| **Pricing** | $0.10/1M invocations | $0.60/1M + $0.00000625001/128MB-s |
| **Deployment region** | us-east-1 (replicates automatically) | us-east-1 only |
| **Use case** | URL rewriting, header manipulation, simple redirects | Auth, A/B testing, complex transformations, external service calls |

### Key Service Limits

| Limit | Value |
|-------|-------|
| **Distributions per account** | 200 (soft — requestable increase) |
| **Origins per distribution** | 25 (soft) |
| **Cache behaviors per distribution** | 25 (soft) |
| **Custom headers per origin** | 10 |
| **Cookies in cache key** | 10 |
| **Query strings in cache key** | 10 |
| **Lambda@Edge associations per distribution** | 25 |
| **Aliases (CNAMEs) per distribution** | 100 |
| **Min TTL** | 0 seconds |
| **Max TTL** | 31,536,000 seconds (1 year) |

## Mental Model

Five primitives make up every CloudFront configuration:

**1. Distribution**
Your CDN configuration. Maps a domain (`d1234abcd.cloudfront.net` or your custom `cdn.example.com`) to one or more origins. A distribution defines all the rules for how CloudFront handles requests. It takes 5-15 minutes for changes to propagate to all edge locations globally — plan accordingly.

**2. Origins**
Where CloudFront fetches content when it doesn't have a cached copy (cache miss). Origins can be S3 buckets (with Origin Access Control), ALBs, API Gateway endpoints, EC2 instances, or any HTTP server. Each origin has its own connection settings, custom headers, and timeout configuration.

**3. Cache Behaviors**
Path-based routing rules that determine how CloudFront handles requests for a given URL pattern. The first matching behavior wins. The default behavior (`*`) catches everything else. Each behavior configures:
- Which origin to use
- Which caching policy applies (TTL, cache key components)
- Which origin request policy applies (which headers/cookies/query strings to forward to origin)
- Which edge functions are attached (CloudFront Functions or Lambda@Edge)
- Allowed HTTP methods
- Viewer protocol policy (HTTP, HTTPS, redirect)

**4. Cache Key**
What makes a cached response unique at an edge location. By default: URL path only. You can add query strings, headers, and cookies to the cache key — but every dimension you add reduces your cache hit ratio (more unique keys = fewer cache hits = more origin requests). Lean toward the smallest cache key that correctly represents your content's uniqueness.

Think of cache key components in two groups:
- **Cache key** (affects uniqueness of cached copy): URL + optional query strings, headers, cookies
- **Origin request policy** (forwarded to origin but NOT part of key): authentication headers, session cookies you need the origin to see but shouldn't vary the cache on

**5. Invalidation vs TTL Strategy**
You have two ways to control cache freshness:
- **TTL**: Set max-age on your origin responses. CloudFront respects Cache-Control headers. Short TTLs for dynamic content, long TTLs (1 year) for versioned assets.
- **Invalidation**: Force immediate cache purge by path. First 1,000 paths/month free, then $0.005/path. Wildcards (`/images/*`) count as one path but purge all matching objects.

The best strategy: use **versioned filenames** for static assets (`main.a1b2c3.js`), set long TTLs (immutable caching), and skip invalidation entirely. For content that can't be versioned, use short TTLs and accept a brief stale window rather than paying for frequent invalidations.

**Origin Shield** (optional 6th primitive): An additional caching layer between edge locations and your origin. All edge PoPs funnel cache misses through Origin Shield first, which dramatically reduces origin request volume for globally-distributed traffic. Worth enabling when your origin is expensive to hit (database-backed API) or when you have traffic from many geographic regions. One region per distribution; adds ~$0.008-0.012/GB.

## Common Patterns

### Pattern 1: S3 Static Site with Origin Access Control (CDK)

OAC (not the legacy OAI) is the current recommended way to lock down S3 access so only CloudFront can read the bucket.

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export class StaticSiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront Function for SPA routing (handles /about -> /about/index.html
    // and strips trailing slashes)
    const spaRoutingFunction = new cloudfront.Function(this, 'SpaRouting', {
      code: cloudfront.FunctionCode.fromInline(`
        function handler(event) {
          var request = event.request;
          var uri = request.uri;

          // Redirect /path/ -> /path
          if (uri.endsWith('/') && uri !== '/') {
            return {
              statusCode: 301,
              statusDescription: 'Moved Permanently',
              headers: { location: { value: uri.slice(0, -1) } },
            };
          }

          // Add .html extension if no extension present
          if (!uri.includes('.')) {
            request.uri = uri + '/index.html';
          }

          return request;
        }
      `),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        // withOriginAccessControl attaches OAC and updates the bucket policy automatically
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [
          {
            function: spaRoutingFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        // Return index.html for 403/404 so the SPA router handles the path
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: distribution.distributionDomainName,
    });
  }
}
```

### Pattern 2: ALB Origin with API Response Caching

Cache GET API responses at the edge, pass through all other methods uncached.

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

export class ApiCdnStack extends cdk.Stack {
  constructor(scope: Construct, id: string, alb: elbv2.IApplicationLoadBalancer) {
    super(scope, id);

    // Cache policy: respect origin Cache-Control, cache on Authorization header
    // (so per-user responses are cached separately)
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      defaultTtl: cdk.Duration.seconds(0),    // Respect origin Cache-Control
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(300),       // Never cache longer than 5 min regardless
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Origin request policy: forward these to ALB without putting in cache key
    const apiOriginPolicy = new cloudfront.OriginRequestPolicy(this, 'ApiOriginPolicy', {
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        'CloudFront-Forwarded-Proto',
        'Host',
        'X-Request-Id',
      ),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    const distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          // Add a secret header so your ALB only accepts requests from CloudFront
          customHeaders: {
            'X-CloudFront-Secret': process.env.CF_ORIGIN_SECRET ?? '',
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: apiCachePolicy,
        originRequestPolicy: apiOriginPolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true,
      },
      additionalBehaviors: {
        // Static assets path — cache aggressively with versioned filenames
        '/assets/*': {
          origin: new origins.LoadBalancerV2Origin(alb, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
      },
    });
  }
}
```

### Pattern 3: CloudFront Function for URL Rewriting

CloudFront Functions run on every request before the cache lookup (viewer-request) or after the cache response (viewer-response). Under 1ms budget, 10 KB code limit, no network access. Perfect for redirects, header manipulation, and URL normalization.

```javascript
// Rewrite /blog/my-post -> /blog/my-post/index.html
// Normalize trailing slashes and lowercase URLs
// Deploy via CDK: cloudfront.FunctionCode.fromInline(...)
// or from file: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite.js' })

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Lowercase the URI to normalize cache keys
  var lowerUri = uri.toLowerCase();
  if (lowerUri !== uri) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: lowerUri + (request.querystring ? '?' + request.querystring : '') } },
    };
  }

  // Redirect /path/ -> /path (except root)
  if (uri.endsWith('/') && uri.length > 1) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: uri.slice(0, -1) } },
    };
  }

  // Append /index.html to paths with no file extension
  if (!uri.split('/').pop().includes('.')) {
    request.uri = uri.endsWith('/') ? uri + 'index.html' : uri + '/index.html';
  }

  return request;
}
```

### Pattern 4: Signed URLs for Private Content

Use signed URLs when you need to grant time-limited access to individual CloudFront objects (e.g., user-specific downloads, paid content, expiring share links). Signed cookies are better when granting access to multiple files at once.

```typescript
// CDK: configure the distribution with a trusted key group
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

// 1. Generate a key pair (do this once, store private key in Secrets Manager)
//    aws cloudfront create-public-key --public-key-config ...
//    Then create a key group in CDK:
const publicKey = new cloudfront.PublicKey(this, 'SigningKey', {
  encodedKey: process.env.CF_PUBLIC_KEY ?? '', // PEM format, from Secrets Manager
});
const keyGroup = new cloudfront.KeyGroup(this, 'SigningKeyGroup', {
  items: [publicKey],
});

const distribution = new cloudfront.Distribution(this, 'PrivateDistribution', {
  defaultBehavior: {
    origin: origins.S3BucketOrigin.withOriginAccessControl(privateBucket),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
    trustedKeyGroups: [keyGroup],  // Require signed URLs for this behavior
  },
});
```

```typescript
// Runtime: generate a signed URL (Node.js, using @aws-sdk/cloudfront-signer)
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({});

async function getPrivateKey(): Promise<string> {
  const response = await secretsClient.send(new GetSecretValueCommand({
    SecretId: 'cloudfront/private-key',
  }));
  return response.SecretString ?? '';
}

export async function generateSignedUrl(
  objectKey: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const privateKey = await getPrivateKey();
  const keyPairId = process.env.CF_KEY_PAIR_ID ?? '';  // From your CloudFront public key

  const url = `https://${process.env.CF_DOMAIN}/${objectKey}`;
  const dateLessThan = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  return getSignedUrl({
    url,
    keyPairId,
    dateLessThan,
    privateKey,
  });
}
```

```typescript
// SDK v3: trigger a cache invalidation programmatically
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront';

const cf = new CloudFrontClient({});

export async function invalidatePaths(
  distributionId: string,
  paths: string[],
): Promise<void> {
  await cf.send(new CreateInvalidationCommand({
    DistributionId: distributionId,
    InvalidationBatch: {
      CallerReference: `invalidation-${Date.now()}`,
      Paths: {
        Quantity: paths.length,
        Items: paths,
      },
    },
  }));
}

// Usage examples:
// invalidatePaths('E1ABCD2EFGH3IJ', ['/index.html'])         // 1 path = $0
// invalidatePaths('E1ABCD2EFGH3IJ', ['/blog/*'])              // 1 path wildcard = $0
// invalidatePaths('E1ABCD2EFGH3IJ', ['/*'])                   // nuclear option = 1 path = $0
//                                                              // (clears everything)
```

## Gotchas

1. **Wildcard invalidation counts as 1 path, not N**: Invalidating `/*` costs 1 path (free within the first 1,000/month). It clears the entire distribution's cache — use it deliberately. Invalidating `/blog/post-1`, `/blog/post-2`, `/blog/post-3` counts as 3 paths.

2. **OAI is legacy — always use OAC**: Origin Access Identity (OAI) doesn't support S3 SSE-KMS encryption, S3 Object Lambda, or S3 in newer regions. Origin Access Control (OAC) supports all of these and is the current recommendation. In CDK, use `S3BucketOrigin.withOriginAccessControl()` not the older `S3Origin` with OAI.

3. **ACM certificate must be in us-east-1**: CloudFront is a global service fronted from us-east-1. Even if your app runs in `ap-southeast-1`, you must provision your custom domain SSL certificate in `us-east-1`. Cross-region stack references in CDK handle this — use `DnsValidatedCertificate` or manually provision. Forgetting this is the most common CloudFront deployment failure.

4. **Distribution changes take 5-15 minutes to propagate**: CloudFront has 450+ edge locations. Any configuration change — adding a behavior, updating a cache policy, changing an origin — takes time to replicate. You cannot do rapid iteration on distribution configs. Test in a dev distribution.

5. **CORS requires forwarding the Origin header**: CloudFront does not add CORS headers — your origin must return them. For S3 origins, you must add `Origin` to the origin request policy (or use a managed policy that includes it). Without forwarding `Origin`, CloudFront will cache the first response without CORS headers and serve it to all subsequent requests, breaking browsers.

6. **Cache hit ratio below 80% means your cache key is too broad**: If you're forwarding unnecessary cookies or headers in the cache key, each unique combination creates a new cache entry. Common offenders: session cookies included in cache key, all query strings included when only a few affect output, authorization headers included when content isn't user-specific. Use CloudWatch metric `CacheHitRate` to monitor.

7. **CloudFront Functions run on EVERY request, even cache hits**: Functions attached to `viewer-request` run before the cache lookup, so they execute on every single request — cached or not. Lambda@Edge attached to `origin-request` only runs on cache misses. For high-traffic sites, CloudFront Functions cost (~$0.10/1M) is significant at scale. Lambda@Edge origin-request is cheaper per-execution when cache hit rates are high.

8. **Compression requires specific conditions**: CloudFront gzip/brotli compression (when enabled on the behavior) only compresses if: the object is not already compressed, the object size is between 1 KB and 10 MB, and the viewer supports it (Accept-Encoding header). If you pre-compress in S3 (storing `.gz` files), disable CloudFront compression on that behavior or you'll double-compress.

9. **Price class restricts edge locations**: By default, CloudFront serves from all 450+ PoPs globally. Price Class 100 (US, EU, Israel) is significantly cheaper and covers most audiences for US/EU products. Price Class 200 adds edge locations in South America, Africa, and the Middle East. If your users are regional, set the price class explicitly — you're otherwise paying for edge locations your users never hit.

10. **Custom error pages are not configured by default**: Without custom error responses, cache misses that hit a broken origin or missing object return CloudFront's generic XML error page (ugly, unbranded, confusing). Always configure `errorResponses` in CDK for at least 404 and 503. For SPAs, map 403 and 404 back to `/index.html` with a 200 status so the client-side router handles routing.

11. **Lambda@Edge functions deploy to us-east-1 and replicate**: You can only create Lambda@Edge functions in `us-east-1`. They replicate to edge locations automatically but this takes time. The function version that was associated at distribution update time is what runs — you must update the distribution to pick up a new Lambda version. This creates a slow deploy cycle for edge logic iteration.

12. **Response header policies for security headers**: Don't set security headers (HSTS, CSP, X-Frame-Options, etc.) in Lambda@Edge or CloudFront Functions — use a Response Headers Policy instead. CDK: `responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS` for sensible defaults, or build a custom one. This is the idiomatic CloudFront approach and avoids the cost of running a function for headers you could configure statically.

13. **WebSocket passthrough works but isn't cached**: CloudFront does pass WebSocket connections through to your origin with `ALLOW_ALL` methods on the behavior. But WebSocket traffic isn't cached, and CloudFront isn't designed to handle long-lived connections efficiently. For WebSocket-heavy applications, consider pointing WebSocket clients directly at API Gateway or ALB and only routing HTTP traffic through CloudFront.

14. **Viewer IP is replaced by CloudFront's IP at origin**: Your origin sees CloudFront's IP, not the viewer's. If your application needs the real client IP (rate limiting, geoblocking, analytics), read the `CloudFront-Viewer-Address` header (added automatically by CloudFront) or the `X-Forwarded-For` header. Configure your origin request policy to forward these headers.

## Official Documentation

- [CloudFront Developer Guide](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/)
- [CloudFront Pricing](https://aws.amazon.com/cloudfront/pricing/)
- [Caching and Cache Key Best Practices](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-the-cache-key.html)
- [CloudFront Functions vs Lambda@Edge](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions.html)
- [Origin Access Control (OAC)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [Signed URLs and Signed Cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-urls.html)
- [CloudFront Security Best Practices](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/security-best-practices.html)
- [Response Headers Policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-response-headers.html)
