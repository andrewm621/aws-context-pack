---
name: sagemaker
description: Amazon SageMaker guidance — ML model training, deployment, endpoints, notebooks, pipelines, feature store. Use when building or deploying machine learning models on AWS.
metadata:
  priority: 4
  docs:
    - "https://docs.aws.amazon.com/sagemaker/latest/dg/"
  pathPatterns:
    - 'sagemaker/**'
    - 'ml/**'
    - 'models/**'
    - 'notebooks/**'
  bashPatterns:
    - '\baws\s+sagemaker\b'
  importPatterns:
    - "@aws-sdk/client-sagemaker"
    - "@aws-sdk/client-sagemaker-runtime"
    - "aws-cdk-lib/aws-sagemaker"
  promptSignals:
    phrases:
      - "sagemaker"
      - "ml model"
      - "model training"
      - "model endpoint"
      - "sagemaker notebook"
      - "sagemaker pipeline"
      - "inference endpoint"
      - "model deployment"
---

## What It Is & When to Use It

Amazon SageMaker is a fully managed ML platform that covers the entire model lifecycle: data preparation, training, evaluation, registration, deployment, and monitoring. It is not just a model hosting service — it is an end-to-end ML operations (MLOps) platform. The mental model is a pipeline, not a hosting slot: data → train → evaluate → register → deploy → monitor → retrain.

**Use SageMaker when:**
- You are training, fine-tuning, or retraining custom ML models on your own data
- You need full control over model architecture, hyperparameters, and training code
- Your workload requires GPU clusters for training (distributed training across multiple instances)
- You need a model registry with versioning, approval workflows, and lineage tracking
- Your organization requires reproducible ML pipelines (SageMaker Pipelines DAGs)
- You want managed feature engineering with a centralized feature store shared across teams
- You need A/B testing or canary deployments for model versions in production
- Compliance requires audit trails of what data trained which model version

**Use Bedrock instead when:**
- You need foundation models (Claude, Llama, Titan, etc.) without writing training code
- You want to call a model API and pay per token, not manage infrastructure
- Your use case is text generation, summarization, embedding, or image generation with existing models
- You don't have proprietary training data that changes the model's behavior significantly

**The core distinction:** SageMaker is for building and deploying *your* models. Bedrock is for using *AWS-hosted* foundation models. They are not alternatives — many production architectures use both: SageMaker for custom domain-specific models, Bedrock for general-purpose LLM tasks.

---

## Service Surface

### Core Components

| Component | What It Does | When to Use |
|---|---|---|
| **Studio** | Browser-based IDE for notebooks, experiments, pipelines, and model registry | Daily ML development workflow |
| **Notebook Instances** | Standalone Jupyter servers on managed EC2 | Quick experiments, lightweight development outside Studio |
| **Training Jobs** | Managed compute for running training scripts (spot or on-demand) | Any model training at scale |
| **Processing Jobs** | Managed compute for data preprocessing, evaluation scripts | ETL for ML data, post-training evaluation |
| **Pipelines** | DAG-based MLOps pipeline (train → evaluate → register → deploy) | Automated retraining, CI/CD for models |
| **Model Registry** | Versioned model catalog with approval states | Multi-team model governance |
| **Endpoints (Real-Time)** | Always-on HTTPS inference endpoint backed by EC2 instance(s) | <1s latency requirements, sustained traffic |
| **Serverless Inference** | On-demand inference, no instances to manage | Spiky or infrequent traffic, cost-sensitive |
| **Async Inference** | Queue-based inference for large payloads or long processing | Video, audio, large documents |
| **Batch Transform** | Run inference over an entire S3 dataset | Offline scoring, bulk predictions |
| **Feature Store** | Centralized repository for ML features (online + offline store) | Shared features across models and teams |
| **Clarify** | Bias detection and explainability for models and predictions | Regulated industries, fairness requirements |
| **Model Monitor** | Continuous drift detection on live endpoint traffic | Production model health tracking |
| **JumpStart** | Pre-built model hub with fine-tuning and deployment templates | Starting from a pre-trained checkpoint |

### Endpoint Types — Decision Matrix

