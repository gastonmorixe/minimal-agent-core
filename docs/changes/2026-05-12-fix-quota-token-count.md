# Fix: quota footer's bogus cumulative "tokens this session" → contextSize + pretty context bar

**Date:** 2026-05-12
**Type:** bugfix (with UX polish)
**Status:** Landed in commits `a1625c7`, `65653c0`, `6c2292f`.

## Problem

The live-area footer's session block displayed a token count that
ballooned absurdly fast. After a handful of turns of normal use users
saw lines like `✦ 4.2M tok · 4.2M cached` — a number that's
mathematically impossible given how much real work had been done.

Cross-check vs Anthropic's own counters (the `Rate limit summary` lines
visible after each response):

```
5-hour: 14.0% used : allowed, resets in 3h 27m
7-day:  20.0% used : allowed, resets in 136h 47m
```

These numbers were stable across turns. Anthropic's authoritative
view: this session is doing modest work. Our footer's view: 4.2M
tokens. The two disagree by an order of magnitude. The footer was the
liar.

## Root cause

`src/session-tokens.ts:addSessionUsage` did:

```ts
totals.total += i + o + cr + cc
```

…on every `message_start` event. The trap is `cr`
(`cache_read_input_tokens`). Anthropic's prompt cache re-serves the
**entire cached prefix** on every subsequent turn — so summing per-turn
`cache_read` across N turns counts the same content ~N times. For a
typical agentic session with a ~50k context that gets cached and
re-read, after 12 turns the displayed "total" is ~12 × 50k = 600k,
while the actual conversation footprint is still 50k.

Simulation (30 turns, growing context):
- Real context size at end: **68.9k**
- Displayed `total`:        **1.4M**  (~20× inflation)
- Of which `cacheRead`:     **1.3M**  (dominates everything else)

The "and `4.2M cached`" subtitle was the smoking-gun visible symptom:
when `total ≈ cached`, you're staring at a sum that's mostly recycled
cache reads.

## Cross-check vs Claude Code (the canonical UI indicator)

`cc-03312026/src/utils/tokens.ts` documents the right contract
verbatim:

```ts
/**
 * Get the current context window size in tokens.
 * ...
 * Always use this instead of:
 * - Cumulative token counting (which double-counts as context grows)
 * - ...
 */
export function tokenCountWithEstimation(messages) { ... }
```

Their live UI indicator
(`components/PromptInput/Notifications.tsx:75-76`) uses
`tokenCountFromLastAPIResponse` which reads the **last API response's
usage** and computes `input + cache_create + cache_read + output`. No
cumulation. Their cost-tracker (`src/cost-tracker.ts`) DOES sum the
four token categories cumulatively but never displays the sum — only
per-category breakdowns and dollar cost. They were never naive about
this.

## Options considered

### Option A — "Tokens of new work this session" (cumulative, fixed)

```ts
total = input + output + cache_create   // exclude cache_read
```

The unique work done by the conversation. Honest but underwhelming —
the displayed number stays small even after long sessions. Doesn't
answer "how full is my context window?", which is the question users
actually ask.

**Rejected** for being uninformative.

### Option B — "Current context size" (per-turn snapshot)

```ts
contextSize = latest_turn.input + latest_turn.cache_read + latest_turn.cache_create
```

What the model is currently holding. Directly comparable to the
model's hard context-window limit (200k / 1M). Naturally bounded —
can't exceed `context_window` even after 10,000 turns. Answers "am I
about to hit the wall?", which is the question users actually mean.

Matches Claude Code's `getTokenCountFromUsage` precisely (modulo
including or excluding the latest `output_tokens` — see "Output
exclusion" below).

**Chosen.**

### Option C — "Billed-equivalent tokens"

```ts
billed = input + output + cache_create + 0.1 * cache_read   // pricing factor
```

Honest about pricing (cache reads are billed at ~10% of input rate).
Tracks Anthropic's quota windows directly. But the magic constant
moves with pricing and the resulting number is opaque to humans — it
doesn't map to anything anyone can act on. Anthropic's own rate-limit
header is the better source of truth for this view.

**Rejected** in favor of relying on Anthropic's rate-limit headers
(which the same footer already renders) for the billed-equivalent
view.

### Output exclusion

