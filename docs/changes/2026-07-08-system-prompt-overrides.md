# System-prompt overrides: replace or omit any system-prompt part at startup

**Date:** 2026-07-08
**Scope:** new `src/llm/system-prompt-overrides.ts`, `src/cli/system-prompt-override-flags.ts`, `src/cli/system-prompt-override-resolution.ts`; wiring in `src/llm/instructions-block.ts`, `src/llm/system-prompt.ts`, `src/agent/agent.ts`, `src/sdk/agent-core.ts`, `src/sdk/ports.ts`, `src/host/sdk-adapters/build-agent-core.ts`, `src/host/startup/startup-hashes.ts`, `src/index.ts`, `src/cli/parse-argv.ts`, `src/cli/extract-prompt.ts`, `src/config/config.ts`, `src/host/startup/entry-args.ts`, `src/host/startup/help.ts`, `plugin-api/src/llm/provider-plugin.ts`. No change to default prompt bytes: a session with no overrides produces the exact same system prompt as before.

## Problem

There was no way to override or hide the system prompt at startup. Every model-facing prompt part (neutral identity, base instructions, loop-safety paragraph, tool-output-conventions paragraph, the plugin/session-context block, and the provider preamble) was assembled internally with no seam for a user to replace or omit any of it. Research, prompt A/B testing, token-budget trimming, and "run this model with a minimal prompt" all required editing source.

## Design

### One tri-state override model

Every controllable prompt part resolves to one of three states:

```ts
type PromptPartOverride =
  | { kind: "default" }          // unset: keep today's bytes
  | { kind: "replace"; text }    // use this text instead
  | { kind: "omit" }             // send nothing for this part
```

The resolved `SystemPromptOverrides` struct carries one `PromptPartOverride` per part: `full`, `identity`, `providerPreamble`, `instructions`, `loopSafety`, `toolOutputConventions`, `sessionContext`, plus an `unsafeProviderOverrides` boolean opt-in.

`resolveSystemPromptOverrides({cli, env, config})` in `src/llm/system-prompt-overrides.ts` is a **pure** function that collapses the three precedence tiers (CLI > env > config) into that struct. It has no I/O: file reads happen one layer up in `src/cli/system-prompt-override-resolution.ts`, which loads `--*-file` / `*_FILE` / `configFileKey` contents into `fileText` before calling the pure resolver.

### The single seam (legacy + modern parity)

The whole feature reduces to threading ONE `SystemPromptOverrides` object into the ONE function every runtime already calls: `resolveSystemPromptForModel()` (plus `buildInstructionsBlockText()` for the instruction fragments). All three call sites already funneled through this function with an identical options object:

- legacy `Agent`: `src/agent/agent.ts`
- modern SDK `AgentCore`: `src/sdk/agent-core.ts`
- resume-drift hash: `src/host/startup/startup-hashes.ts`

So adding `overrides?: SystemPromptOverrides` to `ResolveSystemPromptOptions` and `InstructionsBlockOptions`, and applying it INSIDE those two functions only, makes both runtimes and the hash converge with zero duplicated apply-logic. No override handling leaked into `agent.ts`, `agent-core.ts`, or the prompt-contributor adapter.

Application points, all in the two builders:

- `full` replace/omit short-circuits the whole core-controllable body in `resolveSystemPromptForModel` (an omit returns `[]`; a replace returns a single text block).
- `identity` replace/omit applies to the neutral identity line (providers may still swap it — e.g. Anthropic OAuth).
- `instructions` / `loopSafety` / `toolOutputConventions` apply per-fragment in `buildInstructionsBlockText` via `applyPromptPartOverride`, then empty fragments are filtered so the "everything-off" case is byte-stable.
- `sessionContext` applies to the plugin/session-context block in `buildAgentSystemBody` (one place, so the legacy loader block and the AgentCore prompt-contributor join get identical behavior).
- `providerPreamble` is threaded to `SystemPromptContext` for the provider plugin to honor.

### Safety gates

- **Provider preamble is guarded.** Replacing or omitting `providerPreamble` is REFUSED (fail-fast `SystemPromptOverrideError`, exit 2 at startup) unless `--unsafe-system-prompt-overrides` is set. The Anthropic OAuth preamble is server-validated, so silently dropping it would break account requests.
- **`full` wins over parts.** When `full` is active, the individual core-part overrides (identity/instructions/loopSafety/toolOutputConventions/sessionContext) are ignored (friendly-ignore, not an error). `providerPreamble` is NOT ignored by `full`.
- **Conflicts fail fast.** Setting more than one of text / file / omit for the same part in the same tier is a `SystemPromptOverrideError` (exit 2), surfaced in `entry-args.ts` before auth/plugin boot — the same place the dash-typo check exits.
- **No prompt bytes leak as the user prompt.** Every value-taking override flag is registered in `FLAGS_WITH_VALUES` and every `--no-*` in `FLAGS_NO_VALUE` (`src/cli/extract-prompt.ts`), so an override value or file path is never mistaken for the bare-positional prompt (the `--resume`-class regression).
- **Resume drift stays honest.** Overrides fold into the `systemHash` (`startup-hashes.ts`), so default/replace/omit are distinct prefixes and a resumed session detects a prompt-shape change.

