---
name: bedrock
description: Amazon Bedrock guidance — foundation models, agents, knowledge bases, guardrails, fine-tuning, model evaluation. Use when building AI/ML features on AWS.
metadata:
  priority: 7
  docs:
    - "https://docs.aws.amazon.com/bedrock/latest/userguide/"
  pathPatterns:
    - 'bedrock/**'
    - 'ai/**'
    - 'ml/**'
    - 'agents/**'
  bashPatterns:
    - '\baws\s+bedrock\b'
    - '\baws\s+bedrock-runtime\b'
    - '\baws\s+bedrock-agent\b'
  importPatterns:
    - "@aws-sdk/client-bedrock"
    - "@aws-sdk/client-bedrock-runtime"
    - "@aws-sdk/client-bedrock-agent"
    - "@aws-sdk/client-bedrock-agent-runtime"
  promptSignals:
    phrases:
      - "bedrock"
      - "foundation model"
      - "claude on aws"
      - "bedrock agent"
      - "knowledge base"
      - "bedrock guardrail"
      - "model invocation"
      - "bedrock fine-tuning"
      - "titan"
      - "anthropic on bedrock"
---

## What It Is & When to Use It

Amazon Bedrock is a fully managed AWS service that provides API access to foundation models (FMs) from Anthropic, Meta, Amazon, Mistral, Cohere, Stability AI, and others — without managing any infrastructure. You call an API, pay per token (or provisioned throughput), and AWS handles capacity, scaling, and compliance.

**Use Bedrock when:**
- You need AI/ML in an AWS-native architecture and want IAM-controlled access (no separate API key management)
- Your organization requires data residency, VPC isolation, or SOC2/HIPAA compliance for model invocations
- You want CloudWatch logging of every model invocation for audit trails
- You're building agentic systems (Bedrock Agents handle the orchestration loop, memory, and tool calling natively)
- You need RAG without standing up your own vector database (Bedrock Knowledge Bases manages ingestion, embedding, and retrieval)
- You want content safety enforcement centrally via Guardrails rather than in application code

**Do not use Bedrock when:**
- You need real-time, sub-100ms latency — Bedrock adds 50-200ms overhead vs direct API calls
- You want the absolute latest Claude model features the moment Anthropic ships them — Bedrock model versions lag direct API by days to weeks
- You're running a tiny prototype and don't need AWS compliance features — direct Anthropic API is simpler
- You need models not yet on Bedrock (availability lags direct provider APIs)

---

## Service Surface

### Model Families

| Provider | Models | Modalities | Fine-tunable | Notes |
|---|---|---|---|---|
| Anthropic | Claude 3.5 Haiku, Claude 3.5 Sonnet, Claude 3.7 Sonnet, Claude 3 Opus | Text, vision | No (on Bedrock) | Highest quality; most expensive |
| Meta | Llama 3 8B, 70B; Llama 3.1 8B, 70B, 405B | Text | Yes | Open-weight; good price/perf |
| Amazon | Titan Text Lite, Express, Premier; Titan Embeddings V2; Titan Image Generator | Text, image, embeddings | Yes (Titan Text) | AWS-native; lowest cost text |
| Mistral AI | Mistral 7B, Mixtral 8x7B, Mistral Large | Text | No | Strong European data residency story |
| Cohere | Command R, Command R+ | Text | Yes | RAG-optimized; strong retrieval |
| Stability AI | Stable Diffusion XL, SD3 | Image generation | No | Image-only |
| AI21 Labs | Jamba 1.5 Mini, Large | Text | No | Long context (256K) |

### Approximate Pricing (per 1M tokens, on-demand, us-east-1)

| Model | Input | Output |
|---|---|---|
| Claude 3.5 Haiku | $0.80 | $4.00 |
| Claude 3.5 Sonnet | $3.00 | $15.00 |
| Claude 3.7 Sonnet | $3.00 | $15.00 |
| Claude 3 Opus | $15.00 | $75.00 |
| Llama 3.1 70B | $2.65 | $3.50 |
| Llama 3.1 8B | $0.22 | $0.22 |
| Titan Text Lite | $0.15 | $0.20 |
| Titan Embeddings V2 | $0.02 | — |
| Command R+ | $3.00 | $15.00 |

