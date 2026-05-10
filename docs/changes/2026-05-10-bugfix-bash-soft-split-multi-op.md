# Bash header soft-split fires for multi-operator pipelines regardless of width

**Date:** 2026-05-10
**Type:** bugfix
**Status:** landed
**Author:** Claude Code (Opus 4.7)

## Problem

User report:

> fix the multiple line split TUI rendering in Bash that is not working
> here for the `&&` and `|`
>
> ```
>   ╭ » Bash  $ cd /Users/gaston/Projects/inditex/work/inditex-supplier-management && cat Makefile 2>/dev/null | head -80
>   │
> ```
>
> nor here:
>
> ```
>   ╭ » Bash  $ cd /Users/gaston/Projects/inditex/work/inditex-supplier-management/api && npm run lint 2>&1 | tail -120
>   │
> ```

Both commands have two top-level operators (`&&`, `|`). The expected
rendering — already implemented for overflow cases since the May 2026
soft-split work — is one segment per row:

```
  ╭ » Bash  $ cd /Users/gaston/Projects/inditex/work/inditex-supplier-management
  │ ↳ && cat Makefile 2>/dev/null
  │ ↳ | head -80
  │
  ╰ <output>
```

Observed: the entire pipeline stayed on the header row with no `↳`
continuation rows.

## Root cause

`shouldSoftSplit` in `src/bash-split.ts` was a pure width predicate:

```ts
export function shouldSoftSplit(cmd, cols, headerPrefixCells = 14): boolean {
  if (cmd.length === 0) return false
  return displayWidth(cmd) + headerPrefixCells > cols
}
```

The user's two commands are **~119 cells** of total visual width
(105-char body + 14-cell `  ╭ » Bash  $ ` prefix). They fit inline at
any iTerm window of 119 cells or wider — a typical default-size iTerm
session. At those widths the predicate (correctly per its old contract)
returns `false`, so neither `formatToolInput` (header) nor
`formatToolInputContinuation` (continuation rows) engaged the
splitter.

The user explicitly asked for the visual structure of `&&` / `|`
operators to be preserved at any width — not only when the line would
hard-wrap. The width-only rule was leaving multi-operator pipelines
visually flat.

## Options considered

### Option A — Lower the overflow threshold (margin-based)

Add a fixed-cell margin: split when `cmd_width + prefix > cols - 10`,
say. Reserve a few cells of breathing room.

- **Pro:** trivial diff, single number.
- **Con:** still width-dependent. A 105-cell pipeline at a 200-cell
  iTerm window (consuming 50% of the terminal) would not split. The
  user wanted these specific shapes split at any width, not just "near
  overflow." Margin-based fixes the symptom narrowly, not the principle.
  Rejected.

### Option B — Always split on any operator (1+ rest segments)

Engage the splitter whenever `splitBashSegments(cmd).rest.length >= 1`.

- **Pro:** maximally aggressive, no width concerns.
- **Con:** turns every `ls | wc -l` (10 chars, single operator) into
  three rows in the transcript. Empirically over-eager — short pipelines
  read fine on one row, and the visual block balloons. Rejected.

### Option C — Width-relative threshold (split when ≥ 60% of cols)

Combine: split if `cmd_width + prefix >= cols * 0.6` AND has operators.

- **Pro:** scales with terminal width.
- **Con:** non-orthogonal — couples width to operator count via a
  magic ratio. Hard to reason about: "why does this 60-char pipeline
  split at cols=100 but not at cols=110?" Discards the user's primary
  signal (operator structure) in favor of a derived one (width
  fraction). Rejected.

### Option D — Operator-count threshold (chosen)

Add a second activation rule: split if there are at least 2 top-level
operators (3+ segments), independent of width. Single-operator commands
still gate on overflow.

- **Pro:** orthogonal — width and structure are two independent rules
  that compose. Honors the user's stated intent ("split on `&&` and
  `|`"). Empirically: both user-reported commands have exactly 2
  operators; `ls | wc -l` has 1. The threshold of 2 is the natural
  separator between "structured pipeline" and "trivial composition."
