# Quick Start (60 seconds)

## 1. Install

```bash
claude plugin add github:andrewm621/aws-context-pack
```

## 2. Verify

Start Claude Code in any AWS project. You should see the AWS knowledge graph load on session start.

## 3. Test

Try these to see skills inject:

- Open a `serverless.yml` file → Lambda + API Gateway skills inject
- Run `cdk deploy` → CDK skill injects
- Ask "How do I set up DynamoDB single-table design?" → DynamoDB skill injects

## 4. Check Detection

The profiler auto-detects your project type. It looks for:

| File / Pattern | Skills Loaded |
|----------------|---------------|
| `cdk.json` | CDK + CloudFormation |
| `serverless.yml` | Lambda + API Gateway |
| `template.yaml` | CloudFormation + Lambda |
| `@aws-sdk/client-*` in `package.json` | Matching service skills |

## That's It

The plugin works automatically. No configuration needed. Skills inject contextually as you work.

---

### Optional: Verify Skill Injection

Run this to see which skills are currently active:

```bash
claude plugin status aws-context-pack
```

### Optional: Manual Trigger

Force-inject a specific skill if you want it without a matching file trigger:

```bash
claude --skill aws/dynamodb "How should I model this access pattern?"
```