Prices change frequently. Always check: https://aws.amazon.com/bedrock/pricing/

### Key Limits (on-demand, new accounts)

- Request size: 4 MB maximum
- Claude 3.5 Sonnet: often starts at 5-10 RPM / 100K TPM — request increases immediately
- Context window: Claude 3.5/3.7 Sonnet = 200K tokens; Llama 3.1 405B = 128K; Titan Text = 8K
- Bedrock Agents action group Lambda timeout: 60 seconds hard limit
- Knowledge Base document size: 5 MB per file, 50K files per data source
- Guardrail latency overhead: 50-150ms per invocation

### Bedrock Feature Set

| Feature | What It Does | When to Use |
|---|---|---|
| **InvokeModel** | Single-call synchronous inference | Batch processing, server-side transforms |
| **InvokeModelWithResponseStream** | Streaming inference | User-facing chat, real-time output |
| **Converse / ConverseStream** | Unified multi-turn chat API (recommended) | All chat/conversation use cases |
| **Bedrock Agents** | Managed agent orchestration loop with tools + memory | Autonomous task execution |
| **Knowledge Bases** | Managed RAG: S3 → embed → vector store → retrieve | Document Q&A, enterprise search |
| **Guardrails** | Content filtering, denied topics, PII redaction | Any user-facing model deployment |
| **Model Evaluation** | Benchmark models against your data | Model selection, regression testing |
| **Custom Models** | Fine-tune supported models on your data | Domain adaptation |
| **Provisioned Throughput** | Reserved capacity for consistent throughput | Production workloads needing guaranteed RPM |
| **Cross-Region Inference** | Automatic multi-region routing for throughput | High-volume production |

---

## Mental Model

Five primitives. Understand these and the entire service makes sense.

### 1. Model Access is Opt-In Per Region

Every model in every region must be explicitly enabled before you can call it. This is a one-time console action per account per region — but it blocks API access until done. New accounts hit `AccessDeniedException` constantly because of this.

Enable models at: AWS Console → Bedrock → Model access → Request model access.

There is no SDK call to enable model access — it must be done via Console or CLI:
```bash
# There is no aws bedrock enable-model command — must use console or this workaround:
aws bedrock put-model-invocation-logging-configuration --logging-config '{}' --region us-east-1
# Actually enabling access requires Console UI or the bedrock:PutFoundationModelEntitlement API (not in CLI as of 2025)
```

### 2. Two Invocation Paths: InvokeModel vs Converse

**InvokeModel / InvokeModelWithResponseStream** — the raw path. You serialize the request body yourself in whatever format the specific model expects. Each model family has a different body format. Messy for multi-model code.

**Converse / ConverseStream** — the recommended unified path. One consistent request/response shape across all text models. Handles the format differences internally. Use this for all new code unless you have a reason not to.

```
InvokeModel: you → serialize JSON → model-specific format → raw bytes response → you deserialize
Converse:    you → standard messages array → Bedrock translates → standard response → you
```

Prefer `Converse` for chat/conversation. Use `InvokeModel` only for embeddings (Titan Embeddings has no Converse equivalent) or image generation.

### 3. Bedrock Agents = LLM + Tools + Knowledge Bases (AWS-Managed Loop)

A Bedrock Agent is not just an LLM — it's a full agent loop managed by AWS:
- You define **action groups** (Lambda functions the agent can call as tools)
- You attach **knowledge bases** (for RAG retrieval)
- You set a **system prompt** and the foundation model to use
- AWS handles: planning, tool calling, result parsing, memory (optional), multi-turn state

The agent runs iterations until it reaches a final answer or hits the 60-second Lambda timeout per step. You invoke it via `InvokeAgent` and get streaming events back. The agent may call your Lambdas multiple times before responding.

### 4. Knowledge Bases = Managed RAG Pipeline

