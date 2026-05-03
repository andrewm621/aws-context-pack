# Context Pack Framework — Building Claude Code Plugins for Any Platform/API

> Reference guide for building new Claude Code context packs. Based on the patterns
> established in the AWS Context Pack. Next target: HubSpot.

---

## What Is a Context Pack?

A Claude Code plugin that provides AI-consumable knowledge about a platform, API, or ecosystem. Instead of pasting documentation into every prompt or relying on Claude's training data (which is often stale), a context pack injects the right knowledge at the right moment — automatically.

**How injection works:**

- **Session start** — The root knowledge graph (`{platform}.md`) is injected once per session, giving Claude a map of the entire ecosystem.
- **File/bash trigger** — When Claude opens a file or runs a command that matches a skill's patterns, that skill's `SKILL.md` is injected as additional context before Claude responds.
- **Prompt trigger** — When the user's message contains keywords matching a skill's `promptSignals`, that skill is injected before Claude processes the prompt.

**The result:** Claude gets expert-level knowledge about the specific service or API being used, without overwhelming the context window with everything at once. A session working with Lambda gets Lambda knowledge. A session working with S3 gets S3 knowledge. Both get the ecosystem overview.

**Key design principle:** Skills are injected contextually, not exhaustively. The injection budget (18 KB for file/bash triggers, 8 KB for prompt triggers) and MAX_SKILLS cap (3 for file/bash, 2 for prompt) ensure Claude's context window isn't flooded. Deduplication prevents the same skill from being injected twice in a session.

---

## Architecture

```
{pack-name}/
  .claude-plugin/
    plugin.json               # Plugin metadata (name, version, description, keywords)
  hooks/
    hooks.json                # Event registration (SessionStart, PreToolUse, UserPromptSubmit)
    inject-claude-md.mjs      # SessionStart: injects root knowledge graph
    session-start-profiler.mjs # SessionStart: detects platform in working directory
    pretooluse-skill-inject.mjs # PreToolUse: file/bash pattern matching -> skill injection
    user-prompt-submit-skill-inject.mjs # UserPromptSubmit: keyword -> skill injection
  skills/
    {service}/
      SKILL.md                # Skill content with YAML frontmatter (patterns + body)
      references/             # Optional deep-dive reference files
        {topic}.md
  scripts/
    build-manifest.mjs        # Pre-compiles SKILL.md frontmatter -> generated/skill-manifest.json
    validate.mjs              # Validates all skills for structure and token count
    generate-catalog.mjs      # Generates human-readable generated/skill-catalog.md
  generated/
    skill-manifest.json       # Pre-built pattern manifest (speeds up hook execution)
    skill-catalog.md          # Auto-generated index of all skills
  {platform}.md               # Root knowledge graph (service map, decision matrices)
  package.json                # npm scripts: build, validate, catalog, prepublish
  install.sh                  # Optional install helper
  README.md                   # User-facing documentation
  CLAUDE.md                   # Claude Code development guide for contributors
```

### Data flow

```
Session start
  -> inject-claude-md.mjs reads {platform}.md -> stdout (injected into conversation)
  -> session-start-profiler.mjs scans working directory for FILE_MARKERS + PACKAGE_MARKERS
     -> sets AWS_PLUGIN_LIKELY_SKILLS env var for priority boosting

User reads/edits a file OR runs a bash command
  -> pretooluse-skill-inject.mjs reads stdin (tool_name, tool_input, session_id)
     -> loads generated/skill-manifest.json (or parses SKILL.md files as fallback)
     -> matches file path against pathPatterns (glob -> regex)
     -> matches bash command against bashPatterns (regex)
     -> matches file content against importPatterns (regex on import/require statements)
     -> deduplicates against session-scoped seen-skills file in /tmp
     -> boosts priority for skills detected by profiler
     -> injects top 3 skills (up to 18 KB) as additionalContext
     -> writes JSON: { hookSpecificOutput: { hookEventName, additionalContext } }

User submits a prompt
  -> user-prompt-submit-skill-inject.mjs reads stdin (prompt, session_id)
     -> normalizes prompt (lowercase, strip punctuation)
     -> matches against promptSignals.phrases from manifest
     -> scores by phrase specificity (longer phrase = higher score)
     -> deduplicates against session seen-skills
     -> injects top 2 skills (up to 8 KB) as additionalContext
```

