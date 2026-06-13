/**
 * Pure renderer for the quota-status footer line.
 *
 * Visual (term width permitting):
 *
 *   5h █▌░░░░░░ 21% 4h32m    7d ░░░░░░░░ 8% 6d11h    1M ▎░░░░░░░ 24% 232.4k    effort medium    b1d82846
 *
 * Design rules (A2 layout — May 2026):
 *   - No leading "quota" word — the bar is the visual cue.
 *   - 8-cell bar with fractional fill (1/8th eighth-block ramp) for sub-cell
 *     precision.
 *   - Bar fill colour-graded by severity (green under 60%, yellow 60-84%, red ≥85%).
 *   - **Window name is a LEFT label**, not a trailing word. Promotes the name
 *     from grammatically-a-duration (next to the reset countdown, which is
 *     itself a duration) to grammatically-a-title (anchoring the segment).
 *     Pre-A2 the trailing pair `<pct> <name> <reset>` (e.g. "88% 5h 14m")
 *     was ambiguous to the eye — `5h` and `14m` are visually identical.
 *   - Reset countdown follows the bar+pct as a dim trailing duration.
 *     No `·` separator — dim color + single-space gap is enough
 *     disambiguation, and it saves two cells per segment. No `↻` icon
 *     either (heavier than the values it joins).
 *   - Session block on the right: shares the same skeleton as a quota
 *     segment — `<label> <bar> <pct> <meta>`. The label is the model's
 *     context-window size formatted compactly (`200k`, `1M`, `500k`,
 *     etc.) — informative, parallel-in-role to the quota labels
 *     (`5h`/`7d`) that anchor each segment with what their bar
 *     represents. When the context window is **unknown** (no
 *     `MINIMAL_AGENT_MODEL` in env), the label falls back to a dim
 *     middle-dot `·` placeholder and the bar+percent drop (we can't
 *     compute fill without a denominator); the trailing count remains.
 *     The bar (when shown) renders `contextSize / contextWindow`. The
 *     trailing meta is the live count: bold when `contextSize > 0` ("this
 *     is your current usage"), dim when 0 (pre-traffic shape stays
 *     quiet, parallel to `5h`/`7d`). The cumulative-sum approach
 *     (pre-May 2026) over-counted cached prefixes by ~N× since the same
 *     prefix is re-read every turn; `contextSize` is the latest-turn
 *     value, not a sum.
 *   - Session block ALWAYS renders when `showSession` is on, even at 0 tokens.
 *     Pre-traffic users see `1M ░░░░░░░░ 0% 0` (or `· 0` if window is
 *     unknown) — a "this is your context budget" signpost from the
 *     very first paint.
 *   - 4-space group separator between distinct segments.
 *   - "overage" hidden by default (set MINIMAL_AGENT_QUOTA_OVERAGE=1 to surface).
 *   - Trailing `effort <level>` segment (faintWhite label, bold value): the
 *     reasoning effort being sent on the wire. No bar — effort is categorical
 *     (low/medium/high/max), not continuous. No colour-grading either; the
 *     green/yellow/red palette belongs to severity and would read
 *     "high effort == bad". Suppressed entirely when the caller passes no
 *     effort (haiku models don't accept the wire field).
 *   - Absolute-trailing bare-hex session-id anchor (dim, no label). Renders
 *     verbatim — the caller pre-shortens to whatever prefix length disambiguates
 *     inside `~/.minimal-agent/sessions/` (the quota-status handler takes 8
 *     hex chars). Bare (no `sid` label) because the 8-hex pattern is visually
 *     distinct enough at line-end and dropping the label saves 4 cells. Dim
 *     because it's static reference, not a live reading. Lives at the
 *     absolute end so terminal double/triple-click selects it cleanly.
 *   - Responsive degradation: drop tail segments when the result would overflow `cols`.
 *
 * Pure: no I/O, no env reads, no `Date.now()` except via the injectable `now()`.
 */

import { c } from "../../src/agent.ts"
import type { QuotaWindow } from "../../src/llm/provider-plugin.ts"
import type { SessionTokens } from "../../src/session-tokens.ts"
import { displayWidth, stripAnsi } from "../../src/term-width.ts"