### No hardcoded prose

The only new strings in `.ts` are flag names, config keys, and error messages. Any replacement default text loads from `.md`. This landed alongside a separate extraction of the runtime attachment strings (turn-aborted, output-truncated, response-truncated, emergency-cap, reflection-checkpoint) out of `agent.ts` / `agent-core.ts` / `reflection.ts` into `PROMPTS.ts` modules + `src/prompts/runtime/*.md`, applying the same "no model-facing string hardcoded in a `.ts`" rule.

## Flags

| Part | Replace | From file | Omit | Env | Config key |
| --- | --- | --- | --- | --- | --- |
| Whole prompt | `--system-prompt` | `--system-prompt-file` | `--no-system-prompt` | `MINIMAL_AGENT_SYSTEM_PROMPT` | `systemPrompt.full` |
| Identity | `--system-identity` | `--system-identity-file` | `--no-system-identity` | `MINIMAL_AGENT_SYSTEM_IDENTITY` | `systemPrompt.identity` |
| Instructions | `--system-instructions` | `--system-instructions-file` | `--no-system-instructions` | `MINIMAL_AGENT_SYSTEM_INSTRUCTIONS` | `systemPrompt.instructions` |
| Loop safety | `--system-loop-safety` | `--system-loop-safety-file` | `--no-system-loop-safety` | `MINIMAL_AGENT_SYSTEM_LOOP_SAFETY` | `systemPrompt.loopSafety` |
| Tool output conventions | `--system-tool-output-conventions` | `--system-tool-output-conventions-file` | `--no-system-tool-output-conventions` | `MINIMAL_AGENT_SYSTEM_TOOL_OUTPUT_CONVENTIONS` | `systemPrompt.toolOutputConventions` |
| Session context | `--system-session-context` | `--system-session-context-file` | `--no-system-session-context` | `MINIMAL_AGENT_SYSTEM_SESSION_CONTEXT` | `systemPrompt.sessionContext` |
| Provider preamble | `--provider-system-preamble` | `--provider-system-preamble-file` | `--no-provider-system-preamble` | `MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE` | `systemPrompt.providerPreamble` |
| (opt-in) | `--unsafe-system-prompt-overrides` | | | `MINIMAL_AGENT_UNSAFE_SYSTEM_PROMPT_OVERRIDES` | `systemPrompt.unsafeProviderOverrides` |

Precedence per part: CLI flag > env var > config > default. Passing `""` to any replace flag, or the `--no-*` flag, means omit. In config, `false` or `null` means omit.

### Config example

```jsonc
{
  "systemPrompt": {
    "instructionsFile": "~/prompts/my-agent.md",
    "loopSafety": false,          // omit
    "toolOutputConventions": null // omit
  }
}
```

## Verification

- New `src/llm/system-prompt-overrides.test.ts` (23 tests): tri-state precedence, empty-string/omit, per-tier conflict detection, provider-preamble gating, `full`-ignores-parts.
- New `src/cli/system-prompt-override-resolution.test.ts` (27 tests): CLI/env/config resolution with an injected file reader, missing-file exits, skip-parts precedence.
- New `src/llm/system-prompt-override-assembly.test.ts` (19 tests): default byte-identity, every replace/omit path, `full` short-circuit, multi-override.
- New `src/llm/system-prompt-override-parity.test.ts` (5 tests): identical overrides produce identical resolver output, deterministic across runtimes.
- New `src/e2e/system-prompt-override-e2e.test.ts` (6 tests): drives the real `prepareEntrypointArgs` path — value flags consume their value, file flags read the file, `--no-*` doesn't eat the next positional, override + positional keeps the positional, override + `--prompt` lets prompt win, missing file exits 2.
- New `src/host/startup/startup-hashes.test.ts` (12 tests): default==default, replace!=default, omit!=default, omit!=replace.
- Extended `src/llm/system-prompt.test.ts`, `src/cli/extract-prompt.test.ts`, `src/config/config.test.ts`, `src/host/startup/entry-args.test.ts`.
- Full test suite green; `typecheck` exit 0; `biome check` clean on all touched files.

## Boundary (deliberately out of scope)

Per-section overrides of individual plugin sections (e.g. `--no-system-section tool:Fetch`, hiding just the environment context) are NOT included. They need structured section output from the loader rather than post-processing the composed block, and are a separate change. The plugin block is controllable today only as a whole via `sessionContext`.