- **Con:** new constant to defend (`MULTI_OP_SOFT_SPLIT_MIN`). A
  multi-operator command at very wide terminals (300+ cells) splits
  even when there's room — but that's the user's stated preference.

Chosen.

## Design

### Predicate (post-fix)

```ts
// src/bash-split.ts
export const MULTI_OP_SOFT_SPLIT_MIN = 2

export function shouldSoftSplit(cmd, cols, headerPrefixCells = 14): boolean {
  if (cmd.length === 0) return false
  // Non-finite cols ⇒ width unknown (non-TTY caller). Refuse to split
  // so tests and piped-output callers keep stable single-line headers.
  if (!Number.isFinite(cols)) return false
  // Tier 1 — width overflow. Splits prevent mid-token hard-wrap.
  if (displayWidth(cmd) + headerPrefixCells > cols) return true
  // Tier 2 — structured pipeline. 2+ top-level operators benefit from
  // visual separation regardless of width.
  const { rest } = splitBashSegments(cmd)
  return rest.length >= MULTI_OP_SOFT_SPLIT_MIN
}
```

### Why the non-finite-cols sentinel matters

The renderer in `src/agent.ts` resolves cols as:

```ts
const effectiveCols = cols ?? process.stdout.columns ?? Number.POSITIVE_INFINITY
```

Three callers hit the `Infinity` branch:

1. **`bun test`.** stdout is not a TTY; `process.stdout.columns ===
   undefined`. Without the sentinel, the new multi-op rule would fire
   in tests (since `Infinity > everything` is false but `rest.length
   >= 2` is the second-tier check), flipping ~5 existing tests that
   pass `"a && b | c"` and expect a single-line header.
2. **Piped stdout.** `minimal-agent --prompt … | tee log.txt`. Same
   issue — splits would unexpectedly appear in pipelines.
3. **Programmatic invocations** of `formatToolInput` from tools
   that don't know the live width (uncommon, but possible).

Treating non-finite cols as "don't split" preserves all three paths
unchanged.

### Why width-overflow stays as Tier 1

If a command both overflows AND has 2+ operators, we want the same
visual outcome (split). Putting the cheap width check first (no
allocation, no tokenizer pass) short-circuits before parsing for the
most common case (long pipelines on narrow terminals). The
`splitBashSegments` call only runs when the width check fails AND the
caller passed a finite cols.

### What `MULTI_OP_SOFT_SPLIT_MIN = 2` includes / excludes

| Command shape                                 | Top-level ops | Splits at any width? |
|-----------------------------------------------|--------------:|----------------------|
| `ls`                                          | 0             | No                   |
| `ls \| wc -l`                                 | 1             | No (overflow only)   |
| `cd /tmp && ls`                               | 1             | No (overflow only)   |
| `cmd1; cmd2`                                  | 1             | No (overflow only)   |
| `cd /a && cat /b \| head`                     | 2             | **Yes**              |
| `setup && build && test`                      | 2             | **Yes**              |
| `find . \| xargs grep foo \| wc -l`           | 2             | **Yes**              |
| `echo "a && b && c"` (quote-protected)        | 0             | No                   |
| `echo $(date \| tr A-Z a-z) && ls`            | 1 (subshell `\|` is not top-level) | No (overflow only) |

Quote / subshell awareness comes for free from `splitBashSegments`,
which already tracks `quote: '"' \| "'" \| "\`"` state and `depth` for
`$(…)` / `${…}` / `(…)`.

## Tests added

### `src/bash-split.test.ts` — `shouldSoftSplit — multi-operator pipeline rule` (7 cases)