Claude Code's `getTokenCountFromUsage` includes `output_tokens` in the
context-size sum (`input + cache_create + cache_read + output`). We
**exclude** `output_tokens` from `contextSize` for one practical
reason: minimal-agent observes `usage` at `message_start` (the SSE
event), which fires before generation. At that point `output_tokens`
isn't known — Anthropic reports it as 0 or absent until
`message_stop`. To include it we'd need a second update pass at
`message_stop` and the value would briefly be wrong between the two
events. The input portion is the dominant term anyway for any
non-trivial conversation.

The cost of this choice: our `contextSize` lags Claude Code's by 1-2k
on the most recent turn (the missing output). Acceptable for a UX
indicator. If we later care, the fix is a `message_stop` observer
that bumps `contextSize` by the final `output_tokens`.

## Design

### Data layer — `src/session-tokens.ts`

`SessionTokens` gains a new field with **replace-not-accumulate**
semantics:

```ts
contextSize: number   // i + cr + cc from the LATEST turn only
```

The existing cumulative fields (`input`, `output`, `cacheRead`,
`cacheCreate`, `total`) are retained as debug-only with explicit
warnings in their docstrings about the inflation pitfall (so a future
agent doesn't innocently reach for `total` again).

`addSessionUsage` now does:

```ts
totals.contextSize = i + cr + cc    // overwrite, NOT +=
```

### Render layer — `tui-plugins/quota-status/render.ts`

Session segment goes from `✦ 47.5k tok · 38k cached` to:

```
✦ ▎░░░░░░░ 24% 47.5k ctx
```

Same 8-cell fractional-fill bar, same color grading (green <60%,
yellow 60-84%, red ≥85%), same `█▏▎▍▌▋▊▉░` glyph ramp as the quota
windows. Bar percent = `contextSize / contextWindow`, clamped at 100.

Visual states:

```
Cold:     ✦ ░░░░░░░░ 0% 0 ctx               (always-on, see below)
Light:    ✦ █▉░░░░░░ 24% 47.5k ctx          (green)
Loaded:   ✦ █████▎░░ 65% 130k ctx           (yellow)
Hot:      ✦ ███████▎ 90% 180k ctx           (red — soft "compact me")
Overflow: ✦ ████████ 100% 250k ctx          (clamped)
Compact:  ✦ 47.5k ctx                       (bar drops at narrow widths)
```

### Always-on rendering

Per the user's UX request, the session block **always** renders, even
at 0 `contextSize`. The empty bar at 0% acts as a "this is your
context budget" signpost from the very first paint. The render is
cheap and the line is sticky-bottom anyway. Only `showSession: false`
suppresses it (used by some quota-only test paths).

### Responsive degradation

Tightens the existing ladder with a new `withSessionBar` axis. Order
of drop under narrowing terminal width:

1. Drop overage suffix (existing).
2. Drop session bar (keep `✦ N ctx`).
3. Drop session entirely.
4. Drop reset countdowns.
5. Drop the 7d window.
6. Keep just the 5h bar (the leanest non-empty form).

### Context-window detection — `tui-plugins/quota-status/handler.ts`

`MINIMAL_AGENT_MODEL` env (set by the agent at startup, before plugin
load) carries the active model ID. `has1mContext()` (exported from
`src/client.ts`) returns true for `[1m]` suffix. The handler resolves
the denominator once at startup:

```ts
function resolveContextWindow(): number {
  const model = process.env.MINIMAL_AGENT_MODEL ?? ""
  return has1mContext(model) ? 1_000_000 : 200_000
}
```

Snapshot-once: model can be switched per call via `--model`, but the
live-area footer is per-process. Worst case (user runs `--model`
override with a 1M variant the env wasn't set for) the bar shows a
higher fill ratio than reality — safer-direction error for a "watch
your context" indicator.

### Event-driven freshness — `src/quota-broadcast.ts` + `src/client.ts`

The footer used to lag one turn behind the actual session-tokens
state. Reason: `broadcastResponseRateLimits` fires when response
headers arrive (BEFORE `message_start`), and that's the only signal
the live-area scheduler uses to refresh the footer. The
`message_start` event (where `addSessionUsage` runs) arrives after,
and there was no second signal to re-paint.

Fix: `rebroadcastQuotaForSessionUpdate()` re-emits the
`quota.headersReceived` event using the already-cached rate-limits
(cheap, no API call). `client.ts` calls it right after
`addSessionUsage(usage)` inside the `message_start` handler. Footer
updates within milliseconds of every chat completion — and the
displayed token count reflects THIS turn, not the previous one.

## Files touched

| File | Change |
|---|---|
| `src/session-tokens.ts` | Add `contextSize` field with replace-not-accumulate semantics. Old fields warned-about in docstrings. |
| `src/session-tokens.test.ts` | New tests pin the replace contract, the zero-state, and the output-exclusion. |
| `src/quota-broadcast.ts` | Add `rebroadcastQuotaForSessionUpdate()` helper. |
| `src/quota-broadcast.test.ts` | New test file: 7 cases covering broadcast + rebroadcast + the empty-cache no-op. |
| `src/client.ts` | Call `rebroadcastQuotaForSessionUpdate()` inside `message_start` after `addSessionUsage(usage)`. |
| `tui-plugins/quota-status/handler.ts` | `resolveContextWindow()` from `MINIMAL_AGENT_MODEL` env. Pass `contextWindow` to renderer. |
| `tui-plugins/quota-status/render.ts` | Bar-aware `renderSessionSegment`, always-on render, new `withSessionBar` degradation axis, new `contextWindow` opt. |
| `tui-plugins/quota-status/render.test.ts` | Expanded from 15 → 22 tests: always-on contract, 0-state empty bar, color-graded session bar, 1M-window math, overflow clamping, new degradation order. |

## Tests added

- **session-tokens.test.ts**: `contextSize REPLACES on each turn` (the
  key fix); `contextSize excludes output`; zero-state preservation in
  `clearSessionTokens`.
- **quota-broadcast.test.ts**: `rebroadcast emits the same payload`,
  no-op when cache empty, no-op when cache has 0 entries, payload is
  read-only.
- **quota-status/render.test.ts**: `ALWAYS shows the session block —
  even when contextSize is 0`; `honors contextWindow opt`; `clamps the
  session bar % at 100`; `color-grades the session bar`; `drops the
  session bar but keeps ✦ N ctx at medium widths`.

Final result: **34 pass / 0 fail** across the three plugin-relevant
test files. Full suite: **1941 pass / 0 fail / 5 skip**.

## Multi-agent shared-worktree incident (lesson for memory)

This change shipped across three commits because of a race in the
shared worktree:

1. **`a1625c7`** (mine) — landed the quota-status fix correctly, but
   accidentally rolled back the unrelated `9527504` commit due to a
   timing race in the private-index pattern (memory `#mp0sf575-bee2`).
   `read-tree HEAD` captured tree T1; a peer agent committed `9527504`
   between then and my `git commit`; the new HEAD was T2 but my tree
   was still T1, so the commit appeared to "delete" the 5 files added
   in `9527504`.

2. **`65653c0`** (peer) — added `src/quota-broadcast.test.ts` on top of
   `a1625c7`. Didn't restore the lost work.

3. **`6c2292f`** (mine, repair) — installs `9527504`'s blobs back into
   HEAD via `git update-index --cacheinfo` and `git commit-tree` +
   `git update-ref` with old-SHA validation. The latter is bulletproof
   against the race that bit `a1625c7`: if HEAD moves between sha
   capture and ref update, `update-ref` fails loudly and forces a
   retry, instead of producing a silent mass-deletion commit.

**Lesson** (committed to memory as a follow-up to `#mp0sf575-bee2`):
the private-index pattern is NOT a magic bullet in shared worktrees.
Mitigations going forward:

1. Use `git commit-tree` + `git update-ref` with old-SHA validation
   instead of `git commit` when you've prepared a private index. The
   ref update fails loudly on race instead of producing a wrong tree.
2. Verify `git diff $BEFORE_HEAD HEAD --stat` immediately after the
   operation. Any unexpected file deletion is a race signal — recover
   before continuing.
3. Make the `read-tree → write-tree → commit` window as short as
   possible. No intervening test runs, no shell-pause prompts, no
   long-running tools.

## Verification

Visual smoke check (run inside a tmux session):

```
$ tmux new-session -d -s qsmoke -x 120 -y 30 'COLUMNS=120 bun run scripts/quota-footer-demo.ts'
$ tmux capture-pane -t qsmoke -p | grep '✦'
```

A demo script at `scripts/quota-footer-demo.ts` paints the footer at
four contextSize levels (0, light, loaded, hot) for visual
confirmation that the bar reads correctly across the color grades.

Anthropic rate-limit cross-check (the truth source) remains visible
after each response in the rate-limit summary line; if the footer ever
diverges from those numbers by more than an order of magnitude again,
that's a regression signal.
