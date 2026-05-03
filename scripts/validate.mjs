#!/usr/bin/env node

/**
 * Validates all SKILL.md files for structure, frontmatter, and token count.
 */

import { readFileSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MAX_TOKENS = 8000; // ~4 chars per token
const MAX_CHARS = MAX_TOKENS * 4;

const REQUIRED_SECTIONS = [
  "What It Is",
  "Service Surface",
  "Mental Model",
  "Common Patterns",
  "Gotchas",
  "Official Documentation",
];

const REQUIRED_FRONTMATTER = ["name", "description"];

function extractFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { yaml: null, body: markdown };
  return { yaml: match[1], body: match[2] };
}

function main() {
  const skillsDir = join(ROOT, "skills");
  let dirs;
  try {
    dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  } catch (err) {
    console.error(`Cannot read skills directory: ${err.message}`);
    process.exit(1);
  }

  let totalErrors = 0;
  let totalWarnings = 0;
  let skillCount = 0;

  for (const dir of dirs) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    let content;
    try {
      content = readFileSync(skillPath, "utf-8");
    } catch {
      continue; // Skip directories without SKILL.md
    }

    skillCount++;
    const errors = [];
    const warnings = [];

    // Check frontmatter
    const { yaml, body } = extractFrontmatter(content);
    if (!yaml) {
      errors.push("Missing YAML frontmatter");
    } else {
      for (const field of REQUIRED_FRONTMATTER) {
        if (!yaml.includes(`${field}:`)) {
          errors.push(`Missing required frontmatter field: ${field}`);
        }
      }
      if (!yaml.includes("pathPatterns") && !yaml.includes("bashPatterns")) {
        warnings.push("No pathPatterns or bashPatterns — skill won't auto-inject");
      }
      if (!yaml.includes("priority:")) {
        warnings.push("No priority set — defaults to 5");
      }
    }

    // Check body sections
    for (const section of REQUIRED_SECTIONS) {
      // Check for ## heading with the section name (case-insensitive partial match)
      const sectionRegex = new RegExp(`^##\\s+.*${section.replace(/\s+/g, "\\s+")}`, "im");
      if (!sectionRegex.test(body)) {
        warnings.push(`Missing section: "${section}"`);
      }
    }

    // Check body size
    const bodyChars = body.length;
    const estimatedTokens = Math.ceil(bodyChars / 4);
    if (estimatedTokens > MAX_TOKENS) {
      errors.push(`Body too large: ~${estimatedTokens} tokens (max ${MAX_TOKENS})`);
    }
    if (estimatedTokens < 200) {
      warnings.push(`Body very short: ~${estimatedTokens} tokens (target 3000-8000)`);
    }

    // Check for AWS SDK v2 patterns in examples
    if (body.includes("require('aws-sdk')") || body.includes('from "aws-sdk"') || body.includes("from 'aws-sdk'")) {
      errors.push("Contains AWS SDK v2 import in examples — use @aws-sdk/client-* (v3)");
    }

    // Report
    if (errors.length > 0 || warnings.length > 0) {
      console.log(`\n${dir}/SKILL.md (~${estimatedTokens} tokens):`);
      for (const e of errors) {
        console.log(`  ERROR: ${e}`);
        totalErrors++;
      }
      for (const w of warnings) {
        console.log(`  WARN:  ${w}`);
        totalWarnings++;
      }
    }
  }

  console.log(`\n--- Validation Summary ---`);
  console.log(`Skills: ${skillCount}`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`Warnings: ${totalWarnings}`);

  if (totalErrors > 0) {
    process.exit(1);
  }
}

main();
