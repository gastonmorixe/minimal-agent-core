# fix: gate interleaved-thinking off for opus-4-8 (tool-batch hallucination)

**Date**: 2026-05-31
**Type**: fix
**Scope**: `src/headers.ts`, `src/headers.test.ts`, `plugins/llm-anthropic/beta-flags.ts`, `plugins/llm-anthropic/anthropic.test.ts`
**Tracking**: TODOS.md `T-7c3f02`. Full investigation: `private/tool-bugs-and-improvements/` (docs 01-08; the corrected root cause is doc 08).

## Symptom

On `claude-opus-4-8`, tool-heavy turns appeared to "stall then flush": the model
behaved as if its tool results were arriving late and in batches, retried calls
it believed had not landed, and produced runs with large numbers of duplicate
tool calls (one observed session: 33 blobs, 21 of them byte-identical re-reads).
The model's own thinking narrated "the tool results are batching up and flushing
together rather than arriving inline."

## Root cause (wire-proven)

Not a transport/delivery bug. The harness delivers every tool result correctly.
Verified against this repo's `.net-dbg` captures:

- For every assistant turn, the next request carries a matching `tool_result`
  for every `tool_use` block. Cumulative counts line up exactly across 20
  round-trips (21 -> 65 -> 78 -> ... -> 143). Zero dropped, zero stalled.
- The defect is **model behavior under `interleaved-thinking-2025-05-14`**:
  opus-4-8 emits many `tool_use` blocks in a SINGLE turn (observed: 44 tool_use
  + 21 interleaved thinking blocks, 16.5K output tokens, in one message), and the
  `thinking` blocks BETWEEN those tool_use blocks reason as if earlier same-turn
  tool results already exist. They cannot: every tool in a turn runs only after
  the turn ends. The model then invents a "results are stalling/batching" story
  and spirals into ever-larger tool batches. Next turn all results return at once
  — the "batch flush" it predicted, self-inflicted.
- **Differential proof**: a pre-refactor `opus-4.7` capture with the SAME
  `interleaved-thinking` beta shows clean one-tool-per-turn behavior and correct
  `stop_reason:"tool_use"`. The behavior change tracks the MODEL (4.7 -> 4.8),
  not the provider-plugins refactor (which kept Anthropic on the byte-identical
  legacy `sendMessage` path).
- Secondary, harmless: opus-4-8 sometimes returns `stop_reason:"end_turn"` on a
  message that contains `tool_use` blocks. The agent loop keys tool execution off
  `blocks.filter(type==="tool_use")` (agent.ts:1077), NOT `stop_reason`, so this
  mislabel never affected correctness.

## Fix

Omit the `interleaved-thinking-2025-05-14` beta for `opus-4-8` only. The model
falls back to standard adaptive thinking: it thinks once, emits its tool batch,
receives ALL results, then thinks again next turn — so no thinking block ever
sits between same-turn tool_use blocks to hallucinate results into. This removes
the mechanism at its source.

- `src/headers.ts` `buildBetaFlags` (legacy path, live for Anthropic): gate added
  in the `conversation` branch.
- `plugins/llm-anthropic/beta-flags.ts` `buildBetaFlags` (canonical path, for
  `MINIMAL_AGENT_CANONICAL_TRANSPORT=all` and non-legacy routing): mirror gate so
  both transports agree.
- Scope is `opus-4-8` only. `opus-4.6/4.7` and `sonnet-4-6` keep interleaved
  thinking (the captures show they sequence tool use correctly).
- Escape hatch: `MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING=1` restores the flag
  for opus-4-8 (experiments / future model fixes).

## Tests

- `src/headers.test.ts`: +3 guards — opus-4-8 omits the flag; opus-4-7 + sonnet
  keep it; the force env var restores it. The pre-existing pinned opus-4-7
  ordering test stays green (4-7 is unaffected).
- `plugins/llm-anthropic/anthropic.test.ts`: the two opus-4-8 fixture-parity
  assertions updated to reflect the deliberate deviation from the live CLI
  (interleaved omitted; flag count 11 -> 10), with comments pointing at T-7c3f02.
- Full suite: **4436 pass, 0 fail, 10 skip.** Touched files typecheck clean.

## Not done (deliberately)

- No transport / stream-assembly changes: the transport is correct (audited
  `src/client.ts` SSE parser 750-967; preserves every block type in order, reads
  `stop_reason` from the wire). The earlier hypotheses in docs 02/05/06/07
  blaming `sendFn` assembly were wrong and are corrected in doc 08.
- Blob content-dedup (was T-7c3f02 task 3c) deferred to a standalone TODO
  (`T-9d2e44`): its justification (cap a retry storm's disk bloat) is gone now
  that the cause is fixed, and a safe version needs ref-counting / a
  content-addressed store. Not worth the hot-path risk defensively.

## Note on the investigation

This bug is unusual: it induces false beliefs in the agent and the agent cannot
detect them in-the-moment. The first investigation session (on opus-4-8, with the
bug active) drew several confident wrong conclusions ("fabricated reads", "empty
dirs", a "transport regression") before a fresh session on a clean transport read
the actual wire captures and source. Docs 05-07 preserve that wrong path on
purpose; doc 08 is the corrected, evidence-backed root cause.
