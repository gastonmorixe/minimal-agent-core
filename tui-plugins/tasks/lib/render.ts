/**
 * Renderer for the Tasks plugin.
 *
 * Produces both full framed blocks for the CLI and split host-frame
 * parts for the in-agent `Task` tool transcript.
 *
 * Output shape (framed):
 *
 *     ╭ ○ Tasks · ✔ marked done #d04c91 · 3/9
 *     │
 *     │    1  ✔  #a7b3c4   Add contextSize to SessionTokens
 *     │    2  ✔  #f8e21a   Update addSessionUsage callers
 *     │    3  ◐  #d04c91   Update src/session-tokens.test.ts
 *     │       ├  ✔  #d04c91a  Zero-state includes contextSize
 *     │       ├  ◐  #d04c91b  Replace-not-accumulate semantics
 *     │       ╰  ○  #d04c91c  Multi-turn growth pinned
 *     │    4  ○  #b18f73   ...
 *     │    5  ✘  #4dcff2   Wire contextSize into footer  (user pivoted)
 *     │
 *     ╰  3 done · 1 doing · 5 todo
 *
 * Header is action-specific:
 *  - `marked done`  (verb=done)   → `✔ marked done #<id>`           (LIME ✔)
 *  - `started`      (verb=start)  → `◐ started #<id>`                (SKY)
 *  - `marked doing` (verb=status) → `◐ marked doing #<id>`           (SKY)
 *  - `canceled`     (verb=status) → `✘ canceled #<id>`               (RED)
 *  - `added`        (verb=add)    → `+ added` / `+ added N tasks`    (LIME)
 *  - `updated`      (verb=update) → `updated #<id>` + diff in row    (SKY)
 *  - `all_done`     (auto)        → `✔ ALL DONE`                    (LIME)
 *  - empty list / list verb       → ` 5 tasks` or `no tasks`
 *
 * "ALL DONE" celebration:
 *
 * When `stats.doing === 0 && stats.todo === 0 && stats.done > 0`, ANY
 * action's header is suffixed with ` · ✦ ALL DONE` (LIME+BOLD), and the
 * closer leads with the same tag while dropping the `0 doing` / `0 todo`
 * zero-counts. So a `marked done` that completes the last task with
 * canceled tasks in the mix renders as:
 *
 *     ╭ ○ Tasks · ✔ marked done #af9d93 · ✦ ALL DONE · 10/12
 *     │   ...
 *     ╰  ✦ ALL DONE · 10 done · 2 canceled
 *
 * @module tasks/lib/render
 */

import type { Stats, View } from "./store.ts"
import { localIsoDateTime, type Task, type TaskStatus } from "./parse.ts"

// ---------------------------------------------------------------------------
// Glyphs (pure unicode, no nerd-font, no emoji)
// ---------------------------------------------------------------------------

export const GLYPHS = {
  pending: "○", // U+25CB
  doing: "◐", // U+25D0
  done: "✔", // U+2714
  canceled: "✘", // U+2718
  frameTL: "╭",
  frameML: "│",
  frameBL: "╰",
  treeMid: "├",
  treeLast: "╰",
  bullet: "·",
  plus: "+",
  // Celebration glyph for the "ALL DONE" tag. Chosen over `★` because
  // it's visually distinct from the `✔` done check while still reading
  // as a small celebratory spark. NO EMOJI in this codebase — `✦` is
  // in the Dingbats block (U+2726) and renders as monochrome text,
  // unlike e.g. U+2728 (SPARKLES) which terminals upgrade to a color
  // emoji glyph.
  sparkle: "✦", // U+2726
} as const

// ---------------------------------------------------------------------------
// ANSI palette
// ---------------------------------------------------------------------------

const ANSI = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  STRIKE: "\x1b[9m",
  LIME: "\x1b[38;5;118m",
  /**
   * The agent's accent blue (palette token `sky`, 256-color 45). Used
   * for the "doing" status — "in focus / actively being worked on"
   * reads naturally as accent, and pairs better than gold against the
   * lime-green `✔` for "done" (gold-and-lime were too close on the
   * yellow-green axis). The constant was previously named `GOLD` and
   * carried code 214 (orange) — the docstring matched the design intent
   * but the value was stale. Renamed to `SKY` so future readers don't
   * trip over the same divergence.
   */
  SKY: "\x1b[38;5;45m",
  RED: "\x1b[31m",
  DGRAY: "\x1b[38;5;240m",
  LGRAY: "\x1b[38;5;246m",
} as const

/** Wrap `text` in ANSI codes when `ansi` is true; identity otherwise. */
function color(ansi: boolean, codes: string, text: string): string {
  if (!ansi) return text
  return `${codes}${text}${ANSI.RESET}`
}

// ---------------------------------------------------------------------------
// Render options + action verbs
// ---------------------------------------------------------------------------

/**
 * The action just performed, surfaced in the header. Most actions
 * reference a specific task id (`hash`); a few (`add_many`, `all_done`,
 * `list`, `clear`) don't.
 */
export type RenderAction =
  | { kind: "added"; hash: string }
  | { kind: "added_many"; count: number }
  | { kind: "started"; hash: string }
  | { kind: "marked_done"; hash: string }
  | { kind: "marked_doing"; hash: string }
  | { kind: "marked_todo"; hash: string }
  | { kind: "marked_canceled"; hash: string }
  | { kind: "updated"; hash: string }
  | { kind: "removed"; hash: string }
  | { kind: "reordered" }
  | { kind: "cleared"; count: number }
  | { kind: "all_done" }
  | { kind: "list" }

