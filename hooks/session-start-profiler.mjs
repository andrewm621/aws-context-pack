#!/usr/bin/env node

/**
 * SessionStart hook: Detects AWS project markers in the working directory.
 * Sets AWS_PLUGIN_LIKELY_SKILLS env var for skill priority boosting.
 * Outputs user-facing messages about detected AWS project type.
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// File markers that indicate AWS service usage
const FILE_MARKERS = [
  { file: "cdk.json", skills: ["cdk", "cloudformation"] },
  { file: "cdk.context.json", skills: ["cdk"] },
  { file: "serverless.yml", skills: ["lambda", "api-gateway"] },
  { file: "serverless.yaml", skills: ["lambda", "api-gateway"] },
  { file: "serverless.ts", skills: ["lambda", "api-gateway"] },
  { file: "template.yaml", skills: ["cloudformation", "lambda"] },
  { file: "template.yml", skills: ["cloudformation", "lambda"] },
  { file: "samconfig.toml", skills: ["lambda", "cloudformation"] },
  { file: "samconfig.yaml", skills: ["lambda", "cloudformation"] },
  { file: "buildspec.yml", skills: ["codepipeline"] },
  { file: "buildspec.yaml", skills: ["codepipeline"] },
  { file: "appspec.yml", skills: ["codepipeline"] },
  { file: "taskdef.json", skills: ["ecs-fargate"] },
  { file: "Dockerrun.aws.json", skills: ["ecs-fargate"] },
  { file: ".aws/config", skills: ["iam"] },
  { file: "amplify.yml", skills: ["lambda", "cognito"] },
];

// Package.json dependency markers
const PACKAGE_MARKERS = {
  "aws-cdk-lib": ["cdk", "cloudformation"],
  "aws-cdk": ["cdk"],
  "@aws-cdk/core": ["cdk"],
  "constructs": ["cdk"],
  "@aws-sdk/client-s3": ["s3"],
  "@aws-sdk/client-dynamodb": ["dynamodb"],
  "@aws-sdk/lib-dynamodb": ["dynamodb"],
  "@aws-sdk/client-lambda": ["lambda"],
  "@aws-sdk/client-iam": ["iam"],
  "@aws-sdk/client-sts": ["iam"],
  "@aws-sdk/client-cognito-identity-provider": ["cognito"],
  "@aws-sdk/client-sqs": ["sqs-sns"],
  "@aws-sdk/client-sns": ["sqs-sns"],
  "@aws-sdk/client-sfn": ["step-functions"],
  "@aws-sdk/client-eventbridge": ["eventbridge"],
  "@aws-sdk/client-cloudwatch": ["cloudwatch"],
  "@aws-sdk/client-cloudwatch-logs": ["cloudwatch"],
  "@aws-sdk/client-bedrock-runtime": ["bedrock"],
  "@aws-sdk/client-bedrock": ["bedrock"],
  "@aws-sdk/client-bedrock-agent-runtime": ["bedrock"],
  "@aws-sdk/client-secrets-manager": ["secrets-kms"],
  "@aws-sdk/client-kms": ["secrets-kms"],
  "@aws-sdk/client-ec2": ["ec2", "vpc"],
  "@aws-sdk/client-ecs": ["ecs-fargate"],
  "@aws-sdk/client-rds": ["rds-aurora"],
  "@aws-sdk/client-elasticache": ["elasticache"],
  "@aws-sdk/client-cloudfront": ["cloudfront"],
  "@aws-sdk/client-route-53": ["route53"],
  "@aws-sdk/client-api-gateway": ["api-gateway"],
  "@aws-sdk/client-apigatewayv2": ["api-gateway"],
  "@aws-sdk/client-wafv2": ["waf-shield"],
  "serverless": ["lambda", "api-gateway"],
  "aws-sdk": ["aws-architecture"],  // v2 SDK — flag for migration
  "@middy/core": ["lambda"],
  "dynamoose": ["dynamodb"],
  "electrodb": ["dynamodb"],
};

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function profileProject(projectRoot) {
  const skills = new Set();

  // Check file markers
  for (const marker of FILE_MARKERS) {
    if (existsSync(join(projectRoot, marker.file))) {
      for (const s of marker.skills) skills.add(s);
    }
  }

  // Check package.json dependencies
  const pkg = safeReadJson(join(projectRoot, "package.json"));
  if (pkg) {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [dep, skillSlugs] of Object.entries(PACKAGE_MARKERS)) {
      if (dep in allDeps) {
        for (const s of skillSlugs) skills.add(s);
      }
    }
  }

  // Check requirements.txt / pyproject.toml for Python AWS projects
  const reqTxt = join(projectRoot, "requirements.txt");
  if (existsSync(reqTxt)) {
    try {
      const content = readFileSync(reqTxt, "utf-8");
      if (content.includes("boto3") || content.includes("botocore")) {
        skills.add("aws-architecture");
      }
      if (content.includes("aws-cdk")) skills.add("cdk");
    } catch {}
  }

  return [...skills].sort();
}

function main() {
  // Read stdin
  try {
    readFileSync(0, "utf-8");
  } catch {}

  const projectRoot = process.env.CLAUDE_PROJECT_ROOT || process.cwd();
  const likelySkills = profileProject(projectRoot);

  if (likelySkills.length > 0) {
    process.env.AWS_PLUGIN_LIKELY_SKILLS = likelySkills.join(",");

    // Check for AWS SDK v2 usage
    const hasV2 = likelySkills.includes("aws-architecture");
    const pkg = safeReadJson(join(projectRoot, "package.json"));
    const hasV2Sdk = pkg && (pkg.dependencies?.["aws-sdk"] || pkg.devDependencies?.["aws-sdk"]);

    const messages = [];

    if (hasV2Sdk) {
      messages.push(
        "WARNING: AWS SDK v2 (`aws-sdk`) detected. AWS SDK v2 entered maintenance mode in 2024 and will reach end-of-support in 2025. Migrate to AWS SDK v3 (`@aws-sdk/client-*`) for tree-shaking, modular imports, and active development."
      );
    }

    if (messages.length > 0) {
      process.stdout.write(messages.join("\n\n") + "\n");
    }
  }
}

main();