/**
 * The user-configurable status-bar segments, in render order.
 *
 *   - `quota`   : the provider's plan/rate-limit windows (5h, 7d, …).
 *   - `context` : the session context-usage bar (`contextSize / contextWindow`).
 *   - `model`   : the `<provider-model>:<effort>` (or `effort <level>`) tag.
 *   - `sid`     : the short session-id anchor.
 *
 * Order + membership are declarative (user config `statusBar.segments`).
 * Capability-aware: a segment with no data (e.g. `quota` for a provider with
 * no quota concept, or `model` when no effort is sent) renders nothing even
 * when listed.
 */
export type StatusSegmentId = "quota" | "context" | "model" | "sid"

/** Default order: `<quota> <context> <model:effort> <sid>`. */
export const DEFAULT_SEGMENT_ORDER: readonly StatusSegmentId[] = [
  "quota",
  "context",
  "model",
  "sid",
]

const VALID_SEGMENTS: ReadonlySet<string> = new Set(DEFAULT_SEGMENT_ORDER)

/**
 * Resolve the effective ordered segment list from a (possibly user-supplied)
 * list: keep only known ids, drop duplicates, and fall back to the default
 * when nothing valid remains. Lenient by design — a typo'd config never blanks
 * the footer.
 */
export function normalizeSegmentOrder(segments?: readonly string[]): StatusSegmentId[] {
  if (!segments || segments.length === 0) return [...DEFAULT_SEGMENT_ORDER]
  const seen = new Set<string>()
  const out: StatusSegmentId[] = []
  for (const s of segments) {
    if (VALID_SEGMENTS.has(s) && !seen.has(s)) {
      seen.add(s)
      out.push(s as StatusSegmentId)
    }
  }
  return out.length > 0 ? out : [...DEFAULT_SEGMENT_ORDER]
}

export interface RenderOpts {
  /** Terminal width in cells. When omitted, no responsive degradation. */
  cols?: number
  /**
   * Ordered, filtered status-bar segments (typically straight from user
   * config, so `string[]` rather than the narrowed id type). Omit for the
   * default order ({@link DEFAULT_SEGMENT_ORDER}). Unknown ids are dropped;
   * an empty/all-invalid list falls back to the default (never blanks the
   * footer).
   */
  segments?: readonly string[]
  /** Surface the `overage off` segment when overage is disabled. Default: false. */
  showOverage?: boolean
  /**
   * Provider-neutral overage state (from `QuotaSnapshot.overage`). When
   * `showOverage` is on and `active === false`, the renderer appends a
   * dim `overage off` tail to the quota group. Only "off" surfaces — an
   * active/engaged overage is silent. Absent ⇒ no overage readout.
   */
  overage?: { active: boolean }
  /** Render the session-tokens block on the right. Default: true. */
  showSession?: boolean
  /**
   * Model context window in tokens, for computing the session bar's
   * fill percentage (`contextSize / contextWindow`) AND for rendering
   * the segment's LEFT label (`200k`, `1M`, `500k`, …).
   *
   * When omitted/undefined, the renderer treats the window as unknown:
   * the label falls back to a dim middle-dot `·` placeholder and the
   * bar+percent drop (we can't compute fill without a denominator).
   * The trailing token count still renders. Callers should pass the
   * resolved value whenever the model is known (the agent's handler
   * resolves it from `MINIMAL_AGENT_MODEL`).
   */
  contextWindow?: number
  /**
   * Reasoning-effort level being sent on the wire
   * (`output_config.effort`). Renders as a trailing segment:
   * `effort <level>` — faintWhite label, bold value. No bar (effort
   * is categorical, not continuous). Pass-through: whatever string is
   * here gets shown verbatim, mirroring the no-validate philosophy of
   * `src/effort-resolution.ts`.
   *
   * Omit (or pass empty) to suppress the segment entirely — that's the
   * haiku case, where the wire field isn't sent and the footer would
   * lie if it showed an effort.
   */
  effort?: string
  /**
   * Compact provider-model tag (e.g. `anth-4.8`, `oai-5.5`) from
   * `modelShortLabel()`. When present, the effort segment's full form
   * renders `<tag>:<level>` (bold tag + faint level), replacing the
   * literal `effort` label. Compressed forms drop the tag. Omit to keep
   * the legacy `effort <level>` rendering.
   */
  modelLabel?: string
  /**
   * Pre-shortened session-id anchor (e.g. the first 8 hex chars of a
   * UUIDv4) for line-end visual reference. Rendered verbatim, dim, no
   * label, no separator from the rest beyond the standard 4-space
   * group gap. Caller chooses the truncation length — the renderer
   * does not slice.
   *
   * Omit (or pass empty) to suppress.
   */
  sid?: string
  /**
   * What to do when even the leanest compressed candidate would exceed
   * `cols`. Rule 3 hard invariant: the footer must NEVER overflow a
   * single terminal line by default.
   *
   * - `"truncate"` (default): clip the result to `cols - 1` and append
   *   a dim ellipsis. Should never fire in practice — the compression
   *   ladder bottoms out at a tiny single-window line — but stands as
   *   the last-resort floor against any future bug.
   *
   * - `"wrap"`: opt-out for users who prefer overflow over clipping.
   *   The renderer skips the cols guard entirely and returns the
   *   richest still-fitting form (or, if nothing fits, the leanest
   *   compressed form unclipped). The terminal natural-wraps the
   *   excess onto subsequent rows; the live-area height grows to
   *   accommodate, same mechanism as multi-slot footers.
   *
   * Set per-process via `MINIMAL_AGENT_QUOTA_OVERFLOW=wrap`.
   */
  overflow?: "truncate" | "wrap"
  /** Clock injection for tests. Default: `Date.now`. */
  now?: () => number
}