export interface RenderOptions {
  /** Whether to emit ANSI color codes. */
  ansi: boolean
  /** The action that just occurred (drives the header verb). */
  action: RenderAction
  /** Optional cap on title length per row; longer titles are ellipsis-truncated. */
  maxTitleLen?: number
  /**
   * Time source for duration-rendering. Defaults to `Date.now()` (epoch
   * ms). Tests inject a fixed epoch so the live-elapsed math for `doing`
   * rows is deterministic. The same value is fed BOTH to {@link
   * localIsoDateTime} for the header date suffix AND to the `active_ms +
   * (now − last_resumed_at)` math on doing rows.
   */
  now?: () => number
}

// ---------------------------------------------------------------------------
// Duration formatting + per-task active-time math (schema v2)
// ---------------------------------------------------------------------------

/**
 * Format an elapsed milliseconds count for a row duration suffix.
 *
 *  - `< 1000ms`           → `""` (no flicker / noise for fast ops)
 *  - `< 60_000ms`         → `"42s"`
 *  - `< 3_600_000ms`      → `"4m 22s"`
 *  - `< 86_400_000ms`     → `"1h 04m"` (seconds dropped past the hour)
 *  - `>= 86_400_000ms`    → `"1d 03h"` (defensive — unlikely in practice)
 *
 * Returned value is the BARE token. The renderer appends it to the END
 * of the row (after the title), so no padding is needed : rows with no
 * duration simply omit the suffix entirely and the title is the last
 * thing on the line. Exported for tests.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return ""
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remS = s % 60
  if (m < 60) return `${m}m ${pad2(remS)}s`
  const h = Math.floor(m / 60)
  const remM = m % 60
  if (h < 24) return `${h}h ${pad2(remM)}m`
  const d = Math.floor(h / 24)
  const remH = h % 24
  return `${d}d ${pad2(remH)}h`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Compute the milliseconds spent in `doing` for ONE task, including the
 * in-flight chunk if the task is currently `doing` (live elapsed).
 *
 * For a `done`, `canceled`, or `todo` task, this returns the persisted
 * `active_ms`. For a `doing` task with a valid `last_resumed_at`, it
 * adds `now − Date.parse(last_resumed_at)` so the column shows the
 * current elapsed time at the moment of render.
 */
export function taskActiveMs(t: Task, nowEpochMs: number): number {
  if (t.status !== "doing") return t.active_ms
  if (t.last_resumed_at === null) return t.active_ms
  const resumedMs = Date.parse(t.last_resumed_at)
  if (!Number.isFinite(resumedMs) || nowEpochMs < resumedMs) return t.active_ms
  return t.active_ms + (nowEpochMs - resumedMs)
}

/**
 * Compute the duration text for a TOP-LEVEL row, which is the task's
 * own active_ms PLUS the sum of its subtasks' active_ms (each computed
 * live). Subtasks running in parallel inside one parent are SUMMED (no
 * wall-clock clamp): if the user genuinely had two children running
 * concurrently, the parent line shows the work-equivalent, which reads
 * more faithfully than the wall-clock span on a busy phase.
 */
function topLevelTotalMs(v: View, allTasks: readonly Task[], nowEpochMs: number): number {
  let total = taskActiveMs(v.task, nowEpochMs)
  for (const child of allTasks) {
    if (child.parent === v.task.id) total += taskActiveMs(child, nowEpochMs)
  }
  return total
}

/**
 * Wall-clock total for the CLOSER line: earliest `started_at` across
 * all tasks → latest `done_at` across all tasks (or `now` when the
 * list is still mid-flight). Returns `0` when no task has ever been
 * started.
 *
 * This is intentionally NOT a sum-of-active-ms (which would double-count
 * parallel work). The closer should read like "this task list took 12
 * minutes from start to finish", which is wall-clock by definition.
 */
export function listTotalElapsedMs(tasks: readonly Task[], nowEpochMs: number): number {
  let earliestStart: number | null = null
  let latestEnd: number | null = null
  let anyDoing = false
  for (const t of tasks) {
    if (t.started_at !== null) {
      const startMs = Date.parse(t.started_at)
      if (Number.isFinite(startMs)) {
        if (earliestStart === null || startMs < earliestStart) earliestStart = startMs
      }
    }
    if (t.status === "doing") anyDoing = true
    if (t.done_at !== null) {
      const endMs = Date.parse(t.done_at)
      if (Number.isFinite(endMs)) {
        if (latestEnd === null || endMs > latestEnd) latestEnd = endMs
      }
    }
  }
  if (earliestStart === null) return 0
  // If anything is still doing, the upper bound is now. Otherwise use
  // the latest done_at (the moment the list "finished"). When neither
  // applies (e.g. tasks started but all canceled with no done_at), fall
  // back to now for an honest mid-flight reading.
  const upper = anyDoing ? nowEpochMs : latestEnd ?? nowEpochMs
  if (upper < earliestStart) return 0
  return upper - earliestStart
}

// ---------------------------------------------------------------------------
// Per-status glyph + ANSI styling
// ---------------------------------------------------------------------------

