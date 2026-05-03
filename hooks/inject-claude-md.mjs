#!/usr/bin/env node

/**
 * SessionStart hook: Injects aws.md knowledge graph into the conversation.
 * Reads JSON from stdin (session event), writes aws.md content to stdout.
 */

import { readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");

function safeReadFile(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function main() {
  // Read stdin (session event JSON) — we don't need to parse it,
  // just inject the knowledge graph unconditionally on session start
  try {
    readFileSync(0, "utf-8");
  } catch {
    // stdin may be empty on some events, that's fine
  }

  const content = safeReadFile(join(PLUGIN_ROOT, "aws.md"));
  if (!content) return;

  process.stdout.write(content);
}

main();
