#!/usr/bin/env node

/**
 * UserPromptSubmit hook: Matches user prompts against skill promptSignals.
 * Injects relevant skills when users ask about AWS topics directly.
 *
 * Reads JSON from stdin: { prompt, session_id }
 * Writes JSON to stdout: { hookSpecificOutput: { hookEventName, additionalContext } }
 */

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");
const MAX_SKILLS = 2;
const INJECTION_BUDGET_BYTES = 8000;
const MIN_PROMPT_LENGTH = 10;

// ─── Utility Functions ───────────────────────────────────────────

function safeReadFile(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function extractFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { yaml: null, body: markdown };
  return { yaml: match[1], body: match[2] };
}

// ─── Session Deduplication ──────────────────────────────────────

function getSessionDedupPath(sessionId) {
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return join(tmpdir(), `aws-plugin-${hash}-seen-skills.txt`);
}

function getSeenSkills(sessionId) {
  if (!sessionId) return new Set();
  const path = getSessionDedupPath(sessionId);
  const content = safeReadFile(path);
  if (!content) return new Set();
  return new Set(content.split(",").filter(Boolean));
}

function addSeenSkills(sessionId, skills) {
  if (!sessionId || skills.length === 0) return;
  const seen = getSeenSkills(sessionId);
  for (const s of skills) seen.add(s);
  try {
    writeFileSync(getSessionDedupPath(sessionId), [...seen].join(","), "utf-8");
  } catch {}
}

// ─── Skill Map Loader ───────────────────────────────────────────

function loadPromptSignals() {
  // Load from manifest or parse SKILL.md files
  const manifest = safeReadJson(join(PLUGIN_ROOT, "generated", "skill-manifest.json"));
  const skills = manifest?.skills || {};

  // If no manifest, build from SKILL.md files
  if (Object.keys(skills).length === 0) {
    const skillsDir = join(PLUGIN_ROOT, "skills");
    try {
      const dirs = readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const dir of dirs) {
        const content = safeReadFile(join(skillsDir, dir, "SKILL.md"));
        if (!content) continue;
        const { yaml } = extractFrontmatter(content);
        if (!yaml) continue;

        // Quick parse for promptSignals and priority
        const phrasesMatch = yaml.match(/phrases:\s*\n((?:\s+-\s+.+\n?)*)/);
        const priorityMatch = yaml.match(/priority:\s*(\d+)/);
        if (phrasesMatch) {
          const phrases = phrasesMatch[1]
            .split("\n")
            .map(l => l.trim())
            .filter(l => l.startsWith("- "))
            .map(l => {
              let v = l.slice(2).trim();
              if ((v.startsWith('"') && v.endsWith('"')) ||
                  (v.startsWith("'") && v.endsWith("'"))) {
                v = v.slice(1, -1);
              }
              return v.toLowerCase();
            });

          if (phrases.length > 0) {
            skills[dir] = {
              ...skills[dir],
              priority: priorityMatch ? parseInt(priorityMatch[1], 10) : 5,
              promptSignals: { phrases },
            };
          }
        }
      }
    } catch {}
  }

  return skills;
}

// ─── Prompt Matching ────────────────────────────────────────────

function normalizePrompt(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function matchPromptSignals(normalizedPrompt, skillMap) {
  const matches = [];

  for (const [skill, config] of Object.entries(skillMap)) {
    const signals = config.promptSignals;
    if (!signals) continue;

    // Handle both { phrases: [...] } and direct array format
    const phrases = Array.isArray(signals) ? signals
      : Array.isArray(signals.phrases) ? signals.phrases
      : null;
    if (!phrases || phrases.length === 0) continue;

    let score = 0;
    let matchedPhrases = [];

    for (const phrase of phrases) {
      const normalizedPhrase = phrase.toLowerCase();
      if (normalizedPrompt.includes(normalizedPhrase)) {
        // Score based on phrase specificity (longer = more specific = higher score)
        const phraseScore = Math.max(3, normalizedPhrase.split(" ").length * 3);
        score += phraseScore;
        matchedPhrases.push(phrase);
      }
    }

    if (score > 0) {
      matches.push({
        skill,
        score,
        priority: config.priority || 5,
        reason: `phrases: ${matchedPhrases.join(", ")}`,
      });
    }
  }

  // Sort by score descending, then priority
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.priority || 0) - (a.priority || 0);
  });

  return matches;
}

// ─── Main Logic ─────────────────────────────────────────────────

function run() {
  let raw;
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    return "{}";
  }

  let input;
  try {
    input = JSON.parse(raw.trim());
  } catch {
    return "{}";
  }

  const prompt = input.prompt || input.message || "";
  const sessionId = input.session_id || input.conversation_id || "";

  if (prompt.length < MIN_PROMPT_LENGTH) return "{}";

  const normalizedPrompt = normalizePrompt(prompt);
  if (!normalizedPrompt) return "{}";

  // Load skill prompt signals
  const skillMap = loadPromptSignals();
  const matches = matchPromptSignals(normalizedPrompt, skillMap);

  if (matches.length === 0) return "{}";

  // Deduplicate
  const dedupOff = process.env.AWS_PLUGIN_HOOK_DEDUP === "off";
  const seenSkills = dedupOff ? new Set() : getSeenSkills(sessionId);
  const newMatches = dedupOff
    ? matches
    : matches.filter(m => !seenSkills.has(m.skill));

  if (newMatches.length === 0) return "{}";

  // Inject top skills
  const toInject = newMatches.slice(0, MAX_SKILLS);
  const parts = [];
  const loaded = [];
  let usedBytes = 0;

  for (const match of toInject) {
    const skillPath = join(PLUGIN_ROOT, "skills", match.skill, "SKILL.md");
    const content = safeReadFile(skillPath);
    if (!content) continue;

    const { body } = extractFrontmatter(content);
    const wrapped = body.trim();
    const byteLen = Buffer.byteLength(wrapped, "utf-8");

    if (loaded.length > 0 && usedBytes + byteLen > INJECTION_BUDGET_BYTES) continue;

    parts.push(wrapped);
    loaded.push(match.skill);
    usedBytes += byteLen;
  }

  if (parts.length === 0) return "{}";

  // Update dedup
  addSeenSkills(sessionId, loaded);

  // Build output
  const bannerLines = ["[aws-context-pack] Best practices auto-suggested based on prompt analysis:"];
  for (const skill of loaded) {
    const match = newMatches.find(m => m.skill === skill);
    if (match) {
      bannerLines.push(`  - "${skill}" matched: ${match.reason}`);
    }
  }

  const additionalContext = bannerLines.join("\n") + "\n\n" + parts.join("\n\n---\n\n");

  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };

  return JSON.stringify(output);
}

try {
  const output = run();
  process.stdout.write(output);
} catch (err) {
  process.stderr.write(`[aws-context-pack] prompt-inject error: ${err.message}\n`);
  process.stdout.write("{}");
}