function statusGlyph(status: TaskStatus, ansi: boolean, ghost?: "removed"): string {
  // Ghost overrides status — a just-removed task gets the red ✘ regardless
  // of what its status was at the moment of deletion. The visual cue is
  // "this is gone", not "this is canceled".
  if (ghost === "removed") {
    return color(ansi, `${ANSI.RED}${ANSI.BOLD}`, GLYPHS.canceled)
  }
  switch (status) {
    case "done":
      return color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.done)
    case "doing":
      return color(ansi, ANSI.SKY, GLYPHS.doing)
    case "todo":
      return color(ansi, ANSI.DIM, GLYPHS.pending)
    case "canceled":
      return color(ansi, `${ANSI.RED}${ANSI.BOLD}`, GLYPHS.canceled)
    default: {
      // TaskStatus is a closed union; this default exists only to satisfy
      // `consistent-return` and acts as an exhaustiveness check at the
      // type level (the `never` cast errors if a new variant is added
      // without a case above).
      const _exhaustive: never = status
      throw new Error(`unhandled status: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Style the title per status, with optional `ghost` / `diff` overlays.
 *
 * Color identity is consistent with the status icon: the row reads as
 * one coherent gesture across icon + title + (where applicable) reason,
 * instead of "colored icon + neutral title".
 *
 *  - ghost="removed"           → red + strikethrough (diff/status ignored)
 *  - diff={oldTitle}           → `<old red+strike>  →  <new sky+bold>`
 *                                The "new" half is always SKY+BOLD (the
 *                                update action's identity color), never
 *                                inheriting per-status styling — so a
 *                                rename of a done task still reads as
 *                                "this is the new value".
 *  - status=done               → dim + strikethrough
 *  - status=doing              → SKY + bold  (matches the `◐` icon)
 *  - status=todo               → plain
 *  - status=canceled           → red + strikethrough; appended faint-red
 *                                strikethrough ` (reason)` if present
 *                                (matches the `✘` icon's red identity)
 */
function styleTitle(
  t: Task,
  ansi: boolean,
  maxLen?: number,
  ghost?: "removed",
  diff?: { oldTitle: string },
  targeted = false,
): string {
  const title = truncate(singleLineText(t.title), maxLen)
  // 1. Ghost wins — a just-removed row is a tombstone. Status, diff, and
  //    reason are all irrelevant for the visual. When the removal
  //    targeted THIS row, add BOLD so the tombstone reads as "this is
  //    the one I just removed".
  if (ghost === "removed") {
    return color(
      ansi,
      targeted ? `${ANSI.RED}${ANSI.BOLD}${ANSI.STRIKE}` : `${ANSI.RED}${ANSI.STRIKE}`,
      title,
    )
  }
  // 2. Diff overlay — render `<old red+strike>  →  <new sky+bold>`.
  //    The "update" action's identity color is SKY (the same blue used
  //    for the `◐` doing glyph in `started` / `marked_doing` headers),
  //    so the NEW half always paints SKY+BOLD regardless of the task's
  //    current status. The OLD half is always RED+STRIKE — symmetric
  //    "deletion red / addition blue" diff semantics. Earlier behavior
  //    inherited per-status styling for the new half, which made the
  //    new title render white-bold for `doing` tasks and made the diff
  //    look like it had no action color.
  if (diff !== undefined) {
    const oldT = truncate(singleLineText(diff.oldTitle), maxLen)
    const oldCol = color(ansi, `${ANSI.RED}${ANSI.STRIKE}`, oldT)
    const arrow = color(ansi, ANSI.DIM, "  →  ")
    const newCol = color(ansi, `${ANSI.SKY}${ANSI.BOLD}`, title)
    return `${oldCol}${arrow}${newCol}`
  }
  // 3. Plain status styling.
  if (t.status === "canceled") {
    const body = styleTitleByStatus(t, title, ansi, targeted)
    const reasonText = t.reason ? singleLineText(t.reason) : ""
    // Faint-red parenthetical (`RED + DIM + STRIKE`) — visually softer
    // than the title's plain RED+STRIKE so the eye reads the title
    // first and the reason second, while still keeping the whole row
    // inside the "canceled = red" color family. NOTE: the reason
    // intentionally does NOT pick up BOLD when targeted — the title
    // and number column carry the emphasis, the reason stays quiet
    // so the targeted-row signal doesn't drown out its own metadata.
    const reason = reasonText
      ? `  ${color(ansi, `${ANSI.RED}${ANSI.DIM}${ANSI.STRIKE}`, `(${reasonText})`)}`
      : ""
    return `${body}${reason}`
  }
  return styleTitleByStatus(t, title, ansi, targeted)
}

/**
 * Apply per-status text styling to an already-truncated title string.
 *
 * When `targeted` is true (the row matches the action's hash), the
 * status's normal styling is escalated: DIM is replaced with the
 * status's identity color, and BOLD is added. So a `marked done` on
 * a row turns its title from DIM+STRIKE (the usual "this is finished
 * and faded out" look) into LIME+BOLD+STRIKE (still struck, but now
 * popping in lime to say "this is the one that just got marked").
 */
function styleTitleByStatus(t: Task, title: string, ansi: boolean, targeted = false): string {
  switch (t.status) {
    case "done":
      return color(
        ansi,
        targeted
          ? `${ANSI.LIME}${ANSI.BOLD}${ANSI.STRIKE}`
          : `${ANSI.DIM}${ANSI.STRIKE}`,
        title,
      )
    case "doing":
      // SKY+BOLD so the title pulls the same blue identity as the `◐`
      // glyph in the status column — "in flight" reads as one coherent
      // blue gesture across icon and label, instead of "blue icon +
      // white-bold title" which fragmented the visual into two cues.
      // Targeted doing rows are visually identical to non-targeted
      // doing rows here (already maxed-out: SKY+BOLD); the distinction
      // comes from the brighter `idCol` in the row renderer instead.
      return color(ansi, `${ANSI.SKY}${ANSI.BOLD}`, title)
    case "todo":
      // Plain → BOLD when targeted. Pops the just-added task out of
      // the rest of the todo list.
      return targeted ? color(ansi, ANSI.BOLD, title) : title
    case "canceled":
      // Match the row's red `✘` icon — title is also red+strike so the
      // whole row reads as one "canceled" gesture instead of "red icon
      // + dim white title" (which made the title look done, not gone).
      return color(
        ansi,
        targeted
          ? `${ANSI.RED}${ANSI.BOLD}${ANSI.STRIKE}`
          : `${ANSI.RED}${ANSI.STRIKE}`,
        title,
      )
    default: {
      // Exhaustiveness check; see the matching default in `statusGlyph`.
      const _exhaustive: never = t.status
      throw new Error(`unhandled status: ${String(_exhaustive)}`)
    }
  }
}

function singleLineText(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim()
}

function truncate(s: string, max?: number): string {
  if (max === undefined) return s
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// Header rendering
// ---------------------------------------------------------------------------

/**
 * Compose the trailing date-and-time chrome appended to every task block
 * header: `" · YYYY-MM-DD HH:MM:SS"`. Dim throughout — the same visual
 * weight as the other separators so it reads as chrome, not content.
 *
 * The plugin owns this entirely because the tasks plugin sets
 * `suppressToolTime: true` on its tool result; the agent skips its own
 * `· HH:MM:SS` suffix when that flag is set, so there's no duplication.
 * See `TUIResult.suppressToolTime` in `src/plugins/types.ts`.
 */
function renderHeaderDateSuffix(ansi: boolean, nowEpochMs: number): string {
  const text = localIsoDateTime(() => new Date(nowEpochMs))
  const dot = color(ansi, ANSI.DIM, GLYPHS.bullet)
  return ` ${dot} ${color(ansi, ANSI.DIM, text)}`
}

function renderHeaderText(
  action: RenderAction,
  stats: Stats,
  ansi: boolean,
  nowEpochMs: number,
): string {
  const dot = color(ansi, ANSI.DIM, GLYPHS.bullet)

  // Common N/M trailer. The leading ` ${dot} ` separates the action verb
  // from the stats (e.g. `+ added 7 tasks · 0/7`); when stats are empty
  // (zero-total) the separator goes with it.
  const trail = stats.total === 0
    ? ""
    : ` ${dot} ${color(ansi, ANSI.BOLD, String(stats.done))}${color(ansi, ANSI.DIM, `/${stats.total}`)}`

  // The plugin owns the "header content" slot only — agent chrome
  // (`╭ [icon] [label]  …`) is drawn around this string. Don't lead with
  // a separator; the agent has already put a two-space gap after the
  // label.
  let middle = ""
  switch (action.kind) {
    case "added":
      middle = `${color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.plus)} ${color(ansi, ANSI.LIME, "added")} ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "added_many":
      middle = `${color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.plus)} ${color(ansi, ANSI.LIME, `added ${action.count} tasks`)}`
      break
    case "started":
      // Word + icon both SKY so the header reads as one blue "started"
      // gesture, matching the `marked_canceled` precedent (RED icon +
      // RED word + dgray hash) and the row's SKY+BOLD title for the
      // same task.
      middle = `${color(ansi, ANSI.SKY, GLYPHS.doing)} ${color(ansi, ANSI.SKY, "started")} ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "marked_done":
      middle = `${color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.done)} marked done ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "marked_doing":
      // Symmetric to `started` — both transition a task into the doing
      // state, both deserve SKY identity on the verb.
      middle = `${color(ansi, ANSI.SKY, GLYPHS.doing)} ${color(ansi, ANSI.SKY, "marked doing")} ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "marked_todo":
      middle = `${color(ansi, ANSI.DIM, GLYPHS.pending)} reset to todo ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "marked_canceled":
      // Word "canceled" is RED (no dim) so the action's identity color
      // reads at-a-glance from the header just like `added` is LIME
      // and `marked done` carries the lime `✔`. Icon stays RED+DIM
      // (softer than a row's RED+BOLD `✘`) so the header's verb glyph
      // doesn't compete with the row icons below.
      middle = `${color(ansi, `${ANSI.RED}${ANSI.DIM}`, GLYPHS.canceled)} ${color(ansi, ANSI.RED, "canceled")} ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "updated":
      middle = `updated ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "removed":
      middle = `${color(ansi, `${ANSI.RED}${ANSI.DIM}`, GLYPHS.canceled)} removed ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "reordered":
      middle = `reordered`
      break
    case "cleared":
      middle = `cleared ${color(ansi, ANSI.LGRAY, String(action.count))} tasks`
      break
    case "all_done":
      // Uppercase "ALL DONE" — the celebration is supposed to read as
      // a small shout. Stays in LIME (no bold on the word — the icon
      // carries the bold so the row doesn't feel SHOUTY-SHOUTY).
      middle = `${color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.done)} ${color(ansi, ANSI.LIME, "ALL DONE")}`
      break
    case "list":
      if (stats.total === 0) {
        middle = color(ansi, `${ANSI.DIM}\x1b[3m`, "no tasks")
      } else {
        middle = color(ansi, ANSI.LGRAY, `${stats.total} task${stats.total === 1 ? "" : "s"}`)
      }
      break
  }

  // "ALL DONE" celebration suffix — appended to ANY action's verb
  // section when the resulting state has nothing left to work on AND
  // at least one task got finished. Skipped for `all_done` itself
  // (that action's header is already `✔ ALL DONE`, double-celebration
  // would read as a stutter) and for the empty `list` (already says
  // "no tasks" or "N tasks", but with 0 done — won't satisfy isAllDone
  // anyway). Reads as `… · ✦ ALL DONE` and uses the same LIME+BOLD
  // identity as the closer's celebration prefix.
  if (action.kind !== "all_done" && isAllDone(stats)) {
    middle += ` ${dot} ${allDoneTag(ansi)}`
  }

  // For action kinds that don't reference a specific task, drop the
  // N/M trailer when it would be redundant with the verb (cleared, list,
  // all_done already convey the count). Keep it for mutating actions.
  let suffix = trail
  if (action.kind === "list" || action.kind === "cleared") suffix = ""
  if (action.kind === "all_done") {
    // Bold lime N/M for the satisfying "5/5" reveal.
    suffix = ` ${dot} ${color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, String(stats.done))}${color(ansi, ANSI.DIM, `/${stats.total}`)}`
  }

  // Trailing date-and-time chrome — emitted UNCONDITIONALLY at the end
  // of the header content, regardless of action kind. The plugin owns
  // this slot in full because the tool-frame chrome's auto-time-suffix
  // is suppressed (see `suppressToolTime` on the tool result).
  const dateSuffix = renderHeaderDateSuffix(ansi, nowEpochMs)
  return `${middle}${suffix}${dateSuffix}`
}

function renderHeader(
  action: RenderAction,
  stats: Stats,
  ansi: boolean,
  nowEpochMs: number,
): string {
  const frame = color(ansi, ANSI.DGRAY, GLYPHS.frameTL)
  // CLI-only brand prefix. The agent path uses `renderToolDisplay` (which
  // skips this wrapper) and gets its identity from the manifest's icon
  // and label in the host tool-frame chrome instead. Keeping the brand
  // local to this CLI wrapper avoids leaking a duplicate "Tasks" word
  // into the agent's transcript where it would sit next to "Task" from
  // the manifest.
  const brand = `${color(ansi, ANSI.DIM, GLYPHS.pending)} ${color(ansi, ANSI.BOLD, "Tasks")}`
  const content = renderHeaderText(action, stats, ansi, nowEpochMs)
  const sep = content.length === 0 ? "" : ` ${color(ansi, ANSI.DIM, GLYPHS.bullet)} `
  return `${frame} ${brand}${sep}${content}`
}

// ---------------------------------------------------------------------------
// Row rendering
// ---------------------------------------------------------------------------

/**
 * Number-column styling for one row. Extracted to keep both row body
 * functions (top-level + subtask) in lockstep on the targeted-emphasis
 * rules. `targeted` rows wear status-color + BOLD; non-targeted rows
 * fall back to the quieter per-status palette.
 */
function styleNumCol(v: View, ansi: boolean, targeted: boolean): string {
  const numStr = String(v.n).padStart(2, " ")
  if (v.ghost === "removed") {
    // Tombstone — preserve DIM+STRIKE even when targeted; BOLD on a
    // removed row's number col would look like "still alive".
    return color(ansi, `${ANSI.DIM}${ANSI.STRIKE}`, numStr)
  }
  // Single switch with `targeted` selecting between the two palettes.
  // Collapsing the prior two-switch form also closes a latent
  // fall-through bug: a `targeted` row with a hypothetical new status
  // variant would have silently picked up the non-targeted palette
  // from the second switch instead of erroring at the exhaustive default.
  switch (v.task.status) {
    case "done":
      return targeted
        ? color(ansi, `${ANSI.LIME}${ANSI.BOLD}${ANSI.STRIKE}`, numStr)
        : color(ansi, ANSI.DIM, numStr)
    case "doing":
      return targeted
        ? color(ansi, `${ANSI.SKY}${ANSI.BOLD}`, numStr)
        : color(ansi, ANSI.BOLD, numStr)
    case "todo":
      return targeted ? color(ansi, ANSI.BOLD, numStr) : color(ansi, ANSI.LGRAY, numStr)
    case "canceled":
      return targeted
        ? color(ansi, `${ANSI.RED}${ANSI.BOLD}${ANSI.STRIKE}`, numStr)
        : color(ansi, `${ANSI.DIM}${ANSI.STRIKE}`, numStr)
    default: {
      // Closed-union exhaustiveness check; mirrors the pattern in
      // `statusGlyph` above. Adding a new TaskStatus variant will
      // trigger a type error here.
      const _exhaustive: never = v.task.status
      throw new Error(`unhandled status: ${String(_exhaustive)}`)
    }
  }
}

/**
 * ID-column styling for one row. Targeted rows boost DGRAY → LGRAY+BOLD
 * (or DGRAY+BOLD+STRIKE for canceled/ghost) so the hash is the most
 * visible secondary signal that "this is the row referenced in the
 * header". Especially important for status=doing where the title is
 * already SKY+BOLD whether targeted or not — the id column becomes the
 * primary "this one" cue.
 */
function styleIdCol(v: View, ansi: boolean, targeted: boolean): string {
  const t = v.task
  const idStruck = v.ghost === "removed" || t.status === "canceled"
  if (idStruck) {
    return color(
      ansi,
      targeted ? `${ANSI.DGRAY}${ANSI.BOLD}${ANSI.STRIKE}` : `${ANSI.DGRAY}${ANSI.STRIKE}`,
      `#${t.id}`,
    )
  }
  return color(
    ansi,
    targeted ? `${ANSI.LGRAY}${ANSI.BOLD}` : ANSI.DGRAY,
    `#${t.id}`,
  )
}

