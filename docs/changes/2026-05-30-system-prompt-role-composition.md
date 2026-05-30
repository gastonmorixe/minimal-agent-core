# System-prompt role composition: drop the `<ma::plugin*>` framing

**Date:** 2026-05-30
**Scope:** `src/plugins/loader.ts`, `src/plugins/loader/helpers.ts`, `src/plugins/scanner.ts`, `src/plugins/types.ts`, `src/reflection-ack-stripper.ts`, every bundled `plugins/*/PROMPT.md`, the tasks/memory attachment producers, `env-info/gather.sh`, and the sibling `minimal-agent-plugins/*` PROMPT.md set. No change to the provider seam, identity/billing blocks, cache-block layout, or the manifest schema.

## Problem

The plugin prompt block was assembled as:

```
<ma::plugins>
<ma::plugins-overview>
You have access to the following plugins. Each plugin contributes one or more
tools and/or inline rendering tags. ...
</ma::plugins-overview>
<ma::plugin id="web-search">The `web-search` plugin contributes a `WebSearch` tool ...</ma::plugin>
<ma::plugin id="ma-agent-writing-style">You write for humans ...</ma::plugin>
...
</ma::plugins>
```

Three problems:

1. **The overview line is false.** "Each plugin contributes one or more tools and/or inline rendering tags" is wrong for mode-only plugins (`ask-mode`), fragment-only plugins (`env-info`), behavior-only plugins (`ma-agent-writing-style`), and silent UX plugins (`history`, `quota-status`). A plugin is an operator-side composition unit, not "a bag of tools".
2. **The `<ma::plugin id="…">` wrapper is the wrong altitude.** It frames every contribution as *documentation about a third-party package*. The model latches onto semantic tag names; wrapping a behavioral mandate in `<ma::plugin id="ma-agent-writing-style">` downgrades it from "a rule you follow" to "notes about a plugin". On literal-instruction-following models this is the difference between adherence and paraphrase.
3. **Operator trivia leaked into the cached prompt.** PROMPT.md bodies opened with "The X plugin contributes…" and carried config paths, `enabled` flags, and env-var opt-outs, none of which the model can act on. Pure attention-budget waste.

The word "plugin" is an internal minimal-agent concept. It should never reach the model.

## Design

### One uniform tag grammar: `<ma::OWNER::leaf>`

Every model-facing tag is partitioned by who produces and consumes it:

| Owner | Direction | Examples |
| --- | --- | --- |
| `<ma::sys::*>` | composed into the system prompt; the model reads | `<ma::sys::behavior>`, `<ma::sys::tool>`, `<ma::sys::emit>`, `<ma::sys::mode>`, `<ma::sys::context>` |
| `<ma::agent::*>` | harness → model runtime signals | `<ma::agent::tasks>`, `<ma::agent::short-term-memory>`, `<ma::agent::memory-saved>`, `<ma::agent::mode-active>`, `<ma::agent::reflection-checkpoint>`, `<ma::agent::raw-output>` |
| `<ma::emit::*>` | model → harness inline directives | `<ma::emit::diff>`, `<ma::emit::memory>`, `<ma::emit::interleave-thinking>` |

The three owners map to three non-overlapping processing pipelines: `sys` is only ever read (never scanned, never injected), `emit` is the only thing the output scanner watches for, `agent` is the only thing the per-turn attachment/replay machinery emits. This is why flattening model-emitted tags to a bare `<ma::diff>` was rejected: the scanner needs a specific probe (`<ma::emit::`) that can't collide with a `<ma::agent::…>` or `<ma::sys::…>` the model quotes (e.g. when it explains its own prompt).

### `<ma::sys::ROLE name="…">` sections

The loader composes one section per contributing plugin. The role describes the content; the name binds it to the thing it governs:

- `behavior` — prose mandate. name = slug of the PROMPT.md H1 (or display name).
- `tool` — per-tool guidance. name = the tool name (matches the `tools[]` entry).
- `emit` — inline-emit syntax. name = the inline-tag name.
- `mode` — mode-specific behavior. name = the mode id.
- `context` — session reference data. name = slug of the H1.

Role + name are inferred from manifest shape by `classifyPluginPrompt` (`src/plugins/loader/helpers.ts`): modes → `mode`; a tool tui → `tool`; inline-tag-only → `emit`; PROMPT.md with no fragments → `behavior`; PROMPT.md with a fragment → `context`. No manifest field was added. Sections sort by `PROMPT_ROLE_ORDER` then by name, so the composed block is byte-stable for a given plugin set (the system prompt is on a cache breakpoint).

