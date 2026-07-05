# Prompts

Every model-facing prompt in minimal-agent lives in a markdown file, not in a
TypeScript string literal. This directory holds the **core** prompts; plugins
keep theirs next to the plugin (see below). The loader + templating engine is
[`src/prompts/prompts.ts`](./prompts.ts).

## Why

- Prompts are content, not code. Editing prose should be editing prose, not
  fighting `\n\n`, backtick escaping, and string concatenation in a `.ts` file.
- One convention across core, in-repo plugins, and external plugins. Plugins
  already ship a `PROMPT.md` (loaded by `src/plugins/loader.ts`); this extends
  the same idea to the agent's own system prompt, tool descriptions, and
  sub-prompts.
- Prompt diffs read as prose diffs.

The agent runs from source under Bun, so these files are read at runtime with
`readFileSync` relative to the calling module. No bundler, no build step.

## File naming

- `*.md` — a static prompt or fragment with **no** placeholders.
- `*.tmpl.md` — a template that contains `%%…%%` placeholders.

Both render through the same engine; the `.tmpl` infix is a signal to humans
that the file has holes to fill. The final `.md` keeps editor markdown
highlighting working.

## Placeholder grammar

Templates use `%%…%%` so the markers never collide with markdown, backticks, or
shell `${…}`:

| Marker        | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `%%name%%`    | **Required.** Missing/`null`/`undefined` → `PromptTemplateError` at load. |
| `%%name?%%`   | **Optional** ("yield"-like). Absent → empty; a line-only slot collapses. |

`name` matches `[A-Za-z0-9_.-]+` (e.g. `version`, `cooldownSec`, `mark-1`).

Required placeholders fail fast: a typo or unwired variable throws when the
module loads, so a literal `%%foo%%` never reaches a request. Optional
placeholders are for genuinely conditional slots.

## Usage from TypeScript

```ts
import { promptPath, renderPrompt } from "../prompts.ts"

// Static fragment:
const IDENTITY = renderPrompt(promptPath(import.meta, "prompts", "identity.neutral.md"))

// Template with required vars:
const billing = renderPrompt(promptPath(import.meta, "prompts", "anthropic", "billing.tmpl.md"), {
  version: VERSION,
  buildHash: BUILD_HASH,
})
```

The rule of thumb: **prose goes in markdown; control flow stays in TypeScript.**
Conditional assembly (which fragment, in what order, under what condition) is
logic and belongs in `.ts`. The sentences themselves belong here. For an
example, see how `buildLoopSafetyParagraph` composes the `loop-safety/*`
fragments (it lived in the now-removed `src/headers.ts`; the Anthropic header
logic moved into the sibling `../minimal-agent-plugins/ma-llm-anthropic-plugin/`).

## Layout

```
src/prompts/
  identity.neutral.md          # "You are minimal-agent …" (non-Anthropic providers)
  instructions.md              # the cached system[2] instructions block
  tool-output-conventions.md   # appended when the blob store is on
  loop-safety/                 # fragments composed by buildLoopSafetyParagraph
    heading.md
    checkpoint-cooldown.tmpl.md
    checkpoint-plain.tmpl.md
    ack.md
    emergency-cap.tmpl.md
  anthropic/                   # Anthropic plan-auth preamble (server-validated)
    identity.claude-code.md
    billing.tmpl.md
  tools/                       # built-in tool descriptions
    bash.md  read.md  write.md  edit.md  glob.md  grep.md  mode.md
```

Plugin prompts live next to the plugin, not here:

- `plugins/<id>/PROMPT.md` — the plugin's system-prompt contribution (loaded by
  the plugin loader).
- `<plugin>/prompts/*.{md,tmpl.md}` — any other prompts the plugin renders
  itself (e.g. `ma-memory-plugin/prompts/summarize.tmpl.md` in the sibling repo).

## Anthropic preamble is special

The Anthropic provider's `prompts/identity.claude-code.md` and
`prompts/billing.tmpl.md` (now in the sibling
`../minimal-agent-plugins/ma-llm-anthropic-plugin/prompts/`, rendered via that
plugin's own `lib/prompts.ts` loader) are the exact blocks Anthropic's server
validates for plan/OAuth auth. They are the single source of truth (the former
`src/headers.ts` legacy shim and the core `src/prompts/anthropic/` copies have
been removed). Keep them byte-exact. Reword `instructions.md` freely; do **not**
reword those two.
