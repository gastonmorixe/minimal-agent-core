# Sub-agent result protocol via a tool, plus context-gated tool availability

**Date:** 2026-06-01
**Scope:** `src/plugins/types.ts`, `src/plugins/loader.ts`, `src/plugins/loader/helpers.ts` (new `available()` mechanism); `plugins/sub-agents/*` (new `ReportResult` tool, salvage-on-incomplete, prompts moved to markdown, style pass).

## Problem

Two issues surfaced from a real run where two research sub-agents burned ~55-60k tokens each, then reported `incomplete` with no deliverable, forcing the lead to mine their raw transcripts.

1. **The completion transport leaned on the model.** A worker "finishes" by leaving a result sentinel the supervisor reads. The worker was told (in prose) to write that file itself. Under context pressure workers tried to delegate the write to a sub-agent (which bounces on the nesting ban) and exited with no sentinel and no file. You can't force a model to write a particular file.

2. **`ReportResult` was visible to the lead.** The first cut of the completion tool was env-gated at dispatch (a lead call returned an explanation). But the tool still appeared in the lead's tool list, wasting tokens and inviting the lead to call it. Tools registered statically from the manifest, with no way to say "only in this context."

## Design

### `ReportResult` completion tool (real enforcement, not a prompt)

A worker calls `ReportResult({summary, artifacts?, incomplete?})` as its final action. The HANDLER (running in the worker process) writes the sentinel deterministically (atomic temp + rename), so the model never touches a path or hand-rolls JSON. The model only supplies findings.

Layered, ranked best to worst, so a provider without tool calling still works:

1. `ReportResult` tool call writes the sentinel (the real path now).
2. Manual sentinel write (documented fallback in the result-protocol template).
3. Distilled final assistant message (`done (distilled)`).
4. `incomplete` floor.

Pure core in `plugins/sub-agents/lib/report.ts` (validate + build digest), round-tripping through the same `parseResultDigest` the supervisor probe uses.

### Context-gated tool availability (`available()`)

A general loader feature, not specific to sub-agents. A tool handler module may export:

```ts
export const available: ToolAvailability = (ctx) => boolean
```

`ctx` is a small read-only slice (`env`, `cwd`, boot `agent`). Returning `false` hides the tool from `getExtraTools()` that turn, so it is absent from the model's tool list. `buildBlock` separately drops the system-prompt section of a plugin whose entire tool surface is hidden. The predicate is evaluated once per turn (dynamic), must be cheap and side-effect free, and should key only on process-lifetime-stable facts so the cached system-prompt prefix stays byte-stable.

Dispatch is NOT gated by `available()`: a hidden tool's handler still runs if somehow invoked (resumed transcript, hallucinated name), keeping its own defensive check. Availability controls advertisement, not execution. A throwing predicate fails open (tool stays visible) and is logged.

`ReportResult` uses it: `available = (ctx) => Boolean(ctx.env.MINIMAL_AGENT_SUBAGENT_RESULT_PATH)`. The lead has no result path, so the tool never appears in the lead's tool list. Workers carry it (stamped by the spawn plan), so they see it.

### Salvage on incomplete

When a worker reports findings but a contracted `expectArtifacts` file is missing, the supervisor still marks it `incomplete` (the file gate holds) but salvages the worker's summary onto the status, so `AgentResult` shows the findings instead of forcing a transcript dive.

### Prompts moved to markdown + style pass

The worker result-protocol and the leaf-discipline clause moved from TS string literals into `plugins/sub-agents/prompts/*.md`, loaded through the `src/prompts.ts` seam (repo convention). `PROMPT.md` and the model-facing tool descriptions got a style pass (no em-dashes, plainer words).

## Tests

- `report.test.ts`, `report_result.test.ts`: pure core + handler (writes valid sentinel, no-op for a lead, INCOMPLETE prefixing).
- Loader: a tool with `available` returning false is omitted from `getExtraTools()` and its single-tool plugin's prompt section is dropped; dispatch still reaches a hidden tool.
- Integration: a worker that finishes via the `ReportResult` handler reaps to `done`; a worker that reports findings but no file is `incomplete` with salvage.

No wire-shape change for existing tools: a handler with no `available` export is always advertised, exactly as before.