| Type | Latency | Min Cost | Max Payload | Best For |
|---|---|---|---|---|
| **Real-Time** | 50-200ms | ~$0.10/hr (instance) | 6 MB | APIs, interactive apps |
| **Serverless** | 100ms-30s (cold start) | $0 when idle | 4 MB | Infrequent traffic, dev/staging |
| **Async** | Seconds to minutes | ~$0.10/hr (instance) | 1 GB | Large inputs, long processing |
| **Batch Transform** | Minutes to hours | Per-job (no endpoint) | Unlimited (S3) | Offline scoring, entire datasets |

### Approximate Pricing (us-east-1, verified May 2026 — check https://aws.amazon.com/sagemaker/pricing/)

| Resource | Cost |
|---|---|
| Training: ml.m5.xlarge | ~$0.23/hr |
| Training: ml.p3.2xlarge (1 V100 GPU) | ~$3.83/hr |
| Training: ml.p4d.24xlarge (8 A100 GPUs) | ~$32.77/hr |
| Endpoint: ml.m5.large | ~$0.115/hr |
| Endpoint: ml.g4dn.xlarge (T4 GPU) | ~$0.736/hr |
| Serverless Inference | $0.00002/GB-second of memory used |
| Notebook instance: ml.t3.medium | ~$0.05/hr |
| Feature Store online reads | $0.00025 per 1,000 reads |
| Feature Store offline (S3) | Standard S3 pricing |
| Spot training discount | 70-90% off on-demand price |

**Training with Spot instances** is the single highest-ROI cost optimization available. Enable it for any training job that can tolerate interruption (most can, with checkpointing).

---

## Mental Model

SageMaker has a lot of surface area. Five primitives clarify 80% of it.

### 1. Everything Runs in Managed Containers

SageMaker does not run your Python script directly. It packages your code into a Docker container (either a pre-built AWS container or your own), launches EC2 instances, runs the container, and terminates the instances when done. For training jobs and processing jobs, the instances exist only for the duration of the job. For endpoints, the instances run continuously.

This means:
- Your training script receives data via environment variables pointing to S3 paths (not local paths)
- Output (model artifacts) must be written to `/opt/ml/model/` — SageMaker packages this directory into a `.tar.gz` and uploads it to S3
- All dependencies must be in the container image or installed in the script

### 2. The Train → Register → Deploy Lifecycle

The standard production workflow is three stages:

```
S3 (training data)
    ↓
Training Job  →  S3 (model.tar.gz)
    ↓
Model Registry (versioned, with approval state)
    ↓
Endpoint (real-time) or Batch Transform
```

Each stage is a separate SageMaker resource. You can skip the registry for quick experiments, but production models should always go through it for audit trail and approval workflow purposes.

### 3. Estimators Are the SDK Entry Point for Training

The SageMaker Python SDK (not the AWS SDK v3 — see note below) uses "Estimators" as the abstraction for training jobs. An Estimator wraps your script, the container, the instance type, and the hyperparameters. Calling `.fit()` on an Estimator submits a training job.

For Node.js/TypeScript workloads (server-side orchestration, not the training script itself), you use `@aws-sdk/client-sagemaker` to create training jobs, query their status, create endpoints, and invoke them.

### 4. Endpoints Are NOT Serverless by Default

Real-time endpoints run on EC2 instances 24/7 regardless of traffic. A single `ml.m5.large` endpoint running idle for a month costs ~$83. For development and staging environments with infrequent traffic, use **Serverless Inference** instead — it costs nothing when idle and scales to zero automatically.

The trade-off: serverless endpoints have cold starts of 30-60 seconds after periods of inactivity. For production interactive use cases, real-time endpoints (or serverless with provisioned concurrency) are required.

### 5. The Feature Store Has Two Faces

SageMaker Feature Store maintains two synchronized stores for the same feature data:

- **Online store**: Low-latency key-value store for real-time inference (sub-millisecond reads). Backed by DynamoDB internally.
- **Offline store**: Historical feature values in S3 in Parquet format. Used for training data generation.

Features are written once to both stores simultaneously via `PutRecord`. At inference time, your endpoint reads from the online store. At training time, you query the offline store to generate a point-in-time correct training dataset (avoiding data leakage from future feature values).

---

## Common Patterns

### Pattern 1: Submit a Training Job (AWS SDK v3)