---

## Step-by-Step: Building a New Context Pack

### Step 1: Define the Scope

Answer these questions before writing a single file:

- **What platform/ecosystem?** (HubSpot, Stripe, Shopify, Twilio, etc.)
- **Who is the target user?** Developer building integrations? Marketer using the platform's API? The answer shapes which services to prioritize.
- **What are the top 5-10 services/API areas to cover first?** Start with the highest-frequency, highest-value surfaces. You can always add more skills later.
- **What's the authentication model?** API keys, OAuth 2.0, JWT, service accounts — this affects every skill and belongs in the root knowledge graph.
- **What are the primary SDKs?** Official client libraries determine `importPatterns` and `PACKAGE_MARKERS`.
- **What are the primary CLI tools?** CLI commands determine `bashPatterns` and `FILE_MARKERS`.

### Step 2: Scaffold the Directory Structure

```bash
mkdir {platform}-context-pack
cd {platform}-context-pack
git init

# Create directory structure
mkdir -p .claude-plugin hooks skills scripts generated

# Copy hook scripts from aws-context-pack (see Step 6 for which to copy verbatim)
cp ../aws-context-pack/hooks/pretooluse-skill-inject.mjs hooks/
cp ../aws-context-pack/hooks/user-prompt-submit-skill-inject.mjs hooks/
cp ../aws-context-pack/scripts/build-manifest.mjs scripts/
cp ../aws-context-pack/scripts/validate.mjs scripts/
cp ../aws-context-pack/scripts/generate-catalog.mjs scripts/
```

Update these two files from scratch (do NOT copy verbatim — they contain platform-specific content):
- `hooks/inject-claude-md.mjs` — change the filename referenced (e.g., `hubspot.md`)
- `hooks/session-start-profiler.mjs` — change `FILE_MARKERS`, `PACKAGE_MARKERS`, Python marker checks

Create from scratch (use aws-context-pack as a structural template):
- `.claude-plugin/plugin.json`
- `hooks/hooks.json`
- `package.json`
- `{platform}.md`

### Step 3: Write the Root Knowledge Graph (`{platform}.md`)

This is the document injected at session start. Every Claude session working with this platform gets this. Keep it under ~6,000 tokens — it's a map, not a manual.

**Required sections:**

1. **Service/API Overview** — What this platform does, who it's for, how it's organized. One paragraph.
2. **Authentication** — How auth works (critical — gets wrong more often than anything). API key patterns, OAuth flows, token scopes, secret storage.
3. **Service/API Map** — A structured map of every major API area with skill links. Model it after the ASCII tree structure in `aws.md` — relationships and dependencies are as valuable as descriptions.
4. **Decision Matrix** — "When to use X vs Y" tables for the most-confused pairs. (e.g., HubSpot: Workflow API vs Custom Code Action vs Webhook)
5. **Architecture Patterns** — The 2-4 most common integration patterns. Just the pattern names and one-line descriptions — the skills have the code.
6. **Rate Limits & Quotas** — Every platform has them. Put them here so they're always in context.
7. **Common Mistakes** — 3-5 mistakes developers make on this platform. These are high-value because they prevent issues before they happen.

**Template:**

```markdown
# {Platform} Context Pack — Service Knowledge Graph

> [One sentence: what this document is and who it's for]

---

## Authentication

[How auth works — key types, scopes, storage, rotation]

---

## API Map

[ASCII tree or structured list of all major API areas with => skill: links]

---

## Decision Matrix: [Most-confused service pair]

| Scenario | Use | Because |
|----------|-----|---------|
| ... | ... | ... |

---

## Common Architecture Patterns

[2-4 patterns with names and one-line descriptions]

---

## Rate Limits & Quotas

| Tier/Plan | Requests/sec | Daily Limit | Notes |
|-----------|-------------|-------------|-------|
| ... | ... | ... | ... |

---

## Common Mistakes

1. **[Mistake]** — [Why it happens and what to do instead]
```

### Step 4: Define Your Skill Taxonomy