/**
 * Render the trailing duration suffix for one row.
 *
 * Returns either an empty string (no duration to show) or a 2-space
 * gap followed by the styled duration token. The renderer appends this
 * to the END of the row, after the title. No column padding : a row
 * without a duration ends cleanly at the title, no trailing whitespace
 * to copy/paste-mangle.
 *
 *  - todo / ghost-removed / 0ms       → `""` (suffix omitted entirely)
 *  - doing                            → sky+bold, ticking live each render
 *  - done                             → LGRAY (one notch above dim;
 *                                       reads as "informational chrome",
 *                                       not "actively important")
 *  - canceled                         → red+dim+strike (matches row family)
 */
function renderDurationSuffix(
  ms: number,
  status: TaskStatus,
  ansi: boolean,
  ghost?: "removed",
): string {
  const text = formatDuration(ms)
  if (text === "") return ""
  let styled: string
  if (ghost === "removed") {
    styled = color(ansi, `${ANSI.DGRAY}${ANSI.STRIKE}`, text)
  } else {
    switch (status) {
      case "doing":
        // Sky+bold matches the `◐` icon and the row's title color — the
        // whole "doing" row reads as one blue gesture, and the duration
        // is the token that ticks every render.
        styled = color(ansi, `${ANSI.SKY}${ANSI.BOLD}`, text)
        break
      case "done":
        // LGRAY (256-color 246) is one notch brighter than DIM — chosen
        // so the duration of completed tasks is readable but quiet,
        // letting the eye land on the title text first.
        styled = color(ansi, ANSI.LGRAY, text)
        break
      case "canceled":
        styled = color(ansi, `${ANSI.RED}${ANSI.DIM}${ANSI.STRIKE}`, text)
        break
      case "todo":
        // Defensive — a todo task shouldn't have non-zero active_ms in
        // practice (no transition has happened yet), but if it does
        // we paint it DIM so the row still reads as "not started".
        styled = color(ansi, ANSI.DIM, text)
        break
      default: {
        const _exhaustive: never = status
        throw new Error(`unhandled status: ${String(_exhaustive)}`)
      }
    }
  }
  return `  ${styled}`
}