Use this when orchestrating SageMaker from a Node.js backend or Lambda function. The training script itself is Python — you're just submitting and monitoring the job.

```typescript
import {
  SageMakerClient,
  CreateTrainingJobCommand,
  DescribeTrainingJobCommand,
  type TrainingJobStatus,
} from "@aws-sdk/client-sagemaker";

const client = new SageMakerClient({ region: "us-east-1" });

async function submitTrainingJob(params: {
  jobName: string;
  roleArn: string;
  s3InputUri: string;   // e.g. "s3://my-bucket/training-data/"
  s3OutputUri: string;  // e.g. "s3://my-bucket/model-artifacts/"
  imageUri: string;     // ECR URI for your training container
  hyperparameters?: Record<string, string>;
}): Promise<string> {
  const { jobName, roleArn, s3InputUri, s3OutputUri, imageUri, hyperparameters = {} } = params;

  const command = new CreateTrainingJobCommand({
    TrainingJobName: jobName,
    RoleArn: roleArn,
    AlgorithmSpecification: {
      TrainingImage: imageUri,
      TrainingInputMode: "File", // or "Pipe" for large streaming datasets
    },
    InputDataConfig: [
      {
        ChannelName: "training",
        DataSource: {
          S3DataSource: {
            S3DataType: "S3Prefix",
            S3Uri: s3InputUri,
            S3DataDistributionType: "FullyReplicated",
          },
        },
        ContentType: "text/csv",
      },
    ],
    OutputDataConfig: {
      S3OutputPath: s3OutputUri,
    },
    ResourceConfig: {
      InstanceType: "ml.m5.xlarge",
      InstanceCount: 1,
      VolumeSizeInGB: 30,
    },
    StoppingCondition: {
      MaxRuntimeInSeconds: 3600, // 1 hour max
    },
    HyperParameters: hyperparameters,
    // Enable Spot training for 70-90% cost savings:
    EnableManagedSpotTraining: true,
    CheckpointConfig: {
      S3Uri: `${s3OutputUri}/checkpoints/`,
    },
    StoppingCondition: {
      MaxRuntimeInSeconds: 3600,
      MaxWaitTimeInSeconds: 7200, // Max time to wait for Spot capacity
    },
  });

  await client.send(command);
  return jobName;
}

// Poll training job status
async function waitForTrainingJob(jobName: string): Promise<TrainingJobStatus> {
  const terminalStates = new Set<TrainingJobStatus>([
    "Completed", "Failed", "Stopped",
  ]);

  while (true) {
    const response = await client.send(
      new DescribeTrainingJobCommand({ TrainingJobName: jobName })
    );

    const status = response.TrainingJobStatus as TrainingJobStatus;
    console.log(`Job ${jobName}: ${status} — ${response.SecondaryStatus}`);

    if (terminalStates.has(status)) {
      if (status === "Failed") {
        throw new Error(`Training job failed: ${response.FailureReason}`);
      }
      return status;
    }

    // Poll every 30 seconds — use EventBridge or CloudWatch Events for production
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}
```

**For production**, don't poll in a loop — set up an EventBridge rule to trigger a Lambda when job state changes to `Completed` or `Failed`.

### Pattern 2: Create and Invoke a Real-Time Endpoint