Bedrock Knowledge Bases wires together the full RAG stack:
1. **Data source**: S3 bucket (PDFs, Word docs, HTML, markdown, CSV)
2. **Embedding model**: Titan Embeddings V2 (default) or Cohere Embed
3. **Vector store**: Amazon OpenSearch Serverless (default), Pinecone, Redis Enterprise, Aurora (pgvector), MongoDB Atlas
4. **Sync**: manual or scheduled — Bedrock crawls S3, chunks docs, embeds, upserts into vector store
5. **Retrieval**: `Retrieve` (get chunks) or `RetrieveAndGenerate` (get chunks + LLM synthesizes answer)

You pay for: embedding tokens, vector store costs (OpenSearch Serverless minimum ~$700/mo — use Pinecone or pgvector for cost-sensitive workloads), and LLM tokens for `RetrieveAndGenerate`.

### 5. Guardrails Apply at the API Layer, Not the Application Layer

A Guardrail is a named AWS resource with rules: denied topics, content filters (hate, violence, sexual content, insults — each with 0.0-1.0 threshold), word filters (regex or exact), PII detection with redact/block/anonymize, and grounding checks (hallucination detection).

You reference a Guardrail ID and version in your `Converse` or `InvokeModel` call. Bedrock applies it to both the user input and model output before you see either. If content is blocked, you get a specific stop reason instead of a model response. This lets you enforce safety centrally without application-layer string matching.

---

## Common Patterns

### Pattern 1: Basic Text Generation with Claude (Converse API)

```typescript
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ region: "us-east-1" });

async function generateText(userMessage: string): Promise<string> {
  const messages: Message[] = [
    {
      role: "user",
      content: [{ text: userMessage }],
    },
  ];

  const command = new ConverseCommand({
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages,
    system: [{ text: "You are a helpful assistant." }],
    inferenceConfig: {
      maxTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
    },
  });

  const response = await client.send(command);

  if (response.stopReason === "end_turn" && response.output?.message?.content) {
    const textBlock = response.output.message.content.find(
      (block) => "text" in block
    );
    if (textBlock && "text" in textBlock) {
      return textBlock.text ?? "";
    }
  }

  throw new Error(`Unexpected stop reason: ${response.stopReason}`);
}
```

**For multi-turn conversations**, accumulate the messages array and append both user messages and assistant responses before each call. Bedrock Converse is stateless — you send the full history every time.

```typescript
async function chat(history: Message[], newUserMessage: string): Promise<{ reply: string; updatedHistory: Message[] }> {
  const messages: Message[] = [
    ...history,
    { role: "user", content: [{ text: newUserMessage }] },
  ];

  const command = new ConverseCommand({
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages,
  });

  const response = await client.send(command);
  const assistantMessage = response.output?.message;

  if (!assistantMessage) throw new Error("No message in response");

  return {
    reply: assistantMessage.content?.find((b) => "text" in b) as any,
    updatedHistory: [...messages, assistantMessage],
  };
}
```

### Pattern 2: Streaming Response with Claude (ConverseStream)

Always use streaming for user-facing interfaces. The first token arrives in ~300-500ms; without streaming users wait for the full response (could be 10-30 seconds for long outputs).

```typescript
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ region: "us-east-1" });

async function streamText(
  userMessage: string,
  onChunk: (text: string) => void
): Promise<void> {
  const command = new ConverseStreamCommand({
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages: [
      { role: "user", content: [{ text: userMessage }] },
    ],
    inferenceConfig: { maxTokens: 2048 },
  });

  const response = await client.send(command);

  if (!response.stream) throw new Error("No stream in response");

  for await (const event of response.stream) {
    if (event.contentBlockDelta?.delta?.text) {
      onChunk(event.contentBlockDelta.delta.delta?.text ?? "");
    }

    if (event.messageStop) {
      // Stream complete — event.messageStop.stopReason has the reason
      break;
    }
  }
}

// Usage in a Next.js Route Handler (App Router):
export async function POST(req: Request): Promise<Response> {
  const { message } = await req.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      await streamText(message, (chunk) => {
        controller.enqueue(encoder.encode(chunk));
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
```

### Pattern 3: Knowledge Base Retrieval (RetrieveAndGenerate)

