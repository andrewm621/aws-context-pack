#!/usr/bin/env node

/**
 * PreToolUse hook: Matches file paths and bash commands against skill patterns.
 * Injects relevant SKILL.md content as additionalContext.
 *
 * Reads JSON from stdin: { tool_name, tool_input, session_id }
 * Writes JSON to stdout: { hookSpecificOutput: { hookEventName, additionalContext } }
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");
const MAX_SKILLS = 3;
const INJECTION_BUDGET_BYTES = 18000;
const SUPPORTED_TOOLS = ["Read", "Edit", "Write", "Bash"];

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

// ─── YAML Frontmatter Parser (minimal) ──────────────────────────

function extractFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { yaml: null, body: markdown };
  return { yaml: match[1], body: match[2] };
}

function parseSimpleYaml(yaml) {
  // Minimal YAML parser for skill frontmatter
  // Handles: scalars, arrays (block and inline), nested objects (1-2 levels)
  const result = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) { i++; continue; }

    const keyMatch = line.match(/^(\s*)(\w[\w.-]*)\s*:\s*(.*)/);
    if (!keyMatch) { i++; continue; }

    const [, indent, key, valueRaw] = keyMatch;
    const indentLevel = indent.length;
    const value = valueRaw.trim();

    if (value === "") {
      // Could be object or block array
      const nested = {};
      const arrayItems = [];
      let isArray = false;
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.trim() === "" || nextLine.trim().startsWith("#")) { i++; continue; }
        const nextIndent = nextLine.search(/\S/);
        if (nextIndent <= indentLevel) break;

        const trimmed = nextLine.trim();
        if (trimmed.startsWith("- ")) {
          isArray = true;
          const itemValue = trimmed.slice(2).trim();
          // Strip quotes
          if ((itemValue.startsWith("'") && itemValue.endsWith("'")) ||
              (itemValue.startsWith('"') && itemValue.endsWith('"'))) {
            arrayItems.push(itemValue.slice(1, -1));
          } else {
            arrayItems.push(itemValue);
          }
          i++;
        } else {
          // Nested key
          const nestedMatch = trimmed.match(/^(\w[\w.-]*)\s*:\s*(.*)/);
          if (nestedMatch) {
            const [, nk, nv] = nestedMatch;
            const nvTrimmed = nv.trim();
            if (nvTrimmed === "") {
              // Deeper nesting — collect as sub-object or array
              const subItems = [];
              i++;
              while (i < lines.length) {
                const subLine = lines[i];
                if (subLine.trim() === "") { i++; continue; }
                const subIndent = subLine.search(/\S/);
                if (subIndent <= nextIndent) break;
                const subTrimmed = subLine.trim();
                if (subTrimmed.startsWith("- ")) {
                  let sv = subTrimmed.slice(2).trim();
                  if ((sv.startsWith("'") && sv.endsWith("'")) ||
                      (sv.startsWith('"') && sv.endsWith('"'))) {
                    sv = sv.slice(1, -1);
                  }
                  subItems.push(sv);
                }
                i++;
              }
              nested[nk] = subItems.length > 0 ? subItems : "";
            } else {
              // Inline value
              let nval = nvTrimmed;
              if ((nval.startsWith("'") && nval.endsWith("'")) ||
                  (nval.startsWith('"') && nval.endsWith('"'))) {
                nval = nval.slice(1, -1);
              } else if (/^\d+$/.test(nval)) {
                nval = parseInt(nval, 10);
              }
              nested[nk] = nval;
              i++;
            }
          } else {
            i++;
          }
        }
      }
      result[key] = isArray ? arrayItems : nested;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      // Inline array
      const inner = value.slice(1, -1);
      result[key] = inner.split(",").map(s => {
        s = s.trim();
        if ((s.startsWith("'") && s.endsWith("'")) ||
            (s.startsWith('"') && s.endsWith('"'))) {
          return s.slice(1, -1);
        }
        return s;
      }).filter(Boolean);
      i++;
    } else {
      // Scalar
      let val = value;
      if ((val.startsWith("'") && val.endsWith("'")) ||
          (val.startsWith('"') && val.endsWith('"'))) {
        val = val.slice(1, -1);
      } else if (/^\d+$/.test(val)) {
        val = parseInt(val, 10);
      }
      result[key] = val;
      i++;
    }
  }

  return result;
}

// ─── Glob Pattern to Regex Converter ────────────────────────────

function globToRegex(pattern) {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        regex += "(?:.*\\/)?";
        i += 3;
      } else {
        regex += ".*";
        i += 2;
      }
    } else if (c === "*") {
      regex += "[^/]*";
      i++;
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (c === ".") {
      regex += "\\.";
      i++;
    } else if (c === "{") {
      regex += "(?:";
      i++;
    } else if (c === "}") {
      regex += ")";
      i++;
    } else if (c === ",") {
      regex += "|";
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp("(?:^|/)" + regex + "$");
}

// ─── Skill Map Builder ──────────────────────────────────────────

function buildSkillMap() {
  const skillsDir = join(PLUGIN_ROOT, "skills");
  const skills = {};

  let dirs;
  try {
    dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return skills;
  }

  for (const dir of dirs) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    const content = safeReadFile(skillPath);
    if (!content) continue;

    const { yaml } = extractFrontmatter(content);
    if (!yaml) continue;

    try {
      const parsed = parseSimpleYaml(yaml);
      const meta = parsed.metadata || {};

      skills[dir] = {
        name: parsed.name || dir,
        description: parsed.description || "",
        priority: typeof meta.priority === "number" ? meta.priority : 5,
        pathPatterns: Array.isArray(meta.pathPatterns) ? meta.pathPatterns : [],
        bashPatterns: Array.isArray(meta.bashPatterns) ? meta.bashPatterns : [],
        importPatterns: Array.isArray(meta.importPatterns) ? meta.importPatterns : [],
        promptSignals: meta.promptSignals || null,
        docs: Array.isArray(meta.docs) ? meta.docs : [],
      };
    } catch (err) {
      // Skip malformed skills silently
    }
  }

  return skills;
}

function loadSkillMap() {
  // Try manifest first (pre-built), fall back to parsing
  const manifest = safeReadJson(join(PLUGIN_ROOT, "generated", "skill-manifest.json"));
  if (manifest?.skills) return manifest.skills;
  return buildSkillMap();
}

// ─── Pattern Compilation & Matching ─────────────────────────────

function compileSkillPatterns(skillMap) {
  const compiled = [];
  for (const [skill, config] of Object.entries(skillMap)) {
    const compiledPaths = [];
    for (const pat of config.pathPatterns || []) {
      try {
        compiledPaths.push({ pattern: pat, regex: globToRegex(pat) });
      } catch {}
    }

    const compiledBash = [];
    for (const pat of config.bashPatterns || []) {
      try {
        compiledBash.push({ pattern: pat, regex: new RegExp(pat) });
      } catch {}
    }

    const compiledImports = [];
    for (const pat of config.importPatterns || []) {
      try {
        // Match import/require of the package
        const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[^/]*");
        compiledImports.push({
          pattern: pat,
          regex: new RegExp(`(?:from|require\\s*\\()\\s*['"]${escaped}`)
        });
      } catch {}
    }

    compiled.push({
      skill,
      priority: config.priority || 5,
      compiledPaths,
      compiledBash,
      compiledImports,
    });
  }
  return compiled;
}

function matchPath(filePath, compiledPaths) {
  for (const { pattern, regex } of compiledPaths) {
    if (regex.test(filePath)) {
      return { matchType: "path", pattern };
    }
  }
  // Also try just the basename
  const base = basename(filePath);
  for (const { pattern, regex } of compiledPaths) {
    if (regex.test(base)) {
      return { matchType: "basename", pattern };
    }
  }
  return null;
}

function matchBash(command, compiledBash) {
  for (const { pattern, regex } of compiledBash) {
    if (regex.test(command)) {
      return { matchType: "bash", pattern };
    }
  }
  return null;
}

function matchImport(content, compiledImports) {
  for (const { pattern, regex } of compiledImports) {
    if (regex.test(content)) {
      return { matchType: "import", pattern };
    }
  }
  return null;
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
    const path = getSessionDedupPath(sessionId);
    writeFileSync(path, [...seen].join(","), "utf-8");
  } catch {}
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

  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id || input.conversation_id || "";

  if (!SUPPORTED_TOOLS.includes(toolName)) return "{}";

  // Load and compile skills
  const skillMap = loadSkillMap();
  const compiledSkills = compileSkillPatterns(skillMap);

  // Match against tool input
  const matchedEntries = [];
  const matchReasons = {};

  if (["Read", "Edit", "Write"].includes(toolName)) {
    const filePath = toolInput.file_path || "";
    const contentParts = [];
    if (toolInput.content) contentParts.push(toolInput.content);
    if (toolInput.old_string) contentParts.push(toolInput.old_string);
    if (toolInput.new_string) contentParts.push(toolInput.new_string);
    const fileContent = contentParts.join("\n");

    for (const entry of compiledSkills) {
      const reason = matchPath(filePath, entry.compiledPaths);
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      } else if (fileContent && entry.compiledImports.length > 0) {
        const importReason = matchImport(fileContent, entry.compiledImports);
        if (importReason) {
          matchedEntries.push(entry);
          matchReasons[entry.skill] = importReason;
        }
      }
    }
  } else if (toolName === "Bash") {
    const command = toolInput.command || "";
    for (const entry of compiledSkills) {
      const reason = matchBash(command, entry.compiledBash);
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      }
    }
  }

  if (matchedEntries.length === 0) return "{}";

  // Deduplicate
  const dedupOff = process.env.AWS_PLUGIN_HOOK_DEDUP === "off";
  const seenSkills = dedupOff ? new Set() : getSeenSkills(sessionId);
  let newEntries = dedupOff
    ? matchedEntries
    : matchedEntries.filter(e => !seenSkills.has(e.skill));

  // Boost skills detected by profiler
  const likelySkills = new Set(
    (process.env.AWS_PLUGIN_LIKELY_SKILLS || "").split(",").filter(Boolean)
  );
  for (const entry of newEntries) {
    if (likelySkills.has(entry.skill)) {
      entry.effectivePriority = (entry.priority || 5) + 5;
    } else {
      entry.effectivePriority = entry.priority || 5;
    }
  }

  // Sort by priority descending
  newEntries.sort((a, b) => (b.effectivePriority || 0) - (a.effectivePriority || 0));

  // Inject skills (max 3, budget 18KB)
  const parts = [];
  const loaded = [];
  let usedBytes = 0;

  for (const entry of newEntries) {
    if (loaded.length >= MAX_SKILLS) break;

    const skillPath = join(PLUGIN_ROOT, "skills", entry.skill, "SKILL.md");
    const content = safeReadFile(skillPath);
    if (!content) continue;

    // Strip frontmatter for injection
    const { body } = extractFrontmatter(content);
    const wrapped = body.trim();
    const byteLen = Buffer.byteLength(wrapped, "utf-8");

    if (loaded.length > 0 && usedBytes + byteLen > INJECTION_BUDGET_BYTES) continue;

    parts.push(wrapped);
    loaded.push(entry.skill);
    usedBytes += byteLen;
  }

  if (parts.length === 0) return "{}";

  // Update dedup state
  addSeenSkills(sessionId, loaded);

  // Build output
  const toolTarget = toolName === "Bash"
    ? (toolInput.command || "").slice(0, 200)
    : (toolInput.file_path || "");

  const bannerLines = ["[aws-context-pack] Best practices auto-suggested based on detected patterns:"];
  for (const skill of loaded) {
    const reason = matchReasons[skill];
    if (reason) {
      bannerLines.push(`  - "${skill}" matched ${reason.matchType} pattern \`${reason.pattern}\` on ${toolName}: ${toolTarget}`);
    } else {
      bannerLines.push(`  - "${skill}"`);
    }
  }

  // Add docs links
  const docsLines = [];
  for (const skill of loaded) {
    const config = skillMap[skill];
    if (config?.docs?.length > 0) {
      docsLines.push(`  ${skill}: ${config.docs[0]}`);
    }
  }

  const sections = [bannerLines.join("\n")];
  if (docsLines.length > 0) {
    sections.push("Official docs:\n" + docsLines.join("\n"));
  }
  sections.push(parts.join("\n\n---\n\n"));

  const additionalContext = sections.join("\n\n");

  const metaComment = `<!-- skillInjection: ${JSON.stringify({
    version: 1,
    toolName,
    toolTarget,
    matchedSkills: matchedEntries.map(e => e.skill),
    injectedSkills: loaded,
  })} -->`;

  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: additionalContext + "\n" + metaComment,
    },
  };

  return JSON.stringify(output);
}

try {
  const output = run();
  process.stdout.write(output);
} catch (err) {
  process.stderr.write(`[aws-context-pack] pretooluse error: ${err.message}\n`);
  process.stdout.write("{}");
}