Not all APIs are equal. Assign priority tiers so the most-used skills win injection slots when multiple patterns match:

| Priority | Meaning | Example (HubSpot) |
|----------|---------|-------------------|
| **P8** | Used in almost every project; developers touch this constantly | contacts-api, hubspot-auth |
| **P7** | Used weekly; most projects need this at some point | deals-api, companies-api |
| **P6** | Used in specific feature areas | workflows, email-marketing |
| **P5** | Used occasionally, specific integration patterns | cms-api, conversations-api |
| **P4** | Specialized/niche; most projects never touch it | reporting-api, custom-events |

**Ordering rule:** When two skills match simultaneously, higher priority wins the injection slot. Assign P8 sparingly — only 1-3 skills per pack should be at this level.

### Step 5: Write SKILL.md Files

Every skill file follows this exact structure. The YAML frontmatter drives pattern matching; the body is what gets injected.

**Full SKILL.md template:**

```markdown
---
name: {service-slug}
description: {One sentence: what this skill covers and when to use it. Used in catalog.}
metadata:
  priority: {4-8}
  docs:
    - "{primary docs URL}"
    - "{secondary docs URL}"
  pathPatterns:
    - '{config file that means this service is in use}'
    - '{directory pattern e.g. "src/hubspot/**"}'
    - '{file name pattern e.g. "*.hubspot.ts"}'
  bashPatterns:
    - '\b{cli-tool}\s+{subcommand}\b'
    - '\b{cli-tool}\s+(option1|option2)\b'
  importPatterns:
    - "@{platform}/{sdk-package}"
    - "{platform}-sdk"
  promptSignals:
    phrases:
      - "{service name}"
      - "{common question phrase}"
      - "{error message fragment}"
      - "{feature name developers ask about}"
---

# {Service Name}

## What It Is & When to Use It

[2-4 sentences. What this API/service does. The key use cases. What NOT to use it for.]

## Service Surface

| Property | Value |
|----------|-------|
| **Base URL** | `https://api.{platform}.com/...` |
| **Auth** | [How auth works for this specific service] |
| **Rate limits** | [Requests/sec or requests/day] |
| **Pagination** | [How pagination works] |
| **Versioning** | [API version strategy] |
| **Key endpoints** | [3-5 most-used endpoints] |

## Mental Model

[The 3-5 conceptual primitives that explain how this service thinks. Not how to use it — how to understand it. Answer: "What do I need to understand to use this correctly?"]

**Primitive 1 — [Name]:** [Explanation]

**Primitive 2 — [Name]:** [Explanation]

## Common Patterns

### [Pattern 1 Name]
```{language}
// Code example
```

### [Pattern 2 Name]
```{language}
// Code example
```

### [Pattern 3 Name]
```{language}
// Code example
```

## Gotchas

1. **[Gotcha title]** — [What it is, why it trips people up, what to do instead. Be specific — cite limits, error codes, or undocumented behaviors.]

2. **[Gotcha title]** — [...]

[Aim for 5-10 gotchas. These are the highest-value content in the skill.]

## Official Documentation

- [{Doc title}]({URL})
- [{Doc title}]({URL})
```

**Body size target:** 3,000-8,000 tokens (~12,000-32,000 characters). The validate script enforces the 8,000-token ceiling. Content exceeding the ceiling belongs in `references/` subdirectory files.

**Reference files** (`skills/{service}/references/{topic}.md`): For topics too deep for the main skill body. These are NOT auto-injected — they exist for Claude to read when explicitly asked for deep detail. No frontmatter required. No token limit (stay reasonable). Examples: `cold-start-optimization.md`, `single-table-design.md`, `oauth-flows.md`.

### Step 6: Configure Pattern Matching

Pattern matching is what makes skills inject at the right moment. Bad patterns = missed injections or false positives.

**pathPatterns** (glob syntax):
```yaml
pathPatterns:
  - 'hubspot.config.yml'        # Exact filename anywhere in tree
  - '.hubspot.config.yml'       # Hidden config file
  - 'src/hubspot/**'            # All files in a directory
  - '**/*.hubspot.ts'           # Files with a platform extension
  - 'lib/*-hubspot.ts'          # Files matching a naming convention
