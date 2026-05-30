# Rolling cache breakpoint: never mark a trailing thinking block (fix 400)

**Status:** shipped (one-function fix + regression tests).
**Owner:** agent (continuation of session b6397169; handoff `private/work/handoff-thinking-block-400.md`).
**Bug report:** `messages.11.content.107: 'thinking' or 'redacted_thinking' blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.` (Anthropic, opus-4-8, legacy `client.ts` transport, forked/resumed session.)
**Distinct from:** [`2026-05-30-preflight-thinking-model-mismatch.md`](./2026-05-30-preflight-thinking-model-mismatch.md), which fixes the *model-signature* mismatch 400 (a thinking block signed by a different model). This one is a *content-mutation* 400: the block's bytes were altered between the original response and the re-send.

## Root cause

`withRollingCacheBreakpoint` (`src/agent/cache.ts`) placed the rolling
`cache_control: { type: "ephemeral", ttl: "1h" }` marker on the **last block of
the last message**, unconditionally. The Anthropic API pins the bytes of
`thinking` / `redacted_thinking` blocks in the *latest assistant message* and
rejects any modification, and attaching `cache_control` to such a block counts
as a modification. So whenever the conversation is re-sent with the last message
being an assistant turn whose final block is a thinking block, the request 400s
on the whole turn.

That state is reachable whenever an assistant turn is re-sent without a trailing
user message: an assistant **prefill** (`capabilities.assistantPrefill`), or a
**forked/resumed** session whose last record is a long interleaved-thinking turn
(thinking interleaved between many tool calls, the `content.107` in the report).
In the steady-state agent loop the last message is always a `user` turn
(tool_results or prompt), whose last block is never thinking, which is why the
bug only surfaced on re-sent assistant turns.

Everything else in the legacy send path was ruled out: session-store round-trips
thinking blocks verbatim (lossless `JSON.stringify`/`parse`, signature intact);
`session-restore.foldRecords` / `repairMessages` preserve assistant content by
reference (no reorder, shallow copy); the preflight pipeline is a no-op on the
clean path; the cache-marker *strip* rebuilds thinking blocks byte-identically
(they carry no `cache_control` to drop); and `clear_thinking_20251015 / keep:"all"`
is a server-side no-op (`applied_edits: []` in captures).

## The fix

In `withRollingCacheBreakpoint`, choose the breakpoint target by walking back
from the last block to the last **non-thinking** block, and mark that one
instead. If every trailing block is thinking, skip the breakpoint for this turn
(the two static system-prompt breakpoints still cache the bulk of the prefix).
`thinking` and the literal `redacted_thinking` wire type are both treated as
ineligible.

```ts
let idx = blocks.length - 1
while (idx >= 0 && isThinkingBlock(blocks[idx])) idx--
if (idx < 0) return out            // all-thinking tail → no breakpoint
blocks[idx] = { ...blocks[idx], cache_control: { type: "ephemeral", ttl: "1h" } }
```

No behavior change in the steady state (user-last sends): the last block is a
text / tool_result, so `idx` stays at the end exactly as before.

## Tests

Four regression tests in `src/agent.test.ts` (`describe("withRollingCacheBreakpoint")`):

- trailing thinking block is never marked; breakpoint moves to the last
  non-thinking block.
- the latest assistant message's thinking blocks are sent byte-identical (text +
  signature, no added/stripped `cache_control`).
- an all-thinking last message gets no breakpoint at all (request stays valid).
- a literal `redacted_thinking` tail block is guarded too.

`bun run typecheck`, `oxlint`, `biome format` (touched files), `typedoc`, and the
full `bun test` suite (3811 pass / 0 fail) are green.
