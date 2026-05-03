# Lambda Layers and Extensions

## What Layers Are

A Lambda Layer is a ZIP archive that Lambda extracts into the `/opt` directory of your function's execution environment before your handler runs. Layers let you separate reusable code and dependencies from your function's deployment package.

**Key facts:**
- Up to 5 layers per function
- Each layer has its own version history; versions are immutable once published
- Layers count toward the 250MB unzipped deployment package limit (function + all layers combined)
- Layers can be shared across functions in the same account, or published publicly / shared cross-account
- Lambda extracts layers in order (layer 1 first, layer 5 last); later layers can override files from earlier ones

Layers are not magic — they are functionally equivalent to shipping those files inside your function package. The benefit is operational: you deploy your function code without re-uploading stable dependencies, and multiple functions can reference the same layer version without duplicating files.

---

## Use Cases

**Shared libraries across functions**
A monorepo with 20 Lambda functions that all use the same internal utility library. Package that library as a layer, pin to a version, and update once when the library changes. All 20 functions pick up the new version on next deployment.

**Large binary dependencies**
ImageMagick, FFmpeg, Chromium/Puppeteer, machine learning model weights — these don't change with every deployment. Package them as layers so your function deployment package stays small (improves cold start; see `cold-start-optimization.md`).

**Custom runtimes**
Lambda's managed runtimes (Node.js, Python, Java, etc.) are themselves delivered as layers. If you need a runtime Lambda doesn't support natively (Bun, Deno, Ruby 3.3, etc.) you can package a custom runtime as a layer containing a `bootstrap` executable.

**Monitoring and security agents**
Vendors like Datadog, New Relic, and Dynatrace distribute their Lambda agents as layers. The layer contains the agent binary and, in the case of extensions, a process that runs alongside your handler.

---

## Layer Packaging — Path Conventions by Runtime

Lambda looks for layer contents in specific paths under `/opt`. You must structure your layer ZIP to match.

### Node.js
```
layer.zip
└── nodejs/
    └── node_modules/
        ├── my-shared-lib/
        └── lodash/
```

Lambda adds `/opt/nodejs/node_modules` to `NODE_PATH`, so `require('my-shared-lib')` works without any path manipulation in your handler.

For ES modules, the same path applies. If using TypeScript, include compiled `.js` files (not `.ts` source).

### Python
```
layer.zip
└── python/
    └── lib/
        └── python3.12/      # must match your function's runtime version
            └── site-packages/
                ├── my_library/
                └── requests/
```

Lambda adds `/opt/python/lib/python3.x/site-packages` to `PYTHONPATH`. The Python version in the path must match the function's runtime exactly.

Alternatively, you can use the flat path `/opt/python/` and Lambda will also include that in `PYTHONPATH`.

### Java
```
layer.zip
└── java/
    └── lib/
        ├── my-shared.jar
        └── jackson-databind-2.15.jar
```

Lambda adds JARs in `/opt/java/lib/` to the classpath.

### Custom binary dependencies (all runtimes)
```
layer.zip
└── bin/
    └── ffmpeg        # executable
└── lib/
    └── libavcodec.so # shared library
```

Binaries go in `/opt/bin` (added to `PATH`) and shared libraries go in `/opt/lib` (added to `LD_LIBRARY_PATH`). Both paths are automatically configured by Lambda.