function renderTopLevelRowBody(
  v: View,
  ansi: boolean,
  maxTitleLen?: number,
  targeted = false,
  durMs = 0,
): string {
  const t = v.task
  const numCol = styleNumCol(v, ansi, targeted)
  const stCol = statusGlyph(t.status, ansi, v.ghost)
  const idCol = styleIdCol(v, ansi, targeted)
  const titleCol = styleTitle(t, ansi, maxTitleLen, v.ghost, v.diff, targeted)
  // Duration trails the title — see `renderDurationSuffix`. Empty for
  // todo / 0ms rows, so the line ends at the title with no trailing
  // whitespace gutter eating horizontal real estate from the title.
  const durSuffix = renderDurationSuffix(durMs, t.status, ansi, v.ghost)
  return `  ${numCol}  ${stCol}  ${idCol}  ${titleCol}${durSuffix}`
}

function renderTopLevelRow(
  v: View,
  ansi: boolean,
  maxTitleLen?: number,
  targeted = false,
  durMs = 0,
): string {
  const frame = color(ansi, ANSI.DGRAY, GLYPHS.frameML)
  return `${frame} ${renderTopLevelRowBody(v, ansi, maxTitleLen, targeted, durMs)}`
}

function renderSubtaskRowBody(
  v: View,
  ansi: boolean,
  maxTitleLen?: number,
  targeted = false,
  durMs = 0,
): string {
  const t = v.task
  const isLast = v.siblingCount !== null && v.childIndex === v.siblingCount - 1
  const treeGlyph = color(ansi, ANSI.DGRAY, isLast ? GLYPHS.treeLast : GLYPHS.treeMid)
  const stCol = statusGlyph(t.status, ansi, v.ghost)
  const idCol = styleIdCol(v, ansi, targeted)
  const titleCol = styleTitle(t, ansi, maxTitleLen, v.ghost, v.diff, targeted)
  // Trailing duration suffix — empty for todo / 0ms rows. See the
  // sibling top-level builder for the rationale.
  const durSuffix = renderDurationSuffix(durMs, t.status, ansi, v.ghost)
  // Leading 6 spaces (NOT 7) so the tree glyph lands at the SAME body
  // offset as the parent's status glyph. Top-level row body is
  // `"  ${numCol(2)}  ${stCol}  ..."` → parent's `○` sits at body
  // offset 6 (2 + 2 + 2). Subtask body therefore needs 6 leading
  // spaces so `├` / `╰` lines up directly under `○`. Its own
  // `${stCol}` then lands at offset 9 (6 + 1 + 2), and the rest of
  // the row (status / id / title) is indented one column-pair deeper.
  // Previously this used 7 spaces, which shoved `├` one cell to the
  // RIGHT of the parent's `○` and made the subtree feel un-anchored.
  return `      ${treeGlyph}  ${stCol}  ${idCol}  ${titleCol}${durSuffix}`
}