```typescript
import {
  SageMakerClient,
  CreateModelCommand,
  CreateEndpointConfigCommand,
  CreateEndpointCommand,
  DescribeEndpointCommand,
} from "@aws-sdk/client-sagemaker";
import {
  SageMakerRuntimeClient,
  InvokeEndpointCommand,
} from "@aws-sdk/client-sagemaker-runtime";

const smClient = new SageMakerClient({ region: "us-east-1" });
const runtimeClient = new SageMakerRuntimeClient({ region: "us-east-1" });

async function deployModel(params: {
  modelName: string;
  endpointName: string;
  roleArn: string;
  modelArtifactsS3Uri: string; // Output from training job
  containerImageUri: string;
  instanceType?: string;
}): Promise<void> {
  const {
    modelName,
    endpointName,
    roleArn,
    modelArtifactsS3Uri,
    containerImageUri,
    instanceType = "ml.m5.large",
  } = params;

  // Step 1: Create the model resource
  await smClient.send(new CreateModelCommand({
    ModelName: modelName,
    ExecutionRoleArn: roleArn,
    PrimaryContainer: {
      Image: containerImageUri,
      ModelDataUrl: modelArtifactsS3Uri,
      Environment: {
        SAGEMAKER_PROGRAM: "inference.py",
        SAGEMAKER_SUBMIT_DIRECTORY: "/opt/ml/code",
      },
    },
  }));

  // Step 2: Create an endpoint config (defines instance type + model mapping)
  const configName = `${endpointName}-config`;
  await smClient.send(new CreateEndpointConfigCommand({
    EndpointConfigName: configName,
    ProductionVariants: [
      {
        VariantName: "primary",
        ModelName: modelName,
        InstanceType: instanceType,
        InitialInstanceCount: 1,
        InitialVariantWeight: 1,
      },
    ],
  }));

  // Step 3: Create the endpoint (launches instances — takes 5-10 minutes)
  await smClient.send(new CreateEndpointCommand({
    EndpointName: endpointName,
    EndpointConfigName: configName,
  }));

  // Wait for endpoint to be InService
  let status = "Creating";
  while (status === "Creating" || status === "Updating") {
    await new Promise((r) => setTimeout(r, 30_000));
    const desc = await smClient.send(
      new DescribeEndpointCommand({ EndpointName: endpointName })
    );
    status = desc.EndpointStatus ?? "Unknown";
    console.log(`Endpoint ${endpointName}: ${status}`);
  }

  if (status !== "InService") {
    throw new Error(`Endpoint creation failed with status: ${status}`);
  }
}

// Invoke the endpoint for inference
async function invokeEndpoint(
  endpointName: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const command = new InvokeEndpointCommand({
    EndpointName: endpointName,
    ContentType: "application/json",
    Accept: "application/json",
    Body: Buffer.from(JSON.stringify(payload)),
  });

  const response = await runtimeClient.send(command);

  if (!response.Body) throw new Error("No body in response");

  const bodyText = Buffer.from(response.Body).toString("utf-8");
  return JSON.parse(bodyText);
}
```

### Pattern 3: Serverless Endpoint (Zero Cost When Idle)

Prefer serverless for dev/staging or production workloads with infrequent traffic. The endpoint charges only when invoked.

```typescript
import {
  SageMakerClient,
  CreateEndpointConfigCommand,
  CreateEndpointCommand,
} from "@aws-sdk/client-sagemaker";

const client = new SageMakerClient({ region: "us-east-1" });

async function createServerlessEndpoint(params: {
  endpointName: string;
  modelName: string; // Pre-existing SageMaker model resource
  memorySizeMb?: 1024 | 2048 | 3072 | 4096 | 5120 | 6144; // Must be one of these values
  maxConcurrency?: number; // 1-200
}): Promise<void> {
  const {
    endpointName,
    modelName,
    memorySizeMb = 2048,
    maxConcurrency = 10,
  } = params;

  const configName = `${endpointName}-serverless-config`;

  await client.send(new CreateEndpointConfigCommand({
    EndpointConfigName: configName,
    ProductionVariants: [
      {
        VariantName: "serverless",
        ModelName: modelName,
        // No InstanceType or InitialInstanceCount for serverless
        ServerlessConfig: {
          MemorySizeInMB: memorySizeMb,
          MaxConcurrency: maxConcurrency,
        },
      },
    ],
  }));

  await client.send(new CreateEndpointCommand({
    EndpointName: endpointName,
    EndpointConfigName: configName,
  }));
}
```

**Memory size determines cost and available vCPU.** Serverless pricing: $0.00002 per GB-second. A 2 GB endpoint invocation taking 1 second costs $0.00004. Cold starts are 30-60 seconds after idle periods — unacceptable for interactive production use, but fine for background scoring or internal APIs.

### Pattern 4: Write to Feature Store