### Building layers correctly
Always build layers targeting the Lambda execution environment (Amazon Linux 2 or Amazon Linux 2023, x86_64 or arm64 depending on your function's architecture). On macOS or Windows, use Docker:

```bash
docker run --rm \
  -v $(pwd):/out \
  public.ecr.aws/lambda/nodejs:20 \
  bash -c "npm install --prefix /out/nodejs && exit"
```

Native modules compiled on a Mac will not run on Lambda.

---

## Publishing and Versioning

### Publishing a layer

```bash
# CLI
aws lambda publish-layer-version \
  --layer-name my-shared-utilities \
  --description "Internal utility library v1.2.3" \
  --zip-file fileb://layer.zip \
  --compatible-runtimes nodejs20.x nodejs22.x \
  --compatible-architectures x86_64 arm64
```

The response includes `LayerVersionArn` — this is what you reference when attaching the layer to a function.

### Versioning behavior
Layers are versioned starting at version 1. Every `publish-layer-version` call creates a new version. Versions are immutable — you cannot modify or delete a published layer version if any function references it (AWS will refuse the delete). This immutability is intentional: it guarantees that pinned layer versions don't change under your functions.

**Pin to specific versions in production.** Never reference `$LATEST` for a layer in a production function — there is no `$LATEST` concept for layers; you always reference a specific version ARN.

### Cross-account sharing

```bash
# Grant another account permission to use a specific layer version
aws lambda add-layer-version-permission \
  --layer-name my-shared-utilities \
  --version-number 3 \
  --statement-id cross-account-access \
  --action lambda:GetLayerVersion \
  --principal 123456789012  # target account ID
```

Public layers (principal `*`) are used by vendors to distribute monitoring agents without requiring customers to build or host anything.

---

## Extensions — Running Code Alongside Your Handler

Lambda Extensions are processes that run alongside your function handler in the same execution environment. They are different from layers (though extensions are typically distributed as layers).

### Internal extensions
Run inside the runtime process. Implemented using wrapper scripts that intercept the runtime startup. Less common; used for language-specific instrumentation that must run in-process.

### External extensions
Run as separate processes that communicate with Lambda's Extensions API. Lambda starts extensions before starting your runtime, and extensions can run code:
- **After registration** (startup phase, before any invocations)
- **After each invocation** (in the `POST_INVOKE` phase, while the next event is being fetched)
- **During shutdown** (when the execution environment is terminating)

```
Lambda lifecycle with an external extension:
[Extension init] → [Runtime init] → [Handler] → [POST_INVOKE: extension runs] → [Next event]
```

The critical insight: extensions run **between invocations**, not in parallel with your handler. Your handler completes, Lambda fetches the next event, and during that fetch window, the extension can flush logs, send metrics, etc. This is why extensions can add latency — if an extension blocks or takes too long in its POST_INVOKE hook, it delays the next invocation.

### Lambda Extensions API
Extensions must register with Lambda and respond to lifecycle events. Vendors handle this for you. If building a custom extension:

```bash
# Register
curl -X POST http://${AWS_LAMBDA_RUNTIME_API}/2020-01-01/extension/register \
  -H "Lambda-Extension-Name: my-extension" \
  -d '{"events": ["INVOKE", "SHUTDOWN"]}'

# Poll for next event
curl http://${AWS_LAMBDA_RUNTIME_API}/2020-01-01/extension/event/next \
  -H "Lambda-Extension-Identifier: <id-from-register>"
```

---

## Common Extensions

### Datadog Lambda Extension
Distributed as a layer (`arn:aws:lambda:us-east-1:464622532012:layer:Datadog-Extension:...`). Collects metrics, traces, and logs without requiring a forwarder Lambda. Sends data to Datadog asynchronously in POST_INVOKE phase.

### New Relic Lambda Extension
Similar pattern — layer-distributed agent that ships telemetry to New Relic. Requires New Relic license key in Secrets Manager or environment variables.

### AWS Parameters and Secrets Lambda Extension
AWS-provided extension (`AWS-Parameters-and-Secrets-Lambda-Extension`) that caches SSM Parameter Store and Secrets Manager values locally. Your function reads parameters via a localhost HTTP endpoint instead of making API calls directly. Benefits: automatic caching (reduces API calls and costs), TTL-based refresh, no SDK dependency in your function for parameter retrieval.

```python
import urllib.request

# Read a secret via the extension's local cache
url = f"http://localhost:2773/secretsmanager/get?secretId={secret_name}"
req = urllib.request.Request(url)
req.add_header("X-Aws-Parameters-Secrets-Token", os.environ["AWS_SESSION_TOKEN"])
response = urllib.request.urlopen(req).read()
```

### AWS AppConfig Extension
Caches AppConfig feature flags locally. Same pattern as Parameters/Secrets — localhost HTTP endpoint with TTL-based refresh.

---

## CDK Patterns

### Creating a layer from local assets

```typescript
import * as lambda from 'aws-cdk-lib/aws-lambda';

const sharedUtilitiesLayer = new lambda.LayerVersion(this, 'SharedUtilities', {
  code: lambda.Code.fromAsset('layers/shared-utilities'),
  compatibleRuntimes: [
    lambda.Runtime.NODEJS_20_X,
    lambda.Runtime.NODEJS_22_X,
  ],
  compatibleArchitectures: [lambda.Architecture.ARM_64],
  description: 'Shared utilities for all Lambda functions',
  // removalPolicy defaults to RETAIN — layer versions are kept even if the stack is deleted
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});
```

The `layers/shared-utilities/` directory should contain the properly structured content (`nodejs/node_modules/...`), not raw source files.

### Attaching layers to a function

```typescript
const fn = new lambda.Function(this, 'MyFunction', {
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('dist'),
  layers: [
    sharedUtilitiesLayer,
    // Reference an external layer by ARN (e.g., Datadog, AWS extensions)
    lambda.LayerVersion.fromLayerVersionArn(
      this,
      'DatadogExtension',
      'arn:aws:lambda:us-east-1:464622532012:layer:Datadog-Extension:65',
    ),
  ],
});
```

### NodejsFunction with bundling (handles layer separation automatically)

```typescript
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

const fn = new NodejsFunction(this, 'MyFunction', {
  entry: 'src/handler.ts',
  runtime: lambda.Runtime.NODEJS_22_X,
  bundling: {
    minify: true,
    // Mark shared-lib as external — it will be provided by the layer
    externalModules: ['@aws-sdk/*', 'shared-lib'],
  },
  layers: [sharedUtilitiesLayer],
});
```

### Cross-stack layer references

```typescript
// Stack A — exports the layer
new cdk.CfnOutput(this, 'LayerArn', {
  value: sharedUtilitiesLayer.layerVersionArn,
  exportName: 'SharedUtilitiesLayerArn',
});

// Stack B — imports the layer
const sharedLayer = lambda.LayerVersion.fromLayerVersionArn(
  this,
  'SharedUtilitiesLayer',
  cdk.Fn.importValue('SharedUtilitiesLayerArn'),
);
```

---

## Performance Impact

### Layers and cold start duration
Layers add to the total unzipped package size that Lambda must extract during initialization. The 250MB limit is a hard ceiling, but performance starts degrading well before that. Aim to keep total unzipped size (function + all layers) under 50MB for the fastest cold starts.

Lambda caches layers separately from function packages. If you update only your function code (not the layer), Lambda can reuse the cached layer extraction. The practical benefit depends on the Lambda service internals and isn't guaranteed, but layer separation is still a good practice.

**Docker image functions:** Layer caching is less relevant for container image functions. Use Docker layer caching instead (stable deps in early Dockerfile layers).

### Extensions and memory allocation
External extensions run as separate processes in the same execution environment. They consume memory from your function's configured memory allocation. A monitoring agent typically uses 50–100MB.

If your function is configured for 128MB (the minimum) and you attach an extension that uses 80MB, your handler effectively has only ~48MB available. This can cause out-of-memory errors that appear unrelated to the extension.

**Recommendation:** When adding a monitoring extension to a function, increase memory allocation by at least 100MB to account for the extension's footprint. Memory is cheap; OOM crashes are not.

Extensions also add latency in two ways:
1. **Startup latency:** Extensions initialize before your runtime starts. A slow extension registration increases cold start duration.
2. **Shutdown latency:** Lambda waits up to 2 seconds for extensions to complete their SHUTDOWN phase before terminating the environment. If your function times out, you may see an additional 2-second delay before the error is reported.

---

## Best Practices

**Pin layer versions explicitly.** Always reference a specific version ARN, never a mutable alias. Layer versions are immutable, so pinning gives you reproducible deployments. Update layer versions deliberately, not automatically.

```typescript
// GOOD — specific version
'arn:aws:lambda:us-east-1:464622532012:layer:Datadog-Extension:65'

// BAD — there is no "latest" for layers; always use explicit versions
```

**Don't exceed 250MB unzipped total.** This is a hard limit. Budget roughly:
- Function code: < 10MB (after bundling/minification)
- Shared libraries: < 50MB per layer
- Binary dependencies (FFmpeg, Chromium): these are large; containerize if they push you over the limit
- Monitoring extension: ~50–100MB

**Use layers for stable dependencies only.** Layers shine when the content changes infrequently. If you're updating a "layer" with every deployment, you've gained nothing — use the function package instead. Good candidates: binary tools, vendor agents, large libraries pinned to a major version.

**Match architecture.** ARM64 layers will not load in x86_64 execution environments and vice versa. If your function uses `arm64`, ensure all layers declare `arm64` compatibility and are built for `arm64`. Mixed architectures are a common source of "invalid ELF header" errors in production.

**Match runtime versions for Python layers.** Python layer paths include the runtime version (`python3.12`). A layer built for Python 3.12 will not be found by a Python 3.11 function because the path doesn't match. Either build separate layers per runtime version, or use the flat `/opt/python/` path and ensure compatibility.

**One responsibility per layer.** Don't pack unrelated things into a single layer. A "utilities layer" that contains your shared library, FFmpeg, and the Datadog agent is hard to update (any change requires re-publishing the whole layer) and creates unnecessary dependencies between teams.

**Test layer extraction locally.** Use AWS SAM (`sam local invoke`) or the Lambda Runtime Interface Emulator (RIE) to test that your layer contents are accessible at the expected paths before deploying. Path mistakes are silent — your handler just gets an import error at runtime.