function renderSubtaskRow(
  v: View,
  ansi: boolean,
  maxTitleLen?: number,
  targeted = false,
  durMs = 0,
): string {
  const frame = color(ansi, ANSI.DGRAY, GLYPHS.frameML)
  return `${frame} ${renderSubtaskRowBody(v, ansi, maxTitleLen, targeted, durMs)}`
}

function renderGap(ansi: boolean): string {
  return color(ansi, ANSI.DGRAY, GLYPHS.frameML)
}

// ---------------------------------------------------------------------------
// "All done" detection + tag
// ---------------------------------------------------------------------------

/**
 * True when there is nothing left to work on AND at least one task has
 * actually been completed. Canceled tasks DON'T disqualify the state —
 * they're intentionally not-done, so a list of "10 done + 2 canceled +
 * 0 todo + 0 doing" still counts as "ALL DONE from the user's POV".
 *
 * Edge cases:
 *   - empty list (total=0)               → false (nothing to celebrate)
 *   - only canceled tasks (done=0)       → false (nothing was finished)
 *   - first add_many (everything todo)   → false (done=0)
 *   - last todo gets canceled            → true  (doing=0, todo=0, done>0)
 */
function isAllDone(stats: Stats): boolean {
  return stats.doing === 0 && stats.todo === 0 && stats.done > 0
}

