# AWS Context Pack — Development Guide

## What This Is

A Claude Code plugin providing AI-consumable knowledge about AWS services. Structured as skills (one per service domain) with pattern-matching hooks that inject relevant context when working with AWS files, commands, or prompts.

## Architecture

```
aws-context-pack/
  aws.md                    # Root knowledge graph (injected on session start)
  skills/*/SKILL.md         # Per-service skills with YAML frontmatter
  hooks/                    # Hook scripts for context injection
  generated/                # Auto-generated manifest and catalog
  scripts/                  # Build and validation scripts
```

## Skill File Format

Each `SKILL.md` has YAML frontmatter with:
- `name`: Skill identifier (matches directory name)
- `description`: When to use this skill
- `metadata.priority`: 1-10 (higher = injected first when multiple match)
- `metadata.pathPatterns`: Glob patterns for file matching
- `metadata.bashPatterns`: Regex patterns for bash command matching
- `metadata.importPatterns`: Package import patterns
- `metadata.promptSignals.phrases`: Keyword phrases for prompt matching

Body sections: What It Is, Service Surface, Mental Model, Common Patterns, Gotchas, Official Documentation.

## Adding a New Skill

1. Create `skills/<name>/SKILL.md` with frontmatter and 6 sections
2. Run `node scripts/build-manifest.mjs` to regenerate `generated/skill-manifest.json`
3. Run `node scripts/validate.mjs` to check structure and token counts

## Conventions

- Skill body: 3-8k tokens. Use `references/` subdirectory for deep-dives.
- Always use AWS SDK v3 (`@aws-sdk/client-*`) in examples, never v2.
- Gotchas must cite real sources (AWS docs, re:Post, community reports).
- Decision matrices use tables with clear "Use When" / "Avoid When" columns.
- Pricing info should note the date it was verified.
