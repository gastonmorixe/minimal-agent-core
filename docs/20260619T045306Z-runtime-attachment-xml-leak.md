---
title: "Runtime attachment XML leaks into TUI scrollback — root cause + fix"
date: 2026-06-19
session: 111f0c76-0a29-401b-9b0b-16d9a90500ad
tags: [bug, tui, session-history, resume, runtime-attachments]
---

## Symptom

The TUI scrollback showed raw `<ma::agent::tasks>`, `<ma::agent::mode-change>`, `<ma::agent::short-term-memory>` XML tags instead of the rendered task list. The user asked:

> why this session rendered the tag xml instead of the TUI? what's the bug?

The tags appeared in two places:
1. `SessionHistory` tool output (window, search, dump)
2. `--resume` scrollback replay

## Root cause

Two code paths render user message content for display. Only one of them filtered runtime attachment blocks.

**Path A — `session-replay.ts` (resume):** had `isRuntimeAttachmentBlock()` since commit `617eca6`. This function checked whether a text block started with a known attachment opener (`<ma::agent::*`, `<ma::plugin::*`, plus legacy bare forms) and skipped it during replay.

**Path B — `sessions-read.ts` (SessionHistory tool):** `blocksToText()` iterated over every content block and pushed every `text` block verbatim — no filter at all. The `<ma::agent::tasks>`, `<ma::mode-change>`, `<ma::agent::short-term-memory>` etc. all landed in the tool output, which the TUI then rendered as raw XML.

The two paths were independent copies of the same logic. `blocksToText` was written without knowing about the filtering that `session-replay.ts` already implemented.

## Fix (3 parts)

### 1. Extract a shared module (`src/runtime-attachments.ts`)

Moved the canonical regex list and two functions (`isRuntimeAttachmentBlock`, `isRuntimeAttachmentText`) into a single source of truth. Both consumers import from here.

### 2. Wire it into `sessions-read.ts`

`blocksToText` now calls `isRuntimeAttachmentText(b.text)` on each text block before pushing. The regex list is the same one `session-replay.ts` uses.

### 3. Wire `session-replay.ts` to import from the shared module

Removed the private copy of the regex list and `isRuntimeAttachmentBlock` function. They now come from `runtime-attachments.ts`.

## Twist: the model can write these tags too

During the investigation we discovered that **some of the XML the user saw was written by the model itself**, not injected by the agent runtime. Record 95 of session `c1bc2fc0` is an assistant message where the model wrote:

```
Open question for you

<ma::agent::tasks total="3" done="3" doing="0" todo="0" canceled="0">
1  #94b14e done Investigate display-override path in formatToolPreview
2  #1cf3c6 done Investigate the normal content path truncation in formatToolPreview
3  #faaabe done Catalog all callers that provide the display override to formatToolPreview
</ma::agent::tasks>
```

The model echoed the task list XML it had received as a prepended attachment back into its own response prose. This is not a leak — it's legitimate assistant content. The filter skips agent-prepended blocks but must NOT skip assistant content (filtering assistant text that happens to mention `<ma::agent::*>` would break legitimate model output).

## How to diagnose this faster next time

1. **Check the block boundaries.** Run `python3 -c "import json; ..."` against the session `.jsonl` to see which block each XML tag lives in. Agent-prepended attachments are always their own dedicated blocks at the start of a user message. Model-written XML is embedded inside an assistant text block alongside other prose.

2. **Check the record kind.** If `kind === "assistant"`, the XML is model-written prose, not an agent injection. If `kind === "user"` and the block is at position 0 in the content array, it's likely an agent-prepended attachment.

3. **Test the regex in isolation.** The regex from `runtime-attachments.ts` is anchored at start-of-block (`^\s*`). A tag appearing at byte 5351 inside a block won't match. Only tags at position 0 match. This is by design.

## Files changed

| File | Change |
|------|--------|
| `src/runtime-attachments.ts` | New shared module with canonical regex list + two functions |
| `src/runtime-attachments.test.ts` | New — 8 tests covering every attachment category, case-insensitivity, whitespace, false-positives |
| `src/session-replay.ts` | Deleted private copy, imports from shared module |
| `src/session-replay.test.ts` | 2 new tests: `stringifyUserText` unit test + full `replayToScrollback` integration test with `<ma::agent::tasks>` schema |
| `src/plugins/host/providers/sessions-read.ts` | `blocksToText` now calls `isRuntimeAttachmentText`; imports shared module |
| `src/plugins/host/providers/sessions-read.test.ts` | 1 new regression test with 21 blocks covering every attachment variant + edge cases |