/**
 * The celebration tag — `✦ ALL DONE` in LIME+BOLD. Used as a header
 * suffix (so the in-stream action also reads "and now everything's
 * done") and as a closer prefix (so the final summary leads with the
 * good news).
 */
function allDoneTag(ansi: boolean): string {
  // Uppercase "ALL DONE" so the celebration reads as a small shout —
  // distinct from any per-row "done" word (which stays lowercase as
  // a status label).
  return color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, `${GLYPHS.sparkle} ALL DONE`)
}

// ---------------------------------------------------------------------------
// "Targeted row" emphasis — find the row that matches the action's hash
// ---------------------------------------------------------------------------

/**
 * For actions that mutate ONE specific task (added, started,
 * marked_done, marked_doing, marked_todo, marked_canceled, updated,
 * removed), return that task's hash. Bulk or non-targeting actions
 * (added_many, reordered, cleared, list, all_done) return null and no
 * row gets emphasized.
 *
 * The row whose `task.id` matches this hash is rendered with BOLD on
 * every column (number / icon-where-applicable / id / title), so the
 * reader can see at-a-glance "this is the one that just changed". For
 * a `marked done` row this turns the usual DIM+STRIKE title into
 * LIME+BOLD+STRIKE — popping the just-completed row out of the dim
 * sea of older completions. For `doing` rows the title is already
 * SKY+BOLD; the targeted-row signal then comes from the brighter
 * (LGRAY+BOLD) id column.
 */