```
- Use `**` for "any path prefix"
- Use `*` for "any characters within one path segment"
- Match config files first — they're reliable signals
- Match directory conventions second — more speculative

**bashPatterns** (regex):
```yaml
bashPatterns:
  - '\bhs\s+(upload|fetch|deploy)\b'    # HubSpot CLI
  - '\bnpx\s+hubspot\b'                 # npx invocation
  - '\bcurl.*api\.hubspot\.com\b'       # Direct API calls
```
- Always use `\b` word boundaries to avoid partial matches
- Match the CLI tool name + subcommand pattern
- Match direct API invocations via curl/httpie

**importPatterns** (matched against file content):
```yaml
importPatterns:
  - "@hubspot/api-client"       # Official Node.js SDK
  - "hubspot"                   # Bare package name
```
- These match against `from "..."` and `require("...")` patterns in file content
- The hook uses: `(?:from|require\s*\()\s*['"]${escaped}` regex
- Use exact package names from npm/pip/etc.

**promptSignals.phrases** (matched against normalized user prompt):
```yaml
promptSignals:
  phrases:
    - "hubspot contact"           # Specific entity reference
    - "crm api"                   # Generic but associated
    - "hubspot deal"              # Another entity
    - "sync contacts"             # Common task description
    - "hubspot oauth"             # Auth question
    - "property update failed"    # Error-like phrase
```
- All phrases are lowercased and matched against normalized prompt
- Longer phrases score higher (more specific = better signal)
- Include both platform-specific terms AND generic terms the user might use
- Include fragments of common error messages

### Step 7: Customize the Profiler (`session-start-profiler.mjs`)

The profiler runs at session start, scans the working directory, and sets an env var that boosts matched skills' priority (+5) during the session.

**Things to change:**

1. `FILE_MARKERS` array — config files that signal the platform is in use:
```javascript
const FILE_MARKERS = [
  { file: 'hubspot.config.yml', skills: ['hubspot-auth'] },
  { file: '.hubspot.config.yml', skills: ['hubspot-auth'] },
  { file: 'hubspot.config.js', skills: ['hubspot-auth'] },
  { file: '.env', skills: [] },  // Maybe scan for HUBSPOT_ vars
];
```

2. `PACKAGE_MARKERS` object — npm/pip packages that signal usage:
```javascript
const PACKAGE_MARKERS = {
  '@hubspot/api-client': ['contacts-api', 'deals-api', 'companies-api'],
  'hubspot': ['hubspot-auth'],
  '@hubspot/cms-dev-server': ['cms-api'],
};
```

3. Python/requirements.txt check (if the platform has a Python SDK):
```javascript
const reqTxt = join(projectRoot, 'requirements.txt');
if (existsSync(reqTxt)) {
  const content = readFileSync(reqTxt, 'utf-8');
  if (content.includes('hubspot3') || content.includes('hubspot-api-client')) {
    skills.add('hubspot-auth');
  }
}
```

4. Warning messages — add platform-specific warnings (e.g., deprecated SDK versions):
```javascript
if (hasLegacySdk) {
  messages.push('WARNING: hubspot v0.x SDK detected. Migrate to @hubspot/api-client v11+.');
}
```

5. Change the env var name from `AWS_PLUGIN_LIKELY_SKILLS` to `{PLATFORM}_PLUGIN_LIKELY_SKILLS` in all three files: `session-start-profiler.mjs`, `pretooluse-skill-inject.mjs`. (Search and replace.)

### Step 8: Configure `hooks/hooks.json`

This file is nearly identical across packs. The only thing that may change is the `matcher` in SessionStart (controls which Claude session events trigger the hook):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/inject-claude-md.mjs\""
          },
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start-profiler.mjs\""
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Read|Edit|Write|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse-skill-inject.mjs\"",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit-skill-inject.mjs\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### Step 9: Configure `package.json`

```json
{
  "name": "{platform}-context-pack",
  "version": "0.1.0",
  "description": "Claude Code plugin providing AI-consumable {Platform} API knowledge",
  "type": "module",
  "license": "Apache-2.0",
  "scripts": {
    "build": "node scripts/build-manifest.mjs",
    "validate": "node scripts/validate.mjs",
    "catalog": "node scripts/generate-catalog.mjs",
    "prepublish": "npm run build && npm run validate"
  },
  "files": [
    "{platform}.md",
    "hooks/",
    "skills/",
    "scripts/",
    "generated/",
    ".claude-plugin/",
    "README.md",
    "CLAUDE.md"
  ],
  "engines": {
    "node": ">=18.0.0"
  }
}
```

### Step 10: Validate and Build

```bash
# Validate all skills for structure, section coverage, and token count
node scripts/validate.mjs

# Build the compiled manifest (required for hook performance)
node scripts/build-manifest.mjs

# Generate human-readable skill catalog
node scripts/generate-catalog.mjs

# Install the plugin into Claude Code
claude plugin add ./

# Test it
claude
# > [In a project that uses the platform] ask a question about the platform
```

**Validation checks (from `validate.mjs`):**
- YAML frontmatter present and contains `name` and `description`
- At least one of `pathPatterns` or `bashPatterns` defined (or warns)
- All 6 required body sections present: What It Is, Service Surface, Mental Model, Common Patterns, Gotchas, Official Documentation
- Body under 8,000 tokens (~32,000 characters)
- Body over 200 tokens (warns if suspiciously short)
- No deprecated SDK imports in code examples

---

## Reusable Hook Scripts

| Script | Copy or Customize | What to Change |
|--------|-------------------|----------------|
| `hooks/pretooluse-skill-inject.mjs` | **Copy verbatim** | Search-replace `aws-plugin` -> `{platform}-plugin` in the dedup tmp file name and env var name |
| `hooks/user-prompt-submit-skill-inject.mjs` | **Copy verbatim** | Same search-replace for tmp file name and banner text |
| `hooks/inject-claude-md.mjs` | **Minimal change** | Change `aws.md` to `{platform}.md` on one line |
| `hooks/session-start-profiler.mjs` | **Customize** | Replace `FILE_MARKERS`, `PACKAGE_MARKERS`, Python check, warning messages, env var name |
| `scripts/build-manifest.mjs` | **Copy verbatim** | No changes needed |
| `scripts/validate.mjs` | **Copy verbatim** | Optionally adjust `MAX_TOKENS` (default 8000) and `REQUIRED_SECTIONS` if your skill format differs |
| `scripts/generate-catalog.mjs` | **Copy verbatim** | Change the catalog title string on one line |
| `hooks/hooks.json` | **Copy verbatim** | No changes needed |

**The search-replace pattern for hook scripts:**
- `aws-plugin` -> `{platform}-plugin` (appears in tmp file naming and dedup logic)
- `AWS_PLUGIN_LIKELY_SKILLS` -> `{PLATFORM}_PLUGIN_LIKELY_SKILLS`
- `[aws-context-pack]` -> `[{platform}-context-pack]` (banner/log prefix)

---

## Skill Quality Checklist

Before running `validate.mjs`, check each skill against these criteria:

**Frontmatter:**
- [ ] `name` matches the directory name exactly
- [ ] `description` is one sentence, mentions when to use it
- [ ] `priority` is set (4-8)
- [ ] At least one `pathPattern` or `bashPattern`
- [ ] `promptSignals.phrases` has 5-10 phrases
- [ ] `docs` has the primary documentation URL

**Body:**
- [ ] All 6 required sections present with `##` headings
- [ ] "What It Is" answers: what, when to use, when NOT to use
- [ ] "Service Surface" has a table with key properties (limits, pricing, endpoints)
- [ ] "Mental Model" explains the conceptual model, not just syntax
- [ ] "Common Patterns" has working code examples (not pseudocode)
- [ ] "Gotchas" has at least 5 specific, actionable items
- [ ] "Official Documentation" has real, working URLs
- [ ] No deprecated SDK imports in code examples
- [ ] Body is between 3,000 and 8,000 tokens

**Patterns:**
- [ ] `pathPatterns` tested against real file names in real projects
- [ ] `bashPatterns` use `\b` word boundaries
- [ ] `promptSignals.phrases` include both specific and generic user phrasings

---

## HubSpot Context Pack — Starter Plan

HubSpot is the next context pack target. Here's the full plan.

### Root Knowledge Graph Topics (`hubspot.md`)

- **CRM** — Objects model (Contacts, Companies, Deals, Tickets, Custom Objects), associations between objects, properties system
- **Marketing** — Email API, Forms API, Landing Pages, CTAs
- **CMS** — Themes, modules, templates, HubL templating
- **Automation** — Workflows (visual), Custom Code Actions (in-workflow Node.js), Sequences, Webhooks
- **Reporting** — Reports API, custom report builder, analytics events
- **Custom Objects** — Schema definition, associations, CRM cards
- **Integrations** — Webhooks, Timeline Events, CRM extensions

### Authentication Model

HubSpot has two auth paths — this distinction belongs prominently in the root knowledge graph and the `hubspot-auth` skill:

| Type | Use When | How |
|------|----------|-----|
| **Private App token** | Internal tools, single-portal integrations | Bearer token, no user auth required, scopes defined at creation |
| **OAuth 2.0** | Public apps, marketplace listings, multi-portal integrations | Standard OAuth flow, access + refresh tokens, scopes requested at install |

HubSpot deprecated API Keys (hapikey) in November 2022. Any code using `?hapikey=` is legacy. The profiler should warn on this.

### Skills Tier Plan

**Tier 1 — P8 (Build first):**
- `hubspot-auth` — Private Apps, OAuth 2.0, scope selection, token management. This is needed for everything.
- `contacts-api` — CRUD contacts, search, bulk operations, properties. Most common CRM operation.
- `deals-api` — CRUD deals, pipeline stages, associations to contacts/companies.
- `companies-api` — CRUD companies, domain association, hierarchy.
- `custom-objects` — Schema definition, records CRUD, associations. Growing usage.

**Tier 2 — P7 (Build next):**
- `workflows` — Workflow API, enrollment triggers, Custom Code Actions (in-workflow Node.js lambdas)
- `email-marketing` — Transactional Email API, Marketing Email API, email events
- `forms` — Form submissions API, form embed, lead capture
- `crm-extensions` — CRM cards (custom timeline events, sidebar cards), calling SDK
- `webhooks` — Webhook subscriptions, event types, verification, retry behavior

**Tier 3 — P5-P6 (Build when needed):**
- `cms-api` — Content, themes, modules, HubL basics
- `reporting-api` — Analytics events, custom behavioral events, report generation
- `conversations-api` — Inbox, threads, messages (for chatbot integrations)
- `associations-api` — Managing object associations (increasingly important with v4 Associations API)
- `properties-api` — Creating/managing custom properties, property groups

### Key File Markers (`session-start-profiler.mjs`)

```javascript
const FILE_MARKERS = [
  { file: 'hubspot.config.yml', skills: ['hubspot-auth'] },
  { file: '.hubspot.config.yml', skills: ['hubspot-auth'] },
  { file: 'hubspot.config.js', skills: ['hubspot-auth'] },
  { file: 'hubspot.config.cjs', skills: ['hubspot-auth'] },
  { file: 'hubspot.config.ts', skills: ['hubspot-auth'] },
  { file: '.env', skills: [] },  // Scan for HUBSPOT_ vars separately
];
```

### Key Package Markers (`session-start-profiler.mjs`)

```javascript
const PACKAGE_MARKERS = {
  '@hubspot/api-client': ['contacts-api', 'deals-api', 'companies-api'],
  'hubspot': ['hubspot-auth'],
  '@hubspot/cms-dev-server': ['cms-api'],
  '@hubspot/cli': ['hubspot-auth'],
  '@hubspot/local-dev-lib': ['hubspot-auth'],
  'hubspot3': ['hubspot-auth'],          // Python SDK — check requirements.txt
  'hubspot-api-client': ['hubspot-auth'], // Python SDK alternate
};
```

### Key Bash Patterns

```yaml
bashPatterns:
  - '\bhs\s+(upload|fetch|deploy|create|delete|lint|watch)\b'   # HubSpot CLI
  - '\bhs\s+auth\b'                                              # Auth flow
  - '\bnpx\s+@hubspot/cli\b'                                     # npx invocation
  - '\bcurl.*api\.hubspot\.com\b'                                # Direct API calls
  - '\bcurl.*api\.hubapi\.com\b'                                 # Legacy domain
```

### SDK Version Warning

The HubSpot Node.js SDK has major version differences. The profiler should warn on v1-v2:

```javascript
const pkg = safeReadJson(join(projectRoot, 'package.json'));
const hubspotVersion = pkg?.dependencies?.['@hubspot/api-client'] || pkg?.devDependencies?.['@hubspot/api-client'];
if (hubspotVersion && /^[~^]?[12]\./.test(hubspotVersion)) {
  messages.push('WARNING: @hubspot/api-client v1-v2 detected. Upgrade to v11+ for current API support and TypeScript types.');
}
```

### HubSpot-Specific Gotchas to Document Across Skills

These should appear in relevant skills:
1. **Rate limits by tier** — Free: 100 requests/10s. Starter: 150/10s. Professional: 160/10s. Enterprise: 200/10s. Burst up to 300 with backoff.
2. **hapikey deprecation** — API Keys removed Nov 2022. Any `?hapikey=` usage is broken.
3. **v1 vs v3 CRM API** — HubSpot has two CRM API versions with different response shapes. v3 is current; v1 is legacy but still documented.
4. **Property names are case-sensitive** — `firstname` not `firstName`. Many developers get this wrong.
5. **Association labels** — v4 Associations API added labeled associations; v3 associations are now "unlabeled." Different endpoints.
6. **Workflow enrollment vs list** — Contacts can only be enrolled in a workflow if they meet the enrollment trigger AND haven't been previously enrolled (unless re-enrollment is enabled).
7. **Transactional vs Marketing email** — Different APIs, different sending limits, different opt-out behavior.
8. **OAuth scope selection** — Request only scopes you need. Requesting unnecessary scopes reduces install conversion for marketplace apps.

---

## Common Mistakes When Building Context Packs

**Mistake 1: Making pathPatterns too broad**
`'**/*.ts'` will match every TypeScript file in every project. Your skill will inject into React components that have nothing to do with your platform. Be specific: `'src/hubspot/**/*.ts'` or `'**/*.hubspot.ts'`.

**Mistake 2: Missing the semantic layer in Mental Model**
The "Mental Model" section is where the skill earns its value. Don't write "here's how to call the API" — write "here's how this API thinks." The conceptual model is what Claude needs to avoid the subtle mistakes that documentation doesn't warn about.

**Mistake 3: Gotchas without specifics**
"Watch out for rate limits" is useless. "The HubSpot API enforces 100 requests per 10-second window on free plans. If you hit the limit, you receive a 429 with a `Retry-After` header. The SDK does not auto-retry — implement exponential backoff yourself." is useful.

**Mistake 4: Over-prioritizing everything**
If every skill is P8, the injection budget will always be exceeded and skills will be dropped arbitrarily. Reserve P8 for the 1-3 skills a developer touches in literally every project. Everything else gets P5-P7.

**Mistake 5: Forgetting to run `build-manifest.mjs` after adding skills**
The hook scripts prefer the pre-compiled manifest for performance. If you add a new skill without rebuilding, the manifest won't include it and it won't inject until the manifest is regenerated (though the fallback parser will handle it at slight performance cost).

**Mistake 6: Prompt signals that are too generic**
`"api"` will match every prompt. `"hubspot api"` is better. `"hubspot contact property"` is best. The scoring algorithm rewards longer phrases with higher specificity scores.

---

## Maintenance Checklist

When a platform releases a new API version, updates pricing, or changes rate limits:

- [ ] Update the affected `SKILL.md` — check Service Surface table and Gotchas
- [ ] Update `{platform}.md` if the change affects the ecosystem map
- [ ] Run `node scripts/validate.mjs` to confirm nothing broke
- [ ] Run `node scripts/build-manifest.mjs` to regenerate the manifest
- [ ] Run `node scripts/generate-catalog.mjs` to update the catalog
- [ ] Bump the version in `package.json` and `.claude-plugin/plugin.json`

Track a `lastVerified` date in each skill's frontmatter (optional but recommended):

```yaml
metadata:
  lastVerified: "2026-05-03"
  priority: 8
```