/** Default + maximum bar width in cells. Used for comfort layouts. */
const BAR_CELLS_MAX = 8
/**
 * Minimum bar width the compressor will shrink to (Rule 2.1.1). Below
 * this the bar loses too much precision to communicate fill — at 3
 * cells the 1/8th ramp resolves to ~12.5% steps PER CELL, and tiny
 * percent values disappear entirely. Four cells keeps the ramp
 * meaningfully readable at the cost of half the visual real estate.
 */
const BAR_CELLS_MIN = 4
/** 1/8th-block ramp: index = number of eighths filled within one cell. */
const SLICES = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const
const EMPTY_CELL = "░"

/**
 * Render a percent as a fixed-cell bar.
 *
 * The 1/8th-block ramp is the resolution unit; `cells` controls the
 * horizontal stride. At `cells=8` (default) you get the original
 * 1.5%-per-eighth precision; at `cells=4` (min) you get ~3% per
 * eighth — still smooth, half the cells.
 *
 * Always returns exactly `cells` cells of glyphs (`full + empty`).
 * Caller is responsible for colour-wrapping `full` / `empty`
 * separately so the empty cells stay dim.
 */
function bar(pct: number, cells: number = BAR_CELLS_MAX): { full: string; empty: string } {
  const eighths = Math.max(0, Math.min(cells * 8, Math.round((pct / 100) * cells * 8)))
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  return {
    full: "█".repeat(full) + (part ? SLICES[part]! : ""),
    empty: EMPTY_CELL.repeat(cells - full - (part ? 1 : 0)),
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(n)
}

function humanReset(resetMs: number, now: number): string | null {
  const ms = resetMs - now
  if (ms <= 0) return null
  const min = Math.floor(ms / 60_000)
  const d = Math.floor(min / (60 * 24))
  const h = Math.floor((min % (60 * 24)) / 60)
  const m = min % 60
  if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

/**
 * Internal render shape for one quota window — a 1:1 mapping from the
 * provider-neutral {@link QuotaWindow} DTO. No header parsing happens in
 * this plugin: provider wire knowledge lives in the provider plugins
 * (see `src/architecture.provider-decoupling.test.ts`).
 */
interface ParsedWindow {
  name: string
  util?: number
  reset?: number
}

const colorBar = (pct: number) => (pct >= 85 ? c.red : pct >= 60 ? c.yellow : c.green)
const colorPctBold = (pct: number) =>
  pct >= 85 ? c.boldRed : pct >= 60 ? c.boldYellow : c.boldGreen

function renderWindowSegment(
  w: ParsedWindow,
  now: number,
  withReset: boolean,
  barCells: number = BAR_CELLS_MAX,
): string {
  const pct = Math.round((w.util ?? 0) * 100)
  const { full, empty } = bar(pct, barCells)
  // Layout: `<name> <bar> <pct> <reset>`.
  // The window name is a LEFT label (grammatically a title) — distinct
  // visual role from the trailing reset countdown (grammatically a
  // duration). Pre-A2 the two sat side-by-side at the right ("88% 5h 14m")
  // and were indistinguishable to the eye since both look like durations.
  // Promoting `name` to the front fixes that without extra ink. No `·`
  // separator before the reset: dim color + single-space gap is enough.
  let s = `${c.faintWhite(w.name)} ${colorBar(pct)(full)}${c.dim(empty)} ${colorPctBold(pct)(`${pct}%`)}`
  if (withReset && w.reset) {
    const human = humanReset(w.reset, now)
    if (human) s += ` ${c.dim(human)}`
  }
  // Overage is not a window (no utilization), so it never reaches this
  // segment renderer. Surfacing "overage off" lives in `overageTailNeutral`
  // and is appended by the top-level builder when `showOverage` is set.
  return s
}

/**
 * Build the session block.
 *
 * Known window, `withBar=true`  → `1M ▎░░░░░░░ 24% 232.4k`
 * Known window, `withBar=false` → `232.4k`
 * Unknown window (any withBar)  → `· 232.4k`
 *
 * Structurally identical to {@link renderWindowSegment}: same skeleton
 * `<label> <bar> <pct> <meta>`. Here the label is the model's context
 * window formatted compactly (`200k`, `1M`, `500k`, …) — informative,
 * parallel in role to `5h`/`7d` (each segment's label says what the
 * bar represents). The meta slot holds the live count instead of a
 * reset countdown. Count is bold when `contextSize > 0`, dim when 0
 * (parallel to the quiet pre-traffic shape on the quota windows).
 *
 * When `contextWindow` is undefined the renderer falls back to a dim
 * middle-dot `·` placeholder for the label, drops the bar+percent
 * (no denominator → no fill), and shows only the trailing count. In
 * normal production the agent always knows the window from
 * `MINIMAL_AGENT_MODEL`; this branch covers dev/test runs and the
 * brief startup window before the model is resolved.
 *
 * Earlier iterations used `✦` (sparkle, sky-blue — clashed with the
 * dim quota labels) and a dim middle-dot as the unconditional label
 * (lost the magnitude signal — users couldn't see at a glance whether
 * they were on a 200k or 1M model). Hoisting the size to the label
 * keeps the % math implicit and the segment self-documenting.
 *
 * Percentage is `contextSize / contextWindow`, capped at 100 (overflows
 * are clamped — the renderer can't predict a model's hard error
 * threshold). Always renders when `showSession` is on, even at 0
 * tokens — the zero-state shows an empty bar at 0%, which is
 * informative on its own (≈ "you have a clean context budget").
 */
function renderSessionSegment(
  s: SessionTokens,
  contextWindow: number | undefined,
  withBar: boolean,
  barCells: number = BAR_CELLS_MAX,
): string {
  const usedStr = fmtTokens(s.contextSize)
  // Live count pops at bold weight once contextSize > 0 ("this is your
  // current usage"); dims when 0 to keep the pre-traffic shape quiet.
  const used = s.contextSize > 0 ? c.bold(usedStr) : c.dim(usedStr)

  // Unknown context window → dim middle-dot placeholder + count only.
  // No bar (no denominator), no percent (same reason). The dot keeps
  // the segment visually anchored so it doesn't look like an orphan
  // number trailing the quota windows.
  if (contextWindow == null || !(contextWindow > 0)) {
    return c.dim("·") + " " + used
  }

  // Bar-dropped form (responsive degradation): the size label alone
  // doesn't earn its space without the bar+pct context. Show only the count.
  if (!withBar) return used

  const pct = Math.max(0, Math.min(100, Math.round((s.contextSize / contextWindow) * 100)))
  const { full, empty } = bar(pct, barCells)
  // Shape: <size> <bar> <pct> <used> — structurally identical to the
  // quota segments (label + bar + pct + dim trailing). The size label
  // uses the same faintWhite tint as `5h`/`7d` so the three sit on
  // the same visual tier. (Concat over template literals is deliberate
  // — minimises Edit-tool backtick collisions on future tweaks; see
  // project memory.)
  return (
    c.faintWhite(fmtTokens(contextWindow)) +
    " " +
    colorBar(pct)(full) +
    c.dim(empty) +
    " " +
    colorPctBold(pct)(pct + "%") +
    " " +
    used
  )
}

/**
 * Overage tail (faintWhite label + red value), driven by the provider's
 * neutral `overage` DTO. Surfaces `overage off` only when overage is
 * reported AND inactive (`active === false`). Active/engaged overage is
 * silent — only the "off" state is worth a readout.
 */
function overageTailNeutral(overage: { active: boolean } | undefined): string | null {
  if (!overage || overage.active !== false) return null
  return `${c.faintWhite("overage")} ${c.red("off")}`
}

/**
 * Effort segment compression format (Rule 2.1.2).
 *
 * - `"full"`  → `<faintWhite "effort"> <bold value>`  (e.g. `effort medium`)
 * - `"value"` → `<bold value>`                        (e.g. `medium`)
 * - `"short"` → `<bold shortValue>`                   (e.g. `med`)
 *
 * The label drops first because "effort" is the most redundant cell-cost
 * (it tells you what the next word is — useful at first glance, but the
 * value alone carries the same information for a returning user). Then
 * the value abbreviates as a last resort.
 */
export type EffortFmt = "full" | "value" | "short"

/**
 * Abbreviation table for the known effort levels (Rule 2.1.2 short form).
 *
 * Pass-through philosophy mirrors `src/effort-resolution.ts`: unknown
 * levels (server-side additions like `"ultra"`, `"insane"`) fall back
 * to a `slice(0, 3)` so the renderer stays forward-compatible without a
 * release.
 *
 * `low` and `max` are already 3 chars so they don't shorten further.
 * `medium` → `med`, `high` → `hi` (the canonical 2-letter abbrev; `hgh`
 * reads strangely and `hig` is no shorter than `hi`).
 */
function shortenEffort(level: string): string {
  if (level === "medium") return "med"
  if (level === "high") return "hi"
  // Known levels already 3 chars or less (`low`, `max`); unknown
  // levels get truncated to first 3 chars as the forward-compat
  // fallback.
  return level.length <= 3 ? level : level.slice(0, 3)
}

/**
 * Build the trailing effort segment in one of three formats (Rule 2.1.2).
 *
 * No colour-grading on the value: green/yellow/red are already taken by
 * the quota severity bars (red == "burning through your budget"), and
 * carrying that palette over here would read "high effort == bad".
 * Plain bold keeps the value legible without semantic collision.
 *
 * Returns `null` when `level` is empty/undefined so the caller can skip
 * appending the segment (haiku case, or unresolved state).
 */
function renderEffortSegment(
  level: string | undefined,
  fmt: EffortFmt = "full",
  modelLabel?: string,
): string | null {
  if (!level) return null
  if (fmt === "full") {
    // With a provider-model tag the segment reads e.g. "anth-4.8:max"
    // (bold/bright tag, faint ":level") — the tag replaces the literal
    // "effort" label. Without one, keep the legacy "effort <level>".
    if (modelLabel) return c.bold(modelLabel) + c.dim(`:${level}`)
    return c.faintWhite("effort") + " " + c.bold(level)
  }
  if (fmt === "value") return c.bold(level)
  return c.bold(shortenEffort(level))
}

/**
 * Build the trailing session-id anchor.
 *
 * Bare dim hex — no label, no separator beyond the standard 4-space
 * group gap the top-level builder will add. The 8-char hex pattern is
 * visually distinct enough on its own that a `sid` word would be
 * redundant decoration (and would cost 4 cells the rest of the line
 * could use). Dim because it never changes mid-session — it's a
 * reference for forensics, not a live reading.
 *
 * Pre-shortened by the caller; this function does NOT slice. The
 * quota-status handler takes the first 8 hex chars of the UUIDv4
 * before passing through.
 */
function renderSidSegment(sid: string | undefined): string | null {
  if (!sid) return null
  return c.dim(sid)
}

/**
 * Comfort-comfortable separator gap between groups (Rule 2 ceiling).
 * Below this we tighten progressively to {@link SEP_MIN} (Rule 1 floor).
 */
const SEP_MAX = 4
/** Hard floor for inter-segment separation (Rule 1). */
const SEP_MIN = 2

/**
 * Clip an ANSI-coloured string to at most `maxWidth` cells, preserving
 * SGR sequences. Walks the source char-by-char, accumulating display
 * width, and stops as soon as another printable code point would push
 * us past the budget. SGR escapes (`\x1b[...m`) are emitted verbatim
 * regardless of width — they contribute 0 cells anyway.
 *
 * This is the last-resort floor for Rule 3: the compression ladder
 * should never NEED truncation, but if it does (future bug, exotic
 * terminal width, unicode trickery) we clip rather than overflow.
 * The dim `…` ellipsis the caller appends is the visual cue that
 * truncation happened.
 *
 * Approximate width (matches `term-width.ts`): all printable code
 * points cost 1 cell. Wide East-Asian / emoji content costs 2 cells,
 * but the quota footer renders only ASCII + box-drawing + the
 * eighth-block ramp, all 1-cell. The approximation is exact for this
 * renderer.
 */
function clipToWidth(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  let out = ""
  let used = 0
  let i = 0
  const ESC = "\x1b"
  while (i < s.length) {
    const ch = s.charCodeAt(i)
    if (ch === 0x1b && s[i + 1] === "[") {
      // Walk the CSI escape: ESC '[' [params...] [final byte in @-~].
      // Emit it verbatim and continue without counting cells.
      let j = i + 2
      while (j < s.length) {
        const cc = s.charCodeAt(j)
        if (cc >= 0x40 && cc <= 0x7e) {
          j += 1
          break
        }
        j += 1
      }
      out += s.slice(i, j)
      i = j
      continue
    }
    // One char = one cell (approximation, see fn docstring).
    if (used + 1 > maxWidth) break
    out += s[i]
    used += 1
    i += 1
    // Preserve the ESC char if it somehow appears outside a CSI (rare).
    if (s[i - 1] === ESC && s[i] !== "[") {
      // Emit anyway; treat as 0-width control like the term-width helpers do.
    }
  }
  return out
}

/**
 * Build the footer line. Returns `null` when there's nothing useful to show
 * (no quota windows AND session block disabled).
 *
 * Compression behaviour (Rules 1, 2, 2.1.x, 3):
 *
 *   1. Separator scales {@link SEP_MAX} → {@link SEP_MIN} cells.
 *   2. Effort segment compresses `effort medium` → `medium` → `med`.
 *   3. Opt-in overage drops first (if shown), then sid (forensics
 *      anchor, recoverable from log files).
 *   4. Bars shrink {@link BAR_CELLS_MAX} → {@link BAR_CELLS_MIN} cells.
 *   5. Tail segments drop in order: effort → session bar → reset
 *      clauses → session entirely → 7d window. The 5h window is the
 *      irreducible last-stand.
 *   6. If even the leanest candidate would overflow `cols` (should
 *      never happen — but a safety net beats overflow), the renderer
 *      clips with a dim `…` ellipsis (Rule 3 floor). Opt-out via
 *      `overflow: "wrap"` for users who prefer multi-line overflow.
 *
 * The session block is kept around even at 0 contextSize so users see their
 * context-window budget bar from the start. It drops only when terminal
 * width physically can't accommodate it.
 */
export function renderQuotaFooter(
  input: QuotaWindow[],
  session: SessionTokens,
  opts: RenderOpts = {},
): string | null {
  const now = (opts.now ?? Date.now)()
  const showOverage = opts.showOverage ?? false
  // No default — passing `undefined` is the renderer's "unknown
  // context window" signal (label falls back to `·`, bar+pct drop).
  // The agent's handler always resolves a real value from the provider's
  // session info; this `undefined` path is for dev/test callers and the
  // brief pre-model-resolution startup window.
  const contextWindow = opts.contextWindow
  // Provider-neutral input only: a `QuotaWindow[]` from the provider
  // session seam. Mapping to the internal render shape is 1:1 — no wire
  // parsing happens here.
  const windows: ParsedWindow[] = input.map((w) => ({
    name: w.id,
    util: w.utilization,
    reset: w.resetAtMs,
  }))
  const showSession = opts.showSession ?? true
  // Overage tail rides with the `quota` group, driven by the provider's
  // neutral `overage` DTO.
  const tail = !showOverage ? null : overageTailNeutral(opts.overage)
  const order = normalizeSegmentOrder(opts.segments)

  if (windows.length === 0 && !showSession && !tail && !opts.effort && !opts.sid) return null

  const overflowMode = opts.overflow ?? "truncate"

  interface BuildCfg {
    /** Cells of padding between groups; bounded [SEP_MIN, SEP_MAX]. */
    sep: number
    /** Bar width in cells; bounded [BAR_CELLS_MIN, BAR_CELLS_MAX]. */
    barCells: number
    /** Effort compression level (full / value / short). */
    effortFmt: EffortFmt
    withReset: boolean
    withSession: boolean
    withSessionBar: boolean
    withOverage: boolean
    withEffort: boolean
    withSid: boolean
    /** When set, only the first `maxWindows` quota windows render. */
    maxWindows?: number
  }
  // Segment renderers keyed by id. The compression ladder still toggles the
  // `cfg.with*` flags per segment KIND; only the ORDER comes from `order`.
  // The overage tail (power-user opt-in) rides with the `quota` group.
  const renderSegment = (id: StatusSegmentId, cfg: BuildCfg): string[] => {
    switch (id) {
      case "quota": {
        const out: string[] = []
        const wins = cfg.maxWindows != null ? windows.slice(0, cfg.maxWindows) : windows
        for (const w of wins) out.push(renderWindowSegment(w, now, cfg.withReset, cfg.barCells))
        if (cfg.withOverage && tail) out.push(tail)
        return out
      }
      case "context":
        return cfg.withSession && showSession
          ? [renderSessionSegment(session, contextWindow, cfg.withSessionBar, cfg.barCells)]
          : []
      case "model": {
        // Informative but static-per-session: compresses `full → value →
        // short` and drops before the session block in the ladder.
        if (!cfg.withEffort || !opts.effort) return []
        const seg = renderEffortSegment(opts.effort, cfg.effortFmt, opts.modelLabel)
        return seg ? [seg] : []
      }
      case "sid": {
        // Forensics anchor: drops early in the ladder (recoverable from logs).
        if (!cfg.withSid || !opts.sid) return []
        const seg = renderSidSegment(opts.sid)
        return seg ? [seg] : []
      }
      default:
        // `id` is exhaustively typed; this guards a future segment id added
        // to the type but not yet handled here (render nothing rather than crash).
        return []
    }
  }

  const build = (cfg: BuildCfg): string => {
    const segs: string[] = []
    for (const id of order) segs.push(...renderSegment(id, cfg))
    return segs.join(" ".repeat(cfg.sep))
  }

  const widthOf = (s: string): number => displayWidth(stripAnsi(s))
  const fits = (s: string): boolean => opts.cols == null || widthOf(s) <= opts.cols

  /**
   * Compression ladder, rich → lean. Each row is one strict step in a
   * single direction (separator tighten OR effort compress OR drop OR
   * bar shrink). Walked top-to-bottom; first row whose `build()` fits
   * wins.
   *
   * Order rationale:
   *   1. Tighten separators 4 → 3 → 2 (free, no information loss).
   *   2. Drop overage (opt-in noise, rare).
   *   3. Shorten effort to value-only ("medium").
   *   4. Drop sid (forensics anchor, recoverable from log files).
   *   5. Shorten effort to 3-char ("med").
   *   6. Shrink bars 8 → 7 → 6 → 5 → 4 cells (precision loss but no
   *      information loss; quota+session bars shrink together to keep
   *      the visual tier coherent).
   *   7. Drop effort entirely.
   *   8. Drop session bar (keep trailing live count).
   *   9. Drop reset clauses.
   *  10. Drop session block entirely.
   *  11. Drop 7d window (keep 5h irreducible).
   */
  const baseRich: BuildCfg = {
    sep: SEP_MAX,
    barCells: BAR_CELLS_MAX,
    effortFmt: "full",
    withReset: true,
    withSession: true,
    withSessionBar: true,
    withOverage: true,
    withEffort: true,
    withSid: true,
  }
  const candidates: BuildCfg[] = [
    baseRich,
    { ...baseRich, sep: 3 },
    { ...baseRich, sep: SEP_MIN },
    { ...baseRich, sep: SEP_MIN, withOverage: false },
    { ...baseRich, sep: SEP_MIN, withOverage: false, effortFmt: "value" },
    { ...baseRich, sep: SEP_MIN, withOverage: false, effortFmt: "value", withSid: false },
    { ...baseRich, sep: SEP_MIN, withOverage: false, effortFmt: "short", withSid: false },
    {
      ...baseRich,
      sep: SEP_MIN,
      withOverage: false,
      effortFmt: "short",
      withSid: false,
      barCells: 7,
    },
    {
      ...baseRich,
      sep: SEP_MIN,
      withOverage: false,
      effortFmt: "short",
      withSid: false,
      barCells: 6,
    },
    {
      ...baseRich,
      sep: SEP_MIN,
      withOverage: false,
      effortFmt: "short",
      withSid: false,
      barCells: 5,
    },
    {
      ...baseRich,
      sep: SEP_MIN,
      withOverage: false,
      effortFmt: "short",
      withSid: false,
      barCells: BAR_CELLS_MIN,
    },
    {
      ...baseRich,
      sep: SEP_MIN,
      withOverage: false,
      effortFmt: "short",
      withSid: false,
      barCells: BAR_CELLS_MIN,
      withEffort: false,
    },
    {
      ...baseRich,
      sep: SEP_MIN,
      withOverage: false,
      effortFmt: "short",
      withSid: false,
      barCells: BAR_CELLS_MIN,
      withEffort: false,
      withSessionBar: false,
    },
    {
      ...baseRich,
      sep: SEP_MIN,
      withOverage: false,
      effortFmt: "short",
      withSid: false,
      barCells: BAR_CELLS_MIN,
      withEffort: false,
      withSessionBar: false,
      withReset: false,
    },
    {
      ...baseRich,
      sep: SEP_MIN,
      withOverage: false,
      effortFmt: "short",
      withSid: false,
      barCells: BAR_CELLS_MIN,
      withEffort: false,
      withSessionBar: false,
      withReset: false,
      withSession: false,
    },
    {
      ...baseRich,
      sep: SEP_MIN,
      withOverage: false,
      effortFmt: "short",
      withSid: false,
      barCells: BAR_CELLS_MIN,
      withEffort: false,
      withSessionBar: false,
      withReset: false,
      withSession: false,
      maxWindows: 1,
    },
  ]

  // Wrap mode: skip the cols guard during selection. Return the
  // richest candidate (the renderer's job is no longer to "fit" — the
  // terminal will wrap the excess). When `cols` is undefined we
  // already do this implicitly, so wrap mode just makes the behaviour
  // explicit and opt-in via env config.
  if (overflowMode === "wrap") return build(baseRich)

  // Default truncate mode: walk the ladder, first fit wins.
  for (const cfg of candidates) {
    const s = build(cfg)
    if (fits(s)) return s
  }

  // === Rule 3 hard floor ===
  //
  // None of the candidates fit. This should be unreachable in
  // practice — the leanest candidate is a single 5h window at bar=4,
  // sep=2, which is ~15 cells; any terminal narrower than that has
  // bigger problems than the quota footer. Still: rather than emit a
  // line that wraps and pushes the prompt up by a row (the bug Rule 3
  // exists to prevent), we clip with a dim ellipsis as the visible
  // signal that something went wrong.
  const leanest = candidates[candidates.length - 1]!
  const overflow = build(leanest)
  if (opts.cols == null) return overflow
  const budget = Math.max(0, opts.cols - 1) // reserve one cell for the ellipsis
  return clipToWidth(overflow, budget) + c.dim("…")
}
