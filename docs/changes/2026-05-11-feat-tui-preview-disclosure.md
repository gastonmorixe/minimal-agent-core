# feat: tool descriptions disclose TUI preview cap + `<ma::tui-preview>` runtime annotation

**Date**: 2026-05-11
**Type**: feat
**Scope**: src/tools.ts (descriptions), src/agent.ts (annotation), src/tools-descriptions.test.ts + src/agent.tui-preview.test.ts (tests)

## Problem

The agent has two independent output caps that clamp tool output:

1. **API cap** (`tools/truncation.ts`): `MAX_TOOL_OUTPUT_BYTES = 64_000`,
   `MAX_TOOL_OUTPUT_LINES = 1_000`. Clamps what the model receives
   on the next turn via `tool_result.content`. When this cap fires, a
   trailing `[truncated: shown N of M bytes, sL/tL lines; cut at byte
   B, line L. <hint>]` annotation is appended to `content` so the
   model has a structured resume signal.

2. **TUI preview cap** (`agent.ts:TOOL_PREVIEW_LINES`): `Bash = 10`,
   `Read = 15`, `Grep = 12`, `Glob = 25`, default 10. Clamps what the
   user sees in the transcript. `formatToolPreview` renders only the
   first N lines and emits a `shown N/M L` footer to the user.

Until now, the model was told ONLY about the API cap (via tool
descriptions and the `[truncated:]` annotation). It had NO way to know
about the TUI preview cap. The asymmetry produced a real failure
mode: when the model runs Bash that produces 65 lines (well under the
API cap), it sees all 65 lines in `tool_result.content`. The user sees
only 10. The model then writes follow-up assistant text along the
lines of "as you can see above, variant A uses bold dividers"  :  but
the user saw only the first 10 lines, where the variant header
appeared in passing and most of variant A and all of B/C were elided.
The conversation desyncs from the user's reality.

The specific symptom that motivated this work was a model rendering a
65-line ANSI TUI preview via `bash -c 'cat <<EOF; ...EOF'`. The user
saw exactly 10 lines. There was no signal anywhere telling the model
the audience had diverged.

This isn't a model bug  :  it's a tooling/incentive bug. We never told
the model about the second cap, and the model has no observation
channel to discover it after the fact.

## Goals

- **Disclosure**: tool descriptions explicitly mention the TUI preview
  cap as a distinct number, alongside the API cap. The model preempts
  the bug instead of discovering it reactively.
- **Steering**: for Bash specifically (the worst offender, because the
  model is tempted to use it as a visual-render channel), the
  description tells the model to put visual content in the assistant
  text reply instead, which the user reads in full.
- **Runtime signal**: when the TUI preview clamps lines the API cap
  did not, append a model-only annotation to `tool_result.content` so
  the model sees the divergence on the next turn. This handles the
  case where the description was missed AND the case where the model's
  intent for the output was ambiguous.
- **Audience-split invariant preserved**: the annotation is model-only.
  `formatToolPreview` strips it before rendering to the user. Session
  replay (which re-renders historical `tool_result.content`) also
  strips it. The user sees the structured `shown N/M L` footer as
  before. Nothing changes in their view.
- **No new tool surface**: no new tool, no new parameter, no new
  schema. This is pure prompt + a small content append.

## Options considered

### Option A (CHOSEN): Static descriptions + runtime `<ma::tui-preview>` annotation

Two coordinated pieces:

1. **Static**: extend each capped tool's `description` to declare BOTH
   caps. Bash also explicitly tells the model "put visual content in
   your text reply, not Bash output."
2. **Dynamic**: at the end of the tool-render path, if the body
   exceeds the per-tool TUI preview budget, append
   `<ma::tui-preview shown="N" total="M" tool="X">hint</ma::tui-preview>`
   to `content` before sending it back to the API. Skipped when the
   tool was refused / had a `display` override / was aborted.

