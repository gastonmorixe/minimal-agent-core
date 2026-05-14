/**
 * Pure renderer for the quota-status footer line.
 *
 * Visual (term width permitting):
 *
 *   5h █▌░░░░░░ 21% 4h32m    7d ░░░░░░░░ 8% 6d11h    1M ▎░░░░░░░ 24% 232.4k
 *
 * Design rules (A2 layout — May 2026):
 *   - No leading "quota" word — the bar is the visual cue.
 *   - 8-cell bar with fractional fill (1/8th eighth-block ramp) for sub-cell
 *     precision.
 *   - Bar fill colour-graded by severity (green <60%, yellow 60-84%, red ≥85%).
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
 *     context window (e.g. `1M` / `200k`), dim-white parallel to
 *     `5h`/`7d`. The bar shows `contextSize / contextWindow`. The
 *     trailing meta is the live count: bold when contextSize > 0
 *     ("this is your current usage"), dim when 0 (pre-traffic shape
 *     stays quiet, parallel to `5h`/`7d`). The `✦` sparkle that
 *     previously sat in the label slot was retired: no semantic content,
 *     and its sky-blue paint clashed with the dim quota labels. The
 *     `<n>/<window>` fraction form was retired in this pass — the
 *     trailing-count shape is structurally identical to a quota
 *     segment (label + bar + pct + meta) and reads more cleanly.
 *     The cumulative-sum approach (pre-May 2026) over-counted cached
 *     prefixes by ~N× since the same prefix is re-read every turn;
 *     `contextSize` is the latest-turn value, not a sum.
 *   - Session block ALWAYS renders when `showSession` is on, even at 0 tokens.
 *     Pre-traffic users see `200k ░░░░░░░░ 0% 0` — the bar acts as a
 *     "this is your context budget" signpost from the very first paint.
 *   - 4-space group separator between distinct segments.
 *   - "overage" hidden by default (set MINIMAL_AGENT_QUOTA_OVERAGE=1 to surface).
 *   - Responsive degradation: drop tail segments when the result would overflow `cols`.
 *
 * Pure: no I/O, no env reads, no `Date.now()` except via the injectable `now()`.
 */

import { c } from "../../src/agent.ts"
import type { SessionTokens } from "../../src/session-tokens.ts"
import { displayWidth, stripAnsi } from "../../src/term-width.ts"

export interface RenderOpts {
  /** Terminal width in cells. When omitted, no responsive degradation. */
  cols?: number
  /** Surface the `overage off` segment when overage is disabled. Default: false. */
  showOverage?: boolean
  /** Render the session-tokens block on the right. Default: true. */
  showSession?: boolean
  /**
   * Model context window in tokens, for computing the session bar's
   * fill percentage (`contextSize / contextWindow`). Default 200_000 —
   * Anthropic's standard context limit. Pass 1_000_000 for `[1m]` models.
   */
  contextWindow?: number
  /** Clock injection for tests. Default: `Date.now`. */
  now?: () => number
}

const BAR_CELLS = 8
/** 1/8th-block ramp: index = number of eighths filled within one cell. */
const SLICES = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const
const EMPTY_CELL = "░"
const DEFAULT_CONTEXT_WINDOW = 200_000

function bar(pct: number): { full: string; empty: string } {
  const eighths = Math.max(
    0,
    Math.min(BAR_CELLS * 8, Math.round((pct / 100) * BAR_CELLS * 8)),
  )
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  return {
    full: "█".repeat(full) + (part ? SLICES[part]! : ""),
    empty: EMPTY_CELL.repeat(BAR_CELLS - full - (part ? 1 : 0)),
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

interface ParsedWindow {
  name: string
  util?: number
  reset?: number
}

function parseWindows(
  rl: ReadonlyMap<string, string>,
  showOverage: boolean,
): ParsedWindow[] {
  const wins = new Map<string, ParsedWindow>()
  for (const [k, v] of rl) {
    const mw = k.match(/^anthropic-ratelimit-unified-([\w]+)-(\w+)$/)
    if (!mw) continue
    const name = mw[1]!
    const field = mw[2]!
    if (name === "fallback" || name === "representative") continue
    if (!showOverage && name === "overage") continue
    if (!wins.has(name)) wins.set(name, { name })
    const w = wins.get(name)!
    if (field === "utilization") w.util = Number(v)
    else if (field === "reset") w.reset = Number(v) * 1000
  }
  const order = (n: string) => (n === "5h" ? 0 : n === "7d" ? 1 : 2)
  return [...wins.values()]
    .filter((w) => w.util != null)
    .sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name))
}

const colorBar = (pct: number) => (pct >= 85 ? c.red : pct >= 60 ? c.yellow : c.green)
const colorPctBold = (pct: number) =>
  pct >= 85 ? c.boldRed : pct >= 60 ? c.boldYellow : c.boldGreen

function renderWindowSegment(w: ParsedWindow, now: number, withReset: boolean): string {
  const pct = Math.round((w.util ?? 0) * 100)
  const { full, empty } = bar(pct)
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
  // The synthetic "overage" entry has no `util` so it can't reach this
  // segment renderer. Surfacing "overage off" lives in `overageTail` and is
  // appended by the top-level builder when `showOverage` is set.
  return s
}

