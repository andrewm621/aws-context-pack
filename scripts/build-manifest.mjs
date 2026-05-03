#!/usr/bin/env node

/**
 * Parses all SKILL.md frontmatter and generates generated/skill-manifest.json.
 * This pre-built manifest speeds up hook execution (no YAML parsing at runtime).
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function extractFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return null;
  return match[1];
}

function parseSimpleYaml(yaml) {
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
          let itemValue = trimmed.slice(2).trim();
          if ((itemValue.startsWith("'") && itemValue.endsWith("'")) ||
              (itemValue.startsWith('"') && itemValue.endsWith('"'))) {
            itemValue = itemValue.slice(1, -1);
          }
          arrayItems.push(itemValue);
          i++;
        } else {
          const nestedMatch = trimmed.match(/^(\w[\w.-]*)\s*:\s*(.*)/);
          if (nestedMatch) {
            const [, nk, nv] = nestedMatch;
            const nvTrimmed = nv.trim();
            if (nvTrimmed === "") {
              const subItems = [];
              i++;
              while (i < lines.length) {
                const subLine = lines[i];
                if (subLine.trim() === "") { i++; continue; }
                const subIndent = subLine.search(/\S/);
                if (subIndent <= nextLine.search(/\S/)) break;
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

function globToRegexSource(pattern) {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") { regex += "(?:.*\\/)?"; i += 3; }
      else { regex += ".*"; i += 2; }
    } else if (c === "*") { regex += "[^/]*"; i++; }
    else if (c === "?") { regex += "[^/]"; i++; }
    else if (c === ".") { regex += "\\."; i++; }
    else if (c === "{") { regex += "(?:"; i++; }
    else if (c === "}") { regex += ")"; i++; }
    else if (c === ",") { regex += "|"; i++; }
    else { regex += c; i++; }
  }
  return "(?:^|/)" + regex + "$";
}

function main() {
  const skillsDir = join(ROOT, "skills");
  const skills = {};
  const errors = [];

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

  for (const dir of dirs) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    let content;
    try {
      content = readFileSync(skillPath, "utf-8");
    } catch {
      continue; // Skip directories without SKILL.md
    }

    const yaml = extractFrontmatter(content);
    if (!yaml) {
      errors.push(`${dir}: no frontmatter found`);
      continue;
    }

    try {
      const parsed = parseSimpleYaml(yaml);
      const meta = parsed.metadata || {};

      const pathPatterns = Array.isArray(meta.pathPatterns) ? meta.pathPatterns : [];
      const bashPatterns = Array.isArray(meta.bashPatterns) ? meta.bashPatterns : [];

      skills[dir] = {
        name: parsed.name || dir,
        description: parsed.description || "",
        priority: typeof meta.priority === "number" ? meta.priority : 5,
        pathPatterns,
        pathRegexSources: pathPatterns.map(p => globToRegexSource(p)),
        bashPatterns,
        bashRegexSources: bashPatterns,
        importPatterns: Array.isArray(meta.importPatterns) ? meta.importPatterns : [],
        promptSignals: meta.promptSignals || null,
        docs: Array.isArray(meta.docs) ? meta.docs : [],
      };
    } catch (err) {
      errors.push(`${dir}: parse error — ${err.message}`);
    }
  }

  const manifest = {
    version: 2,
    generatedAt: new Date().toISOString(),
    skillCount: Object.keys(skills).length,
    skills,
  };

  const outDir = join(ROOT, "generated");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "skill-manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  console.log(`Generated skill-manifest.json — ${Object.keys(skills).length} skills`);
  if (errors.length > 0) {
    console.warn(`\nWarnings:`);
    for (const e of errors) console.warn(`  - ${e}`);
  }
}

main();