**+** Smallest patch that fixes the exact bug end-to-end.
**+** Audience-split invariant preserved (no user-visible change).
**+** Zero context cost in the steady state (annotation only fires
when there's a real audience gap).
**+** Per-tool budgets stay where they live. No schema changes.
**−** The strip in `formatToolPreview` and the new annotation share
state via a shared constant (`ANNOTATION_PREFIXES`). One more thing
to keep in sync.

### Option B: `user_visible: true` opt-in on Bash

A new schema field on Bash that bumps the per-call TUI budget from
`TOOL_PREVIEW_LINES.Bash` (10) to `MAX_TOOL_OUTPUT_LINES` (1000) when
set. Lets the model deliberately route "this output IS the
deliverable" through Bash with full transcript rendering.

**+** Real escape hatch for the legit "model wants the user to see a
preview" case. Bounded (still capped by the API cap and terminal
scrollback) so not a footgun.
**−** New schema field to teach the model about.
**−** Doesn't fix the case where the model FORGOT to set it. That's
why Option A is still required underneath.

**Decision**: deferred to a follow-up. Land A first, observe whether
the model stops reaching for Bash-as-rendering after just being told.
If the legitimate "show me the report" use case persists, add B as a
small follow-up commit. Cost ~25 LOC on top of A.

### Option C: `<ma::tui::show>` inline-tag plugin

A new TUI plugin (parallel to `tui-plugins/diff-view` / `memory` /
`interleave-thinking`) providing an `<ma::tui::show>` inline tag the
model emits in its assistant text. The tag body renders directly to
scrollback with no preview cap.

**+** Cleanest long-term separation: Bash for execution, dedicated
channel for visual rendering.
**+** Zero token-cost re-rendering on the next turn (body lives in
the assistant's own text turn).
**−** Current inline-tag scanner (`src/plugins/scanner.ts`) buffers
the full body until `</ma::tui::show>` is seen and only then fires
`onTag`. A long render would block transcript updates until the closer
arrives  :  a UX regression vs Bash, which streams line-by-line through
`onStdout`. Adding streaming-chunk handlers to the scanner is
~150 LOC + careful cross-chunk closer-probe tests.
**−** Doesn't fix the related "mdstream corrupts box-drawing chars
in input" bug (verified empirically: `═` gets wrapped with literal
`**` markers by mdstream's parser), which would block the simpler
"emit ANSI in text reply" alternative.

**Decision**: parked. Bash with `user_visible: true` (Option B)
covers the same use case and reuses Bash's existing streaming
infrastructure. Reconsider if/when there's a use case Bash can't
serve.

## Chosen design  :  details

### Static (`src/tools.ts`)

Each capped tool's description now declares both caps:

```
Bash:
  Output you (the model) receive is capped at ~64KB / 1000 lines.
  ...
  Separately, the user's transcript previews ONLY THE FIRST ~10
  LINES of body and summarizes the rest as `shown N/M L`. Do NOT
  use Bash to render visual content for the user (ASCII art,
  banners, ANSI TUI previews, formatted tables, generated reports)
  : they will only see a fraction. To show visual content, put it
  in your text reply instead, which the user reads in full. When
  the TUI preview clamped more lines than the API cap did, you will
  receive a `<ma::tui-preview shown=N total=M>` annotation on the
  tool_result so the divergence is visible to you on the next turn.

Read:
  ... transcript previews only the first ~15 lines ...

Grep:
  ... transcript previews only the first ~12 lines ...
```

Glob's description was left untouched (its budget is 25, less likely
to bite and the tool is rarely used for user-facing output).

### Dynamic (`src/agent.ts`)

A new helper `computeTuiElision(content, tool)` strips trailing
annotations, counts body lines, compares against the tool's preview
budget, and returns `{ shown, total } | null`.

A second helper `tuiPreviewHint(tool)` returns the per-tool hint body:
Bash gets the "use your text reply for visual content" steering;
other tools get a generic "summarize for the user" nudge.