1. 2+ operator pipeline splits at cols ∈ {130, 200, 400} (regression
   guard for the user's first reported command).
2. Single-operator pipelines that fit do NOT split (`ls | wc -l`,
   `cd /tmp && ls`, `cmd1 ; cmd2`).
3. 2+ operators split even when body is short (`cd /tmp && ls | wc`
   at cols=80).
4. Quote-protected operators do NOT split (`echo "a && b && c"`).
5. Subshell-internal operators do NOT split (`echo $(date | tr A-Z a-z)`
   at cols=80).
6. Non-finite cols sentinel returns false (`Infinity`, `NaN`).
7. Multi-op rule does not regress overflow detection (long single-op
   pipeline at narrow width still splits).

### `src/agent-tool-render.test.ts` — `formatToolInput / formatToolInputContinuation — 2+ operator split at wide cols` (10 cases)

- Both user-reported commands at cols ∈ {120, 140, 160, 200} render as:
  - Header: `$ cd /Users/gaston/Projects/inditex/work/inditex-supplier-management[/api]`
  - Continuation: `["↳ && <…>", "↳ | <…>"]`
- Single-operator pipelines stay inline at cols=200 (`ls | wc -l` →
  `$ ls | wc -l`, no continuation rows).
- Non-TTY callers (no cols arg, no TTY): single-line headers preserved
  (regression guard for the existing tests at lines ~674/720).

All 165 tests across `src/bash-split.test.ts`,
`src/agent-tool-render.test.ts`, `src/agent.test.ts` pass.

## tmux smoke verification

Driver: `tmp/bash-soft-split-tmux-driver.ts` (existing, not modified).
Re-ran at cols=100 — no regression to existing 5 cases.

Ad-hoc driver at cols ∈ {130, 160, 200} confirmed both user commands
now render with the expected `↳ &&` / `↳ |` rows; single-operator
controls (`ls | wc -l`, `cd /tmp && ls`) correctly stay inline.

## Out of scope / future work

- **No CLI flag.** The soft-split is a fully automatic rendering rule
  with no user-facing knob. Adding `--no-bash-split` or
  `--bash-split-min-ops=N` was considered and rejected: the rule has a
  single right answer per command shape, and exposing it as a flag
  invites bikeshedding without clear use cases.
- **`--help` not updated** — same reasoning. The transcript renderer's
  internal heuristics aren't documented in `--help` (cf. tool icons,
  truncation budget, status spinner blink frame, etc.); they're
  internal UX surface.
- **Single-operator splitting** stays gated on width-overflow.
  Empirical data (project memory + smoke tests) shows 1-op pipelines
  are short and read fine inline. Re-evaluate if user reports a
  specific 1-op case that benefits from split-by-default.
- **`COLUMNS` env fallback** for the rendering layer (mirroring
  `Compositor.effectiveColumns` for `script(1)` users) is a separate
  concern and was not bundled into this fix.

## File inventory

### Modified

- `src/bash-split.ts` — added `MULTI_OP_SOFT_SPLIT_MIN = 2` export and
  rewrote `shouldSoftSplit` body to add the non-finite-cols sentinel
  and the multi-operator second tier. Updated docstrings on both.
- `src/bash-split.test.ts` — imported `MULTI_OP_SOFT_SPLIT_MIN`; added
  `describe("shouldSoftSplit — multi-operator pipeline rule", …)` with
  7 cases.
- `src/agent-tool-render.test.ts` — added `describe("formatToolInput
  / formatToolInputContinuation — 2+ operator split at wide cols",
  …)` with 10 cases (both user-reported commands × 4 widths + 2
  negative regressions).
- `docs/CHANGELOG.md` — entry under `[Unreleased] > ### Fixed` linking
  to this change doc.

### Created

- `docs/changes/2026-05-10-bugfix-bash-soft-split-multi-op.md` — this
  document.

### Not modified (and why)

- `src/agent.ts` (`formatToolInput`, `formatToolInputContinuation`) —
  no change needed. Both already call `shouldSoftSplit` as their gate
  and behave correctly under the updated predicate. The split rendering
  (lead → header, rest → `↳`-prefixed rows) was already correct; only
  the gate was too restrictive.
- `src/session-replay.ts` — same. Inherits the new behavior via its
  existing `formatToolInput(tu, replayCols)` /
  `formatToolInputContinuation(tu, replayCols)` calls.
- `tmp/bash-soft-split-tmux-driver.ts` — existing smoke driver; its 5
  cases all still pass post-fix without changes.
- `src/index.ts:printHelp` — out of scope. No new CLI flag.