```typescript
import {
  SageMakerFeatureStoreRuntimeClient,
  PutRecordCommand,
  GetRecordCommand,
} from "@aws-sdk/client-sagemaker-featurestore-runtime";

const client = new SageMakerFeatureStoreRuntimeClient({ region: "us-east-1" });

// Write a feature record (written to both online and offline store simultaneously)
async function writeFeatures(params: {
  featureGroupName: string;
  entityId: string;
  features: Record<string, string | number>;
  eventTime?: Date;
}): Promise<void> {
  const { featureGroupName, entityId, features, eventTime = new Date() } = params;

  const record = [
    // Every feature group requires these two system features:
    { FeatureName: "entity_id", ValueAsString: entityId },
    { FeatureName: "event_time", ValueAsString: eventTime.toISOString() },
    // Your domain features:
    ...Object.entries(features).map(([name, value]) => ({
      FeatureName: name,
      ValueAsString: String(value),
    })),
  ];

  await client.send(new PutRecordCommand({
    FeatureGroupName: featureGroupName,
    Record: record,
  }));
}

// Read latest feature values for an entity (from online store — sub-millisecond)
async function getFeatures(
  featureGroupName: string,
  entityId: string,
  featureNames?: string[]
): Promise<Record<string, string>> {
  const command = new GetRecordCommand({
    FeatureGroupName: featureGroupName,
    RecordIdentifierValueAsString: entityId,
    ...(featureNames ? { FeatureNames: featureNames } : {}),
  });

  const response = await client.send(command);

  return Object.fromEntries(
    (response.Record ?? []).map((f) => [f.FeatureName ?? "", f.ValueAsString ?? ""])
  );
}
```

---

## Gotchas

### 1. Real-Time Endpoints Run 24/7 — They Are Expensive When Idle

The most common SageMaker cost shock. A real-time endpoint on `ml.m5.large` costs ~$0.115/hr whether it receives one request/minute or 10,000/minute. For dev and staging, delete endpoints when not in use or switch to serverless endpoints. Production endpoints that receive <1 req/min should use serverless — the cold start trade-off is worth it at that traffic level.

**Automate cleanup:** Tag endpoints with an expiry date and run a daily Lambda that deletes expired endpoints.

### 2. Notebook Instances Do Not Auto-Stop

Unlike Studio notebooks (which can be configured to auto-stop), classic notebook instances keep running indefinitely after you close the browser tab. A forgotten `ml.p3.2xlarge` notebook costs ~$92/day. Set up a Lambda + EventBridge rule to automatically stop notebook instances idle for more than N hours using CloudWatch metrics. Better yet: migrate to Studio and use the auto-shutdown extension.

### 3. Training Data Must Live in S3 — Not Local Disk

SageMaker training jobs run in managed containers on isolated EC2 instances. Your local filesystem is not accessible. All training data must be in S3 before submitting a job. SageMaker downloads the data to the instance's local storage at job start (for `File` input mode) or streams it via `Pipe` mode for large datasets.

The script receives the S3 data path via the `SM_CHANNEL_TRAINING` environment variable (maps to `/opt/ml/input/data/training/` inside the container). Write model artifacts to `/opt/ml/model/` — SageMaker tars and uploads this directory to S3 on job completion.

### 4. Model Artifacts Must Match the Serving Container's Expected Format

When you deploy a model, the serving container must know how to load your artifact. Built-in containers (XGBoost, sklearn, PyTorch, TensorFlow) expect specific artifact structures:
- **PyTorch**: `model.pth` or a `code/` directory with `inference.py`
- **TensorFlow**: SavedModel directory structure
- **XGBoost**: `xgboost-model` file (no extension)
- **sklearn**: `model.joblib` or `model.pkl`

A model artifact that works in training will silently fail to load in the endpoint if the format doesn't match what the serving container expects. Test the serving container locally with `docker run` before deploying.

### 5. Serverless Inference Cold Starts Are 30-60 Seconds

After a period of inactivity (~5 minutes with no requests), serverless endpoints scale to zero. The next invocation triggers a cold start that can take 30-60 seconds before the model is loaded and ready to respond. This is not configurable. For production interactive endpoints, use real-time instances or enable Provisioned Concurrency on your serverless endpoint (keeps N instances warm, costs money while provisioned).

### 6. The SageMaker Python SDK Is Separate From AWS SDK v3

Most SageMaker tutorials and documentation examples use the `sagemaker` Python SDK (`import sagemaker`), not `boto3` or the AWS SDK v3. The Python SDK is a higher-level abstraction with Estimators, Predictors, and Pipeline steps. It is only useful in Python environments (notebooks, training scripts, Lambda with Python runtime).