At the end of the tool-render path (after `formatToolPreview` /
`renderStreamedTail` has run), we append:

```
\n\n<ma::tui-preview shown="N" total="M" tool="X">hint body</ma::tui-preview>
```

to `content` BEFORE building the `tool_result` block that goes to the
API. The render path has already completed, so the annotation never
reaches the user's transcript live.

Skipped when any of:
- the tool was refused by the mode gate (no execution),
- the tool returned a `display` override (Edit/Write/ShowDiff render
  in full by design),
- the tool was aborted (partial output, pointless to nag),
- the body fits the per-tool budget.

### Annotation conventions

Per project convention (saved in memory at this commit), new XML-like
tags we (minimal-agent) parse and treat specially use the `<ma::…>`
namespace. TUI/rendering-related tags get a second-level prefix:
`<ma::tui::show>`, `<ma::tui::diff>`, `<ma::tui-preview>`, etc. This
annotation follows that rule. Existing inline-tag plugin tags
(`<tui::diff>`, `<tui::memory>`, etc.) are grandfathered until a
coordinated rename pass.

### Strip path consolidation

`formatToolPreview` previously stripped only `\n\n[truncated:` (via
`content.lastIndexOf`). It now uses a shared `findAnnotationStart`
helper that takes the earliest of the last-occurrences of:

- `\n\n[truncated:` (API cap notice, legacy)
- `\n\n[note:` (streak tracker note, legacy)
- `\n\n<ma::tui-preview` (this annotation)

`lastIndexOf` per prefix (vs a single forward regex) hardens against
the body legitimately containing the prefix earlier (e.g. a `Read`
that includes the string `[truncated:` in a log file). The earliest of
the lasts is the start of the annotation region, since annotations
stack in a fixed order at end-of-content.

A regression test in `agent.tui-preview.test.ts`
("uses the EARLIEST of the annotations as the strip boundary") pins
this behavior with a Bash call whose body contains the literal text
`[truncated: 42 of 100]` in the middle.

## Files

**Edited**:
- `src/tools.ts`  :  `BASH_TOOL.description`, `READ_TOOL.description`,
  `GREP_TOOL.description` each updated to disclose the TUI cap.
- `src/agent.ts`  :  `let aborted = false` tracker, append-annotation
  block after the render path, `ANNOTATION_PREFIXES`,
  `findAnnotationStart`, `computeTuiElision`, `tuiPreviewHint`, strip
  in `formatToolPreview` switched to `findAnnotationStart`.
- `src/tools-descriptions.test.ts`  :  5 new cases (Bash TUI cap, Bash
  steering, Bash mentions `<ma::tui-preview>`, Read TUI cap, Grep TUI
  cap).

**Added**:
- `src/agent.tui-preview.test.ts`  :  5 cases driving `Agent.run()`
  end-to-end against a fake `sendFn` and inspecting the captured
  `tool_result.content` from the LAST round. Covers: Bash above
  budget under API cap (annotation present, no `[truncated:]`); Bash
  fitting in budget (no annotation); Bash over API cap (both
  annotations present, in the fixed order); Read above its 15-line
  budget (correct tool attribute + non-Bash hint variant); strip
  defends against body containing `[truncated:` literally.
- `docs/changes/2026-05-11-feat-tui-preview-disclosure.md` (this
  file).

## Tests

- `src/tools-descriptions.test.ts` 10 / 10 passing.
- `src/agent.tui-preview.test.ts` 5 / 5 passing.
- `src/agent.test.ts` `appends a streak [note: ...]` 124 / 124
  passing (unchanged  :  `findAnnotationStart` covers `[note:]` too, so
  the strip behavior is identical when only `[truncated:]` + `[note:]`
  are present).
- Full suite 1895+ passing in steady state. The 1 flaky failure
  observed during this work is in `tui-plugins/tasks/` (peer agent's
  domain) and reproduces independently of these changes.