function targetHashFromAction(action: RenderAction): string | null {
  switch (action.kind) {
    case "added":
    case "started":
    case "marked_done":
    case "marked_doing":
    case "marked_todo":
    case "marked_canceled":
    case "updated":
    case "removed":
      return action.hash
    case "added_many":
    case "reordered":
    case "cleared":
    case "list":
    case "all_done":
      return null
    default: {
      // Exhaustiveness check — fail closed (no emphasis) on a new kind.
      const _exhaustive: never = action
      void _exhaustive
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Closer rendering
// ---------------------------------------------------------------------------

function renderCloserText(
  stats: Stats,
  ansi: boolean,
  elapsedMs: number,
): string {
  const dot = color(ansi, ANSI.DIM, GLYPHS.bullet)
  const parts: string[] = []
  const allDone = isAllDone(stats)

  // Lead with the celebration when there's nothing left to do, so the
  // final summary row reads "you're done" before the per-status counts.
  if (allDone) parts.push(allDoneTag(ansi))

  parts.push(color(ansi, ANSI.LIME, `${stats.done} done`))
  // Hide the `0 doing` / `0 todo` zero-counts only in the all-done
  // state — those zeros ARE the celebration, but in any other state
  // a `0 doing` is informational (e.g. "you have 5 todo and 0 doing"
  // tells the user nothing's started yet). Keep canceled visible
  // whenever non-zero regardless of state.
  if (!allDone || stats.doing > 0) {
    parts.push(color(ansi, ANSI.SKY, `${stats.doing} doing`))
  }
  if (!allDone || stats.todo > 0) {
    parts.push(color(ansi, ANSI.DIM, `${stats.todo} todo`))
  }
  if (stats.canceled > 0) {
    parts.push(color(ansi, `${ANSI.DIM}${ANSI.RED}`, `${stats.canceled} canceled`))
  }

  // Trailing elapsed / total. The user wanted "total time it took" to
  // live in the footer ONLY (header carries date+time, no duration),
  // and to render in BOLD LIME GREEN at the all-done moment as the
  // single point of celebration. Mid-flight gets the same number in
  // quieter LGRAY — "informational, list is still running".
  //
  //  - all-done state with elapsed >= 1s → ` · 12m 34s` (LIME+BOLD)
  //  - mid-flight with elapsed >= 1s     → ` · 12m 12s` (LGRAY)
  //  - elapsed < 1s (or no started_at)   → suppressed entirely
  //                                        (matches the per-row
  //                                        formatDuration policy:
  //                                        no flicker for fast ops)
  const elapsedText = formatDuration(elapsedMs)
  if (elapsedText !== "") {
    const styled = allDone
      ? color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, elapsedText)
      : color(ansi, ANSI.LGRAY, elapsedText)
    parts.push(styled)
  }

  return parts.join(` ${dot} `)
}

function renderCloser(stats: Stats, ansi: boolean, elapsedMs: number): string {
  const frame = color(ansi, ANSI.DGRAY, GLYPHS.frameBL)
  return `${frame}  ${renderCloserText(stats, ansi, elapsedMs)}`
}

export interface ToolDisplayParts {
  header: string
  body: string
  footer: string
}

export function renderToolDisplay(
  views: readonly View[],
  stats: Stats,
  opts: RenderOptions,
): ToolDisplayParts {
  const nowEpochMs = (opts.now ?? Date.now)()
  // Snapshot the underlying Task[] once for per-row duration computation
  // (top-level rows sum their subtasks' active_ms) and for the closer's
  // wall-clock elapsed.
  const allTasks = views.map((v) => v.task)
  const bodyLines: string[] = []
  if (views.length === 0) {
    if (opts.action.kind === "list" || opts.action.kind === "cleared") {
      const dim = opts.ansi ? `${ANSI.DIM}\x1b[3m` : ""
      const reset = opts.ansi ? ANSI.RESET : ""
      bodyLines.push(`  ${dim}Task({action: "add_many", titles: [...]}) to plan a multi-step change${reset}`)
    }
  } else {
    const targetHash = targetHashFromAction(opts.action)
    for (const v of views) {
      const targeted = targetHash !== null && v.task.id === targetHash
      const durMs =
        v.task.parent === null
          ? topLevelTotalMs(v, allTasks, nowEpochMs)
          : taskActiveMs(v.task, nowEpochMs)
      bodyLines.push(
        v.task.parent === null
          ? renderTopLevelRowBody(v, opts.ansi, opts.maxTitleLen, targeted, durMs)
          : renderSubtaskRowBody(v, opts.ansi, opts.maxTitleLen, targeted, durMs),
      )
    }
  }
  bodyLines.push("")
  const elapsedMs = listTotalElapsedMs(allTasks, nowEpochMs)
  return {
    header: renderHeaderText(opts.action, stats, opts.ansi, nowEpochMs),
    body: bodyLines.join("\n"),
    footer: views.length === 0 ? "" : ` ${renderCloserText(stats, opts.ansi, elapsedMs)}`,
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render the full framed task block.
 *
 * Inputs:
 *  - `views` — the list of {@link View}s from {@link TaskStore.views}.
 *  - `stats` — counts from {@link TaskStore.stats}.
 *  - `opts`  — action verb + ansi flag + optional title cap.
 *
 * Output: a complete block with trailing newline. Lines are joined with
 * `\n` (no `\r`) — the agent's compositor handles `\n` → `\r\n` on output.
 */
export function renderBlock(
  views: readonly View[],
  stats: Stats,
  opts: RenderOptions,
): string {
  const nowEpochMs = (opts.now ?? Date.now)()
  const allTasks = views.map((v) => v.task)
  const lines: string[] = []
  lines.push(renderHeader(opts.action, stats, opts.ansi, nowEpochMs))
  if (views.length === 0) {
    lines.push(renderGap(opts.ansi))
    if (opts.action.kind === "list" || opts.action.kind === "cleared") {
      const dim = opts.ansi ? `${ANSI.DIM}\x1b[3m` : ""
      const reset = opts.ansi ? ANSI.RESET : ""
      lines.push(
        `${renderGap(opts.ansi)}   ${dim}Task({action: "add_many", titles: [...]}) to plan a multi-step change${reset}`,
      )
    }
    lines.push(renderGap(opts.ansi))
    lines.push(color(opts.ansi, ANSI.DGRAY, GLYPHS.frameBL))
    return `${lines.join("\n")}\n`
  }
  lines.push(renderGap(opts.ansi))
  const targetHash = targetHashFromAction(opts.action)
  for (const v of views) {
    const targeted = targetHash !== null && v.task.id === targetHash
    const durMs =
      v.task.parent === null
        ? topLevelTotalMs(v, allTasks, nowEpochMs)
        : taskActiveMs(v.task, nowEpochMs)
    if (v.task.parent === null) {
      lines.push(renderTopLevelRow(v, opts.ansi, opts.maxTitleLen, targeted, durMs))
    } else {
      lines.push(renderSubtaskRow(v, opts.ansi, opts.maxTitleLen, targeted, durMs))
    }
  }
  lines.push(renderGap(opts.ansi))
  const elapsedMs = listTotalElapsedMs(allTasks, nowEpochMs)
  lines.push(renderCloser(stats, opts.ansi, elapsedMs))
  return `${lines.join("\n")}\n`
}