/**
 * Build the session block.
 *
 * `withBar=true` →   `1M ▎░░░░░░░ 24% 232.4k`   (or `200k ... 47.5k`)
 * `withBar=false` →  `232.4k`
 *
 * Structurally identical to {@link renderWindowSegment}: same skeleton
 * `<label> <bar> <pct> <meta>`. Here label is the window MAX (dim, like
 * `5h`/`7d`), and the meta slot holds the live count instead of a reset
 * countdown. Count is bold when contextSize > 0, dim when 0 (parallel
 * to the quiet pre-traffic shape on the quota windows).
 *
 * The `✦` sparkle that previously sat in the label slot was retired — no
 * semantic content, and its sky-blue paint clashed with the dim labels
 * on `5h`/`7d`. The bar is the visual anchor; everything else is quiet.
 *
 * Percentage is `contextSize / contextWindow`, capped at 100 (overflows are
 * clamped — the renderer can't predict a model's hard error threshold).
 * Always renders, even at 0 tokens — the zero-state shows an empty bar at 0%,
 * which is informative on its own (≈ "you have a clean context budget").
 */
function renderSessionSegment(
  s: SessionTokens,
  contextWindow: number,
  withBar: boolean,
): string {
  const winStr = fmtTokens(contextWindow)
  const usedStr = fmtTokens(s.contextSize)
  // Live count pops at bold weight once contextSize > 0 ("this is your
  // current usage"); dims when 0 to keep the pre-traffic shape quiet.
  const used = s.contextSize > 0 ? c.bold(usedStr) : c.dim(usedStr)
  // Bar-dropped form: the window label alone, without the bar's
  // fraction reading, doesn't earn its space. Show only the count.
  if (!withBar) return used

  const pct = Math.max(
    0,
    Math.min(100, Math.round((s.contextSize / contextWindow) * 100)),
  )
  const { full, empty } = bar(pct)
  // Shape: <window> <bar> <pct> <used> — structurally identical to
  // the quota segments (label + bar + pct + dim trailing). Here label
  // is the window MAX and the meta is the live count. Same skeleton;
  // different content. (Concat over template literals is deliberate —
  // minimises Edit-tool backtick collisions on future tweaks; see
  // project memory.)
  return (
    c.faintWhite(winStr) +
    " " +
    colorBar(pct)(full) +
    c.dim(empty) +
    " " +
    colorPctBold(pct)(pct + "%") +
    " " +
    used
  )
}

function overageTail(rl: ReadonlyMap<string, string>): string | null {
  const ov = rl.get("anthropic-ratelimit-unified-overage-status")
  if (!ov || ov === "allowed") return null
  return `${c.faintWhite("overage")} ${c.red("off")}`
}

/**
 * Build the footer line. Returns `null` when there's nothing useful to show
 * (no quota windows AND session block disabled).
 *
 * When `cols` is provided, the renderer tries (in order) full → drop overage →
 * drop session bar → drop reset clauses → drop session entirely → drop 7d →
 * keep just the 5h bar. The first form that fits within `cols` wins.
 *
 * The session block is kept around even at 0 contextSize so users see their
 * context-window budget bar from the start. It drops only when terminal
 * width physically can't accommodate it.
 */
export function renderQuotaFooter(
  rl: ReadonlyMap<string, string>,
  session: SessionTokens,
  opts: RenderOpts = {},
): string | null {
  const now = (opts.now ?? Date.now)()
  const showOverage = opts.showOverage ?? false
  const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const windows = parseWindows(rl, showOverage)
  const showSession = opts.showSession ?? true
  const tail = showOverage ? overageTail(rl) : null

  if (windows.length === 0 && !showSession && !tail) return null

  const SEP = "    " // 4-space group separator

  interface BuildCfg {
    withReset: boolean
    withSession: boolean
    withSessionBar: boolean
    withOverage: boolean
    maxWindows?: number
  }
  const build = (cfg: BuildCfg): string => {
    const segs: string[] = []
    const wins = cfg.maxWindows != null ? windows.slice(0, cfg.maxWindows) : windows
    for (const w of wins) segs.push(renderWindowSegment(w, now, cfg.withReset))
    if (cfg.withSession && showSession) {
      segs.push(renderSessionSegment(session, contextWindow, cfg.withSessionBar))
    }
    if (cfg.withOverage && tail) segs.push(tail)
    return segs.join(SEP)
  }

  const fits = (s: string): boolean =>
    opts.cols == null || displayWidth(stripAnsi(s)) <= opts.cols

  // Degradation ladder, richest → leanest. First fit wins.
  // Session block is kept as long as possible (per user UX request: always
  // show the context-budget signpost). The bar drops first, then reset
  // clauses, then the block itself, then the 7d window.
  const candidates: BuildCfg[] = [
    { withReset: true, withSession: true, withSessionBar: true, withOverage: true },
    { withReset: true, withSession: true, withSessionBar: true, withOverage: false },
    { withReset: true, withSession: true, withSessionBar: false, withOverage: false },
    { withReset: false, withSession: true, withSessionBar: false, withOverage: false },
    { withReset: false, withSession: false, withSessionBar: false, withOverage: false },
    {
      withReset: false,
      withSession: false,
      withSessionBar: false,
      withOverage: false,
      maxWindows: 1,
    },
  ]

  for (const cfg of candidates) {
    const s = build(cfg)
    if (fits(s)) return s
  }
  // Nothing fit (cols is comically narrow). Return the leanest form anyway —
  // the live area will clip, which beats going dark.
  return build({
    withReset: false,
    withSession: false,
    withSessionBar: false,
    withOverage: false,
    maxWindows: 1,
  })
}