Use `RetrieveAndGenerate` when you want Bedrock to handle both the retrieval and the synthesis in one API call. Use `Retrieve` alone when you want to post-process chunks yourself before passing to the model.

```typescript
import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
  RetrieveCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";

const agentRuntimeClient = new BedrockAgentRuntimeClient({
  region: "us-east-1",
});

const KNOWLEDGE_BASE_ID = "ABCDEF1234"; // From Bedrock console
const MODEL_ARN =
  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0";

// Option A: Retrieve + Generate in one call
async function askKnowledgeBase(
  query: string,
  sessionId?: string
): Promise<{ answer: string; sessionId: string; citations: any[] }> {
  const command = new RetrieveAndGenerateCommand({
    input: { text: query },
    retrieveAndGenerateConfiguration: {
      type: "KNOWLEDGE_BASE",
      knowledgeBaseConfiguration: {
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        modelArn: MODEL_ARN,
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 5, // How many chunks to retrieve
          },
        },
        generationConfiguration: {
          promptTemplate: {
            textPromptTemplate:
              "Answer the question using only the provided context. If the context does not contain the answer, say so.\n\nContext:\n$search_results$\n\nQuestion: $query$",
          },
        },
      },
    },
    // Pass sessionId for multi-turn conversations within the same KB session
    ...(sessionId ? { sessionId } : {}),
  });

  const response = await agentRuntimeClient.send(command);

  return {
    answer: response.output?.text ?? "",
    sessionId: response.sessionId ?? "",
    citations: response.citations ?? [],
  };
}

// Option B: Retrieve only — get chunks, handle synthesis yourself
async function retrieveChunks(query: string): Promise<string[]> {
  const command = new RetrieveCommand({
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    retrievalQuery: { text: query },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: 10,
        overrideSearchType: "HYBRID", // Semantic + keyword (better recall)
      },
    },
  });

  const response = await agentRuntimeClient.send(command);

  return (response.retrievalResults ?? [])
    .filter((r) => (r.score ?? 0) > 0.5) // Filter low-confidence chunks
    .map((r) => r.content?.text ?? "");
}
```

**Hybrid search** (`overrideSearchType: "HYBRID"`) combines semantic similarity with BM25 keyword matching. Use it — it consistently outperforms pure vector search for enterprise Q&A.

### Pattern 4: Applying Guardrails

Guardrails are created in the console or via the Bedrock management client, then referenced by ID in inference calls.

```typescript
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockClient,
  CreateGuardrailCommand,
} from "@aws-sdk/client-bedrock";

// Step 1: Create a guardrail (one-time setup, usually done via console)
async function createGuardrail(): Promise<string> {
  const bedrockClient = new BedrockClient({ region: "us-east-1" });

  const command = new CreateGuardrailCommand({
    name: "production-safety-guardrail",
    description: "Production content safety rules",
    contentPolicyConfig: {
      filtersConfig: [
        { type: "SEXUAL", inputStrength: "HIGH", outputStrength: "HIGH" },
        { type: "VIOLENCE", inputStrength: "MEDIUM", outputStrength: "HIGH" },
        { type: "HATE", inputStrength: "HIGH", outputStrength: "HIGH" },
        { type: "INSULTS", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
        { type: "MISCONDUCT", inputStrength: "HIGH", outputStrength: "HIGH" },
        {
          type: "PROMPT_ATTACK",
          inputStrength: "HIGH",
          outputStrength: "NONE",
        },
      ],
    },
    topicPolicyConfig: {
      topicsConfig: [
        {
          name: "competitor-mentions",
          definition:
            "Any mention of or comparison to competing products or companies",
          examples: ["Tell me about [Competitor]", "How does this compare to [Competitor]"],
          type: "DENY",
        },
      ],
    },
    sensitiveInformationPolicyConfig: {
      piiEntitiesConfig: [
        { type: "EMAIL", action: "ANONYMIZE" },
        { type: "PHONE", action: "ANONYMIZE" },
        { type: "US_SOCIAL_SECURITY_NUMBER", action: "BLOCK" },
        { type: "CREDIT_DEBIT_CARD_NUMBER", action: "BLOCK" },
      ],
    },
    blockedInputMessaging: "I cannot process that request.",
    blockedOutputsMessaging: "I cannot provide that response.",
  });

  const response = await bedrockClient.send(command);
  return response.guardrailId ?? "";
}

// Step 2: Apply guardrail to inference calls
const runtimeClient = new BedrockRuntimeClient({ region: "us-east-1" });

async function safeGenerate(userMessage: string): Promise<string> {
  const GUARDRAIL_ID = "abc123def456"; // From createGuardrail() above
  const GUARDRAIL_VERSION = "DRAFT"; // or "1", "2", etc. after publishing

  const command = new ConverseCommand({
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages: [{ role: "user", content: [{ text: userMessage }] }],
    guardrailConfig: {
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
      trace: "enabled", // Returns guardrail trace data for debugging
    },
  });

  const response = await runtimeClient.send(command);

  // Check if guardrail blocked the response
  if (response.stopReason === "guardrail_intervened") {
    // response.trace?.guardrail has details on what triggered
    return "I'm not able to help with that topic.";
  }

  const textBlock = response.output?.message?.content?.find((b) => "text" in b);
  return textBlock && "text" in textBlock ? textBlock.text ?? "" : "";
}
```

