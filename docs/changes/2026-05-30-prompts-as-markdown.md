# Prompts as markdown: stop hardcoding prompt strings in TypeScript

**Date:** 2026-05-30
**Scope:** new `src/prompts.ts` engine + `src/prompts/` content tree, `src/headers.ts`, `src/llm/system-prompt.ts`, `src/tools.ts`, `plugins/llm-anthropic/system-prompt.ts`, `plugins/memory/lib/summarize.ts` + `plugins/memory/prompts/`. No wire-shape change: every relocated prompt renders byte-identical to its old string literal, except the one intentional reword in `instructions.md` (see below). No manifest-schema change; plugins keep using `PROMPT.md`.

## Problem

Model-facing prose was scattered across `.ts` files as string literals: the system-prompt identity/instructions/billing blocks, the loop-safety and tool-output-conventions paragraphs, all seven built-in tool descriptions, the neutral and Claude-Code identities, and the memory summarizer prompt. Editing a prompt meant editing TypeScript, reasoning about `\n\n`, backtick escaping, and `+`-concatenation, and the Claude-Code identity + billing header were duplicated in two files that could drift.

## Design

Two rules:

1. **Prose lives in markdown.** Every standing prompt is a `.md` (static) or `.tmpl.md` (templated) file. Loaded at runtime with `readFileSync` relative to the calling module. The agent runs from source under Bun, so there is no bundler to special-case.
2. **Control flow stays in TypeScript.** Which fragment, in what order, under what condition: that is logic, and it stays in `.ts`. Only the sentences move.

### The engine (`src/prompts.ts`)

- `renderTemplate(text, vars, opts)`: pure string render.
- `loadPromptText(absPath)`: memoized `readFileSync` (prompts are static for the process).
- `renderPrompt(absPath, vars, opts)`: load + render.
- `promptPath(import.meta, ...segs)`: resolve a file relative to the caller.
- `PromptTemplateError`, `clearPromptCache` (tests).

Placeholder grammar, `%%...%%` so it never collides with markdown/backticks/shell `${...}`:

- `%%name%%` is **required**. Missing/`null`/`undefined` throws `PromptTemplateError` at load. A typo or unwired var fails fast instead of shipping a literal `%%name%%`.
- `%%name?%%` is **optional** ("yield"-like). Absent renders empty, and a line-only slot collapses so it leaves no blank-line scar.

Whitespace normalization runs only when an optional slot actually empties, so templates without optional slots stay byte-identical to their source (important for the byte-exact billing/identity blocks).

### Layout

```
src/prompts/
  identity.neutral.md            instructions.md            tool-output-conventions.md
  loop-safety/{heading,intro,checkpoint-cooldown,checkpoint-plain,ack,emergency-cap}
  anthropic/{identity.claude-code.md, billing.tmpl.md}
  tools/{bash,read,write,edit,glob,grep,mode}.md
plugins/memory/prompts/{summarize.tmpl.md, framing.global.md, framing.project.md}
```

### Single source for the Anthropic preamble

The Claude-Code identity and billing header are the blocks Anthropic's server validates for plan/OAuth auth. They now live once, in `src/prompts/anthropic/`, rendered by `src/headers.ts` (`CLAUDE_CODE_IDENTITY`, `buildBillingHeaderText()`). `plugins/llm-anthropic/system-prompt.ts` re-exports/uses those instead of re-declaring the strings. One place to keep byte-exact.

### `buildLoopSafetyParagraph` as the worked example

The original interleaved string literals and `""` separators in a `parts[]` array, with conditional sections for cooldown vs no-cooldown and the emergency cap. The refactor keeps that exact control flow and `parts.join("\n")`, swapping each literal for a `renderPrompt(fragment)` call. `heading` and `intro` are split into separate fragments so the `!hasReflection && hasEmergencyCap` path (heading + emergency, no intro) stays byte-identical.

## The one intentional change

`instructions.md` (the cached system[2] block) now opens:

> You are minimal-agent, an interactive CLI agent that helps users with software engineering tasks. ...

(was "You are an interactive agent that helps users..."). This block is not server-validated, so naming the agent is safe. The Anthropic plan-auth identity (system[1], "You are Claude Code, ...") and the billing header are untouched and must stay byte-exact.

## Verification

- New `src/prompts.test.ts` (17 cases) covers required/optional/missing/collapse/trim/memoize.
- Captured the old tool descriptions and memory summarizer output to disk, then asserted the markdown renders byte-identical post-refactor.
- Existing `client.test.ts`, `llm/system-prompt.test.ts`, `anthropic.test.ts`, `summarize.test.ts` pass unchanged (they pin the billing/identity values and loop-safety substrings).
- `typecheck`, `oxlint`, `biome format`/`check`, and `docs:check` are clean on all touched files.

## Boundary (deliberately out of scope)

Per-turn protocol scaffolding generated at runtime (the `<ma::agent::reflection-checkpoint .../>` attachment text, emergency-cap and output-preview annotations, mode stamps) stays in code. Those are dynamically-built message structure, not standing prompts. The *system-prompt description* of them (the loop-safety and tool-output-conventions paragraphs) did move. The engine + convention extend cleanly if we later want to relocate those too.
