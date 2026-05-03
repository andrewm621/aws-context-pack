#!/usr/bin/env node

/**
 * Generates generated/skill-catalog.md — a human-readable index of all skills.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function extractFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { yaml: null, body: markdown };
  return { yaml: match[1], body: match[2] };
}

function parseField(yaml, field) {
  const match = yaml.match(new RegExp(`${field}:\\s*(.+)`));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

function main() {
  const skillsDir = join(ROOT, "skills");
  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  const skills = [];
  for (const dir of dirs) {
    let raw;
    try {
      raw = readFileSync(join(skillsDir, dir, "SKILL.md"), "utf-8");
    } catch {
      continue;
    }

    const { yaml, body } = extractFrontmatter(raw);
    if (!yaml) continue;

    const name = parseField(yaml, "name") || dir;
    const description = parseField(yaml, "description") || "";
    const priority = parseField(yaml, "priority") || "5";
    const estimatedTokens = Math.ceil(body.length / 4);

    skills.push({ dir, name, description, priority, estimatedTokens });
  }

  const lines = [
    "# AWS Context Pack — Skill Catalog",
    "",
    `> Auto-generated on ${new Date().toISOString().split("T")[0]}. ${skills.length} skills.`,
    "",
    "| Skill | Priority | ~Tokens | Description |",
    "|-------|----------|---------|-------------|",
  ];

  for (const s of skills) {
    lines.push(`| \`${s.dir}\` | ${s.priority} | ${s.estimatedTokens} | ${s.description.slice(0, 100)} |`);
  }

  const outDir = join(ROOT, "generated");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "skill-catalog.md"), lines.join("\n") + "\n", "utf-8");

  console.log(`Generated skill-catalog.md — ${skills.length} skills`);
}

main();