---

## Gotchas

### 1. Model Access Must Be Explicitly Enabled — Every Model, Every Region

The single most common failure for new Bedrock users. You get `AccessDeniedException` with a message about not having access to the model. Fix: Console → Bedrock → Model access → enable the model. This can take a few minutes to propagate. There is no way to do this via the standard SDK/CLI — it requires the console or the `bedrock:PutFoundationModelEntitlement` API action which is not yet in the public CLI.

Do this as part of your AWS account bootstrap, not when your CI/CD pipeline fails at 2 AM.

### 2. Model Availability is Region-Specific

Claude 3.5/3.7 Sonnet is available in us-east-1, us-west-2, and a handful of EU/APAC regions. Llama 3.1 405B is only in certain regions. Titan Image Generator is us-east-1 only. Check the model availability table in the docs before choosing a primary region. For maximum Claude availability: us-east-1 first, us-west-2 second.

### 3. On-Demand Throttling is Aggressive on New Accounts

New accounts often start with limits as low as 1-5 RPM and 10K-100K TPM for Claude models. This will hit you in load tests and production spikes. Request limit increases via the Service Quotas console immediately after enabling model access — increases take 1-3 business days to approve. Request 10x your expected peak.

### 4. The Converse API is the Right Default — Not InvokeModel

`InvokeModel` requires you to serialize and deserialize the model-specific request/response format. Anthropic uses Messages API format, Llama uses a different format, Titan uses another. `ConverseCommand` abstracts all of this. For new code, always start with `Converse` / `ConverseStream`. The only exceptions: Titan Embeddings (no Converse support) and image generation models.

### 5. Bedrock Agents Have a 60-Second Lambda Timeout — Per Action Step

Each time a Bedrock Agent calls one of your action group Lambdas, that Lambda must respond within 60 seconds. This is a hard limit imposed by Bedrock, not configurable. If your action needs to do something slow (database query, external API call, file processing), design it to be async: start the work, return a job ID, and handle polling separately. Do not put slow synchronous operations in action group Lambdas.

### 6. Knowledge Base Sync is Manual or Scheduled — Not Real-Time

When you add or update files in the S3 data source, Bedrock does NOT automatically re-index. You must trigger a sync job via the console or `StartIngestionJob` API. Syncs can take minutes to hours depending on document volume. For production, trigger sync via S3 event notifications → Lambda → `StartIngestionJob`. Do not expect freshly uploaded documents to be queryable immediately.

### 7. OpenSearch Serverless Knowledge Bases Have a Minimum Cost Floor

If you let Bedrock create a vector store for you (the default), it provisions Amazon OpenSearch Serverless. That carries a minimum cost of ~$700/month even at zero usage (2 OCUs minimum). For development and cost-sensitive production workloads, use an external vector store: Pinecone, pgvector (Aurora or RDS), or MongoDB Atlas. You configure these as "custom" vector stores when creating the Knowledge Base.