For Node.js/TypeScript, use `@aws-sdk/client-sagemaker` for control-plane operations (create training jobs, create endpoints, query status) and `@aws-sdk/client-sagemaker-runtime` for invoking endpoints. There is no Node.js equivalent of the SageMaker Python SDK's high-level abstractions.

### 7. Spot Training Interruptions Require Checkpointing

Spot training instances can be reclaimed by AWS with 2 minutes' notice. If your training job does not write checkpoints to S3, an interruption means restarting from zero. Always implement checkpointing for any training job over 30 minutes:

- Write checkpoint files to the path in `SM_CHECKPOINT_DIR` (`/opt/ml/checkpoints/`)
- SageMaker syncs this directory to S3 automatically
- On restart, SageMaker restores the checkpoint directory before running your script

Without checkpointing, a 4-hour training job interrupted at hour 3 restarts from the beginning.

### 8. Endpoint Updates Are In-Place With a Rolling Window

When you update an endpoint to use a new model version (by changing the endpoint config), SageMaker performs a rolling update: it brings up new instances with the new config, shifts traffic over, and terminates old instances. The endpoint stays InService during the update. The update takes 5-15 minutes. Do not poll `DescribeEndpoint` in a tight loop — use EventBridge to catch the state transition.

If the new config fails to launch (e.g., container fails health check), SageMaker rolls back to the previous config automatically.

### 9. IAM Role Requires Specific S3 and ECR Permissions

The SageMaker execution role needs:
- `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on your data and artifact buckets
- `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage`, `ecr:GetAuthorizationToken` if using custom containers
- `sagemaker:*` for the role to create sub-resources on your behalf
- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` for CloudWatch

The managed policy `AmazonSageMakerFullAccess` grants all of this but is broad. For production, scope the S3 permissions to specific bucket ARNs.

### 10. Feature Group Offline Store Has a ~15-Minute Lag

Records written to the feature store via `PutRecord` are immediately queryable in the online store (sub-millisecond reads). However, the offline store in S3 (Parquet files) is updated asynchronously with a lag of approximately 15 minutes. If you query the offline store immediately after writing, you will not see recent records. The offline store is for training data generation (historical data), not for real-time use — use the online store for that.

### 11. Model Monitor Requires Baseline Statistics From Training Data

SageMaker Model Monitor detects data drift on live endpoint traffic by comparing it against a baseline you provide. The baseline must be generated from your training data distribution using a `CreateBaselineJob` before enabling monitoring. Without the baseline, monitoring cannot detect drift. Run baseline generation as part of your training pipeline, not after deployment.

---

## Official Documentation

- **SageMaker Developer Guide** — https://docs.aws.amazon.com/sagemaker/latest/dg/
- **SageMaker Pricing** — https://aws.amazon.com/sagemaker/pricing/
- **Endpoint Types Comparison** — https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html
- **Serverless Inference** — https://docs.aws.amazon.com/sagemaker/latest/dg/serverless-endpoints.html
- **Async Inference** — https://docs.aws.amazon.com/sagemaker/latest/dg/async-inference.html
- **Batch Transform** — https://docs.aws.amazon.com/sagemaker/latest/dg/batch-transform.html
- **SageMaker Pipelines** — https://docs.aws.amazon.com/sagemaker/latest/dg/pipelines.html
- **Feature Store** — https://docs.aws.amazon.com/sagemaker/latest/dg/feature-store.html
- **Model Registry** — https://docs.aws.amazon.com/sagemaker/latest/dg/model-registry.html
- **Model Monitor** — https://docs.aws.amazon.com/sagemaker/latest/dg/model-monitor.html
- **Spot Training** — https://docs.aws.amazon.com/sagemaker/latest/dg/model-managed-spot-training.html
- **SDK v3 — @aws-sdk/client-sagemaker** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sagemaker/
- **SDK v3 — @aws-sdk/client-sagemaker-runtime** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sagemaker-runtime/
- **SDK v3 — @aws-sdk/client-sagemaker-featurestore-runtime** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sagemaker-featurestore-runtime/