A plugin's PROMPT.md body and its prompt-fragment output compose into the **same** section (e.g. `ma-skills` puts its Skill-tool guidance and the discovered-skills catalog both inside `<ma::sys::tool name="Skill">`).

## What was NOT touched (by design)

- **Provider seam.** `resolveSystemPrompt`, the Anthropic billing header, and the `"You are Claude Code…"` identity are unchanged. Providers retain full control of the final wire blocks.
- **Cache-block layout.** Plugin-composed text still rides in the session-context block. Nothing moved between cache breakpoints; only the bytes within the existing block changed (a one-time cache miss on first run).
- **Manifest schema.** Pure inference. `ma-agent-writing-style` shed its no-op fragment because `parseManifest` already accepts prompt-only manifests.

## Migration / back-compat

The model is always given the newest scheme; there is **no** legacy-tag language in any prompt. Internally, `session-replay.ts` (`RUNTIME_ATTACHMENT_OPENERS`) and `session-restore.ts` (`isAttachmentText`) already match `<ma::(agent|plugin|plugins)::` generically plus the legacy bare `<memory-saved>` / `<short-term-memory>` / `<mode-change>` forms, so a resumed pre-refactor transcript still has its attachments stripped correctly. The live inline scanner is per-stream and only ever sees the current model's output, so it switched cleanly to `<ma::emit::` with no dual-accept.

## Measured impact

Old (`HEAD` worktree) vs new composed block, bundled plugins only, env snapshot excluded for an apples-to-apples static comparison (`PluginLoader.getPromptBlockAsync`, 7 plugins with prose):

| Metric | Old | New | Delta |
| --- | --- | --- | --- |
| Characters | 29,379 | 25,147 | −4,232 (−14.4%) |
| Est. tokens (chars/4) | ~7,344 | ~6,286 | −1,058 (−14.4%) |
| Words | 4,405 | 3,784 | −621 (−14.1%) |
| Lines | 494 | 401 | −93 (−18.8%) |
| "plugin" mentions (model-facing) | 51 | 0 | −100% |
| Operator-trivia lines (config.jsonc / enabled / opt-out / auto-loaded) | 5 | 0 | −100% |
| Structural wrapper tokens (`<ma::plugins>`, `<ma::plugin id=`, overview) | 9 | 0 | −100% |
| Non-`<ma::>` tags in prompt (`<env>`) | 1 | 0 | −100% |
| False "each plugin contributes tools/tags" overview sentence | 1 | 0 | −100% |
| Per-plugin self-introductions ("The X plugin …") | 8 | 0 | −100% |

Sibling PROMPT.md byte deltas: `ma-skills` −712 (config block dropped), `ma-fetch` −28, `ma-agent-writing-style` −6 (plus its 22-line no-op fragment + manifest entry deleted). Across the FULL real prompt (bundled + sibling), the only residual "plugin" strings are a third-party `vite` *skill description* ("plugin API") and the `plugin_dir=` env-snapshot key — both data the model reads, neither plugin framing the composer injects.

The ~1,060-token saving sits in the cached system-prompt prefix, so it is paid down once per cache window and saves on every turn within it. The headline is not the tokens, though: it is that the model now reads role-typed instructions (`<ma::sys::behavior>`, `<ma::sys::tool name="WebSearch">`) instead of "documentation about a plugin", and the word "plugin" no longer appears in any composer-injected prose.

## Verification

- Main repo: `bun test` → 3894 pass / 0 fail; `typecheck` exit 0; `oxlint` 0 errors; `biome check` clean. New dedicated coverage: `src/plugins/loader/helpers.test.ts` (role inference for all five roles, H1-name derivation, slug/attr-escape) + two role-composition integration tests in `loader.test.ts` (all-role ordering, same-name collision suffixing).
- Sibling repo: `bun test` → 586 pass / 0 fail; `typecheck` exit 0.
- Manual compose (all bundled + sibling plugins, interleave-thinking force-enabled to exercise the otherwise-dormant emit role): sections render as `behavior(writing-style) → tool(Fetch, LockStatus, MemoryTool, ShowDiff, Skill, Task, WebSearch) → emit(interleave-thinking) → mode(ask) → context(environment)`, with zero occurrences of `<ma::plugins>`, `<ma::plugin id=`, `ma::plugin::`, `<env snapshot`, `<memory-saved`, or the overview boilerplate.