### 8. Cross-Region Inference Requires Inference Profile ARNs, Not Model IDs

Cross-region inference routes traffic across multiple AWS regions for higher aggregate throughput. To use it, you reference an inference profile ARN (e.g., `arn:aws:bedrock:us-east-1::foundation-model/...` with the cross-region prefix) rather than a plain model ID. Inference profiles are listed in the Bedrock console under "Cross-region inference." This is worth setting up in production — it significantly raises your effective throughput ceiling without provisioned throughput.

### 9. Provisioned Throughput Requires a 1-Month Minimum Commitment

Provisioned Throughput gives you reserved model capacity (guaranteed RPM/TPM) but requires buying a minimum of 1 month upfront. It cannot be cancelled mid-term for a refund. Only buy Provisioned Throughput after you have real production traffic data showing your on-demand limits are a bottleneck. Do not buy it speculatively.

### 10. Model Invocation Logging Must Be Explicitly Enabled — But You Need It

By default, Bedrock logs nothing. No record of what prompts were sent, what responses came back, what tokens were consumed, or what guardrails triggered. For any production deployment, enable model invocation logging to S3 (full request/response bodies) and CloudWatch (metadata + token counts). This is essential for debugging production issues, cost attribution, and compliance audits.

Enable via: Console → Bedrock → Settings → Model invocation logging, or:

```typescript
import { BedrockClient, PutModelInvocationLoggingConfigurationCommand } from "@aws-sdk/client-bedrock";

const client = new BedrockClient({ region: "us-east-1" });

await client.send(new PutModelInvocationLoggingConfigurationCommand({
  loggingConfig: {
    cloudWatchConfig: {
      logGroupName: "/aws/bedrock/model-invocations",
      roleArn: "arn:aws:iam::123456789012:role/BedrockLoggingRole",
      largeDataDeliveryS3Config: {
        bucketName: "my-bedrock-logs",
        keyPrefix: "large-payloads/",
      },
    },
    s3Config: {
      bucketName: "my-bedrock-logs",
      keyPrefix: "invocations/",
    },
    textDataDeliveryEnabled: true,
    imageDataDeliveryEnabled: false,
    embeddingDataDeliveryEnabled: false,
  },
}));
```

### 11. Guardrail Trace Data is Only Available When You Request It

Set `trace: "enabled"` in your `guardrailConfig` during development. Without it, you only know a guardrail triggered — not which rule, not what content matched. The trace is not logged by default and only comes back in the API response. Log it in development; decide in production whether to store it (it contains the original blocked content, which may have PII implications).

### 12. Embedding Models Return Different Vector Dimensions

Titan Embeddings V2 returns 1024-dimensional vectors by default (configurable to 256 or 512). Cohere Embed returns 1024 by default. These must match your vector store's configured dimension when you create the index. Changing embedding models later requires re-embedding your entire corpus — there is no migration path. Pick your embedding model before you index production data and do not change it.

### 13. The Messages History in Converse is Stateless — You Own the Context Window

Bedrock Converse does not maintain conversation state between calls. You must send the full conversation history in every `messages` array. This means: you pay for all previous tokens every turn, and you will hit the context window limit eventually. Implement conversation summarization for long sessions — truncate or summarize old messages before they push you over the model's context limit.

---

## Official Documentation

- **Bedrock User Guide** — https://docs.aws.amazon.com/bedrock/latest/userguide/
- **Model Catalog & Availability** — https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html
- **Pricing** — https://aws.amazon.com/bedrock/pricing/
- **Converse API Reference** — https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html
- **Bedrock Agents Guide** — https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html
- **Knowledge Bases Guide** — https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html
- **Guardrails Guide** — https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html
- **Model Invocation Logging** — https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html
- **Cross-Region Inference** — https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html
- **Provisioned Throughput** — https://docs.aws.amazon.com/bedrock/latest/userguide/prov-throughput.html
- **SDK v3 — @aws-sdk/client-bedrock-runtime** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/
- **SDK v3 — @aws-sdk/client-bedrock-agent-runtime** — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-agent-runtime/
