# Phase 5 Plan — Wire `AgentCore` into the non-interactive `--json` path

Owner: Dorothy. Status: PLAN / paper only (no code until Laura declares P4 done).
Target HEAD at drafting: `715d3dc`.

## Goal

Make the eventSink work load-bearing in the product. Today the non-interactive
CLI drives the **legacy `Agent`** (yields text chunks), so `--json` only emits
the final answer as one JSONL line. Phase 5 swaps in `AgentCore` for the
**non-interactive `--json` path only**, passing a `JsonlEventSink`, so the user
gets the full Codex-style `turn_started / item_started / item_completed /
tool_result / turn_completed` event stream.

Smallest blast radius first: **non-interactive `--json` only**. The interactive
REPL and human/`--print` non-interactive paths stay on legacy `Agent`, untouched,
until the adapter set is proven.

## Honest starting point: interfaces exist, adapters do not

P1/P2 delivered the port **interfaces** (`src/sdk/ports.ts`) and `AgentCore`,
tested against **fake** ports (`agent-core.test.ts`). No concrete adapter binding
a real collaborator (PluginLoader, SessionStore, …) to a port exists yet. So the
Phase 5 adapter inventory below is **almost entirely net-new**. That is the real
work; the wire-in itself is a few lines.

## Collaborator inventory

The legacy `Agent` is constructed at `src/index.ts:1397` with these inputs.
Mapping each to its target port + adapter:

| Legacy `Agent` input | Target port | Adapter strategy | Exists? | Risk |
| --- | --- | --- | --- | --- |
| `auth` | `AgentCoreConfig.auth` | pass-through | yes | none |
| `model` | `.model` | pass-through | yes | none |
| `providerId` | `.providerId` | pass-through | yes | none |
| `effort` | `.effort` | pass-through (string→union cast) | yes | low (type) |
| `speed` | (n/a) | AgentCore hardcodes `"normal"` today | partial | low — add `.speed` if fast-mode needed in `--json` |
| `serviceTier` | `.serviceTier` | pass-through | yes | none |
| `thinkingDisplay` | `.thinkingDisplay` | pass-through | yes | none |
| `outputSchema` | (n/a yet) | add `.outputSchema?` to `AgentCoreConfig`, thread to request (mirror Jacob's `outputConfigSpread`) | net-new | med — must match legacy threading exactly |
| `loader` (tools) | `ToolRegistry` + `ToolExecutor` | registry = `TOOL_DEFINITIONS + loader.getExtraTools()`; executor = thin wrapper over `executeToolRound` | net-new | **high** — executeToolRound is the heavy seam |
| `loader` (prompt/PROMPT.md) | `PromptContributor.systemPromptBlocks` | adapter calls `loader.getPromptBlockAsync()` | net-new | med — system prompt parity |
| `modeManager` | `ModeProvider` | adapter over `ModeManager` (activeModeId, promptPrefix, filterTools, consumePendingAttachment) | net-new | med — mode gating parity |
| `saveEcho` | `PromptContributor.saveEchoes` | adapter calls `saveEcho.consumeAll()` | net-new | low |
| `turnAttachments` | `PromptContributor.turnAttachments` | adapter calls each producer's `toAttachment()` | net-new | low |
| `store` | `SessionPersistence` | adapter over `SessionStore` (appendUser/Assistant/ToolResult/Note/Rewind) | net-new | med — resume parity |
| `blobStore` | (folds into `ToolExecutor`) | the executeToolRound adapter already takes `blobStore` | net-new | med — rides executor |
| `initialMessages` | `.initialMessages` | pass-through | yes | none |
| `toolTimeTracker` | (n/a) | cosmetic transcript-only; drop in `--json` (no transcript) | n/a | none |
| media (inline in legacy) | `MediaResolver` | adapter wraps `resolveUserTurnContent` | net-new | low |

### The one hard adapter: `ToolExecutor` over `executeToolRound`

`executeToolRound` (`src/agent/tool-round.ts:192`) wants a `ToolRoundContext`
with: presentation, writeTranscript, loader, modeManager, blobStore,
blobSkipTools, feedbackTracker, toolTimeTracker, model, store, signal.

The `ToolExecutor.execute(toolUse, signal)` port returns a `ToolExecResult`.
The adapter constructs a `ToolRoundContext` per call (transcript sink = no-op or
event-routing in `--json`, presentation = empty, feedbackTracker = a
per-run instance) and returns the produced `ToolResultBlock` mapped to
`ToolExecResult`. This is where parity risk concentrates: the legacy path's
plugin dispatch, didInvoke hooks, blob capture, and persistence all live inside
`executeToolRound`. Reusing it verbatim is the safest route (no behavior fork).

## Where adapters live (ratchet-safe)

All concrete adapters live on the **host side** under `src/host/sdk-adapters/`
(net-new dir), NOT in `src/sdk/`. They import host concretions (PluginLoader,
SessionStore, executeToolRound) and inject inward into `AgentCore` via the port
interfaces. `AgentCore` keeps importing only `src/sdk/*` + `src/llm/*` + neutral
core — never host. The existing `sdk-port-boundaries` ratchet + the core→host
ratchet (Betty's) both stay green: adapters depend on ports, not vice versa.

## index.ts seam

In the non-interactive branch (around `src/index.ts:1556`), today:

```
const jsonMode = printOut.outputMode() === "json"
... const gen = agent.run(prompt)  // legacy Agent
```

Phase 5 (guarded, non-json path BYTE-IDENTICAL):

```
if (jsonMode) {
  const core = buildAgentCore({ /* adapters from the same deps */,
                                eventSink: new JsonlEventSink(s => process.stdout.write(s)) })
  const gen = core.run(prompt)         // emits events; raw text suppressed as today
  ... drain ...
} else {
  const gen = agent.run(prompt)         // UNCHANGED legacy path for --print/human
  ...
}
```

The legacy `Agent` construction at L1397 stays; AgentCore is built only when
`jsonMode`. Non-json runs never touch the new path → zero regression to `--print`.

## Test strategy

1. **Golden parity** (the load-bearing one): for a fixed prompt + mocked
   transport, assert `AgentCore` path produces the SAME final answer text as the
   legacy `Agent` path. Same mock, two runners, diff the final answer.
2. **Full event-stream assertions**: drive a tool-using turn through the
   AgentCore+JsonlEventSink path, capture stdout, assert the JSONL sequence:
   `turn_started → item_started(tool_use) → tool_result → turn_completed`, and
   that `tool_result.id === item_started.id` survives the wire. Betty already
   froze this contract at the SDK level: `fc97e75`
   (`src/sdk/events-jsonl.integration.test.ts`) drives a real
   `AgentCore.run()` through a real `JsonlEventSink` and golden-asserts the exact
   JSONL stream (text turn + tool-call turn, id-join proven). That golden is the
   regression net for the swap — Phase 5 keeps it green (and the id-join
   assertion is the consumer-critical invariant; never break it). Phase 5 adds
   only the **index.ts integration-level** assertion (events reach real stdout).
3. **No-regression**: `--print` (human, non-json) output is byte-identical
   before/after — snapshot the existing e2e.
4. **Ratchet**: `sdk-port-boundaries` + core→host import scan stay green.

## Sequencing / guardrails

- HARD: no index.ts or shared-file edits until Laura declares P4 done (Jacob is
  mid-flight in index.ts; a second editor = the clobber we keep avoiding).
- Phase 5 lands as its own commit(s) with its own green gate, never bolted onto
  P4's tail.
- Build order: (1) `src/host/sdk-adapters/` with the ToolExecutor adapter first
  (highest risk), behind a parity test, (2) the remaining adapters, (3) the
  index.ts seam guarded on `jsonMode`, (4) integration + golden tests.

## Open questions for Laura

- `outputSchema` on `AgentCoreConfig`: add it now (mirror legacy threading) so
  `--json --output-schema` works through AgentCore too? Or defer.
- Do we eventually converge the interactive REPL onto AgentCore, or is
  non-interactive `--json` the permanent boundary? (Recommend: prove
  non-interactive first, decide convergence later — out of Phase 5 scope.)
