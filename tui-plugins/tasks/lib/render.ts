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
 *     │         ├  ✔  #d04c91a  Zero-state includes contextSize
 *     │         ├  ◐  #d04c91b  Replace-not-accumulate semantics
 *     │         ╰  ○  #d04c91c  Multi-turn growth pinned
 *     │    4  ○  #b18f73   ...
 *     │
 *     ╰  3 done · 1 doing · 5 todo
 *
 * Header is action-specific:
 *  - `marked done` (verb=done) → `✔ marked done #<id>`
 *  - `started` (verb=start)    → `◐ started #<id>`
 *  - `added N tasks` (verb=add) → `+ added N tasks`
 *  - `all done`                 → `✔ all done`
 *  - empty list / list verb     → ` 5 tasks` or `no tasks`
 *
 * @module tasks/lib/render
 */

import type { Stats, View } from "./store.ts"
import type { Task, TaskStatus } from "./parse.ts"

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
      return color(ansi, ANSI.DIM, GLYPHS.pending)
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
 * Style the title per status, with optional `ghost` / `diff` overlays:
 *  - ghost="removed"  → red + strikethrough (status/diff ignored)
 *  - diff={oldTitle}  → `<old red+strike>  →  <new>` inline diff,
 *                       where `<new>` inherits per-status styling
 *  - status=done      → dim + strikethrough
 *  - status=doing     → bold
 *  - status=todo      → plain
 *  - status=canceled  → red+dim `✘ ` prefix + dim+strike body + ` (reason)`
 */
function styleTitle(
  t: Task,
  ansi: boolean,
  maxLen?: number,
  ghost?: "removed",
  diff?: { oldTitle: string },
): string {
  const title = truncate(singleLineText(t.title), maxLen)
  // 1. Ghost wins — a just-removed row is a tombstone. Status, diff, and
  //    reason are all irrelevant for the visual.
  if (ghost === "removed") {
    return color(ansi, `${ANSI.RED}${ANSI.STRIKE}`, title)
  }
  // 2. Diff overlay — render `<old red+strike>  →  <new>`. The "new"
  //    half inherits per-status styling (so e.g. updating a `doing` task
  //    renders the new title bold).
  if (diff !== undefined) {
    const oldT = truncate(singleLineText(diff.oldTitle), maxLen)
    const oldCol = color(ansi, `${ANSI.RED}${ANSI.STRIKE}`, oldT)
    const arrow = color(ansi, ANSI.DIM, "  →  ")
    const newCol = styleTitleByStatus(t, title, ansi)
    return `${oldCol}${arrow}${newCol}`
  }
  // 3. Plain status styling (HEAD behavior, unchanged).
  return styleTitleByStatus(t, title, ansi)
}

/** Apply per-status text styling to an already-truncated title string. */
function styleTitleByStatus(t: Task, title: string, ansi: boolean): string {
  switch (t.status) {
    case "done":
      return color(ansi, `${ANSI.DIM}${ANSI.STRIKE}`, title)
    case "doing":
      return color(ansi, ANSI.BOLD, title)
    case "todo":
      return title
    case "canceled": {
      const x = color(ansi, `${ANSI.RED}${ANSI.DIM}`, GLYPHS.canceled)
      const body = color(ansi, `${ANSI.DIM}${ANSI.STRIKE}`, title)
      const reasonText = t.reason ? singleLineText(t.reason) : ""
      const reason = reasonText ? `  ${color(ansi, ANSI.DGRAY, `(${reasonText})`)}` : ""
      return `${x} ${body}${reason}`
    }
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

function renderHeaderText(action: RenderAction, stats: Stats, ansi: boolean): string {
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
      middle = `${color(ansi, ANSI.SKY, GLYPHS.doing)} started ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "marked_done":
      middle = `${color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.done)} marked done ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "marked_doing":
      middle = `${color(ansi, ANSI.SKY, GLYPHS.doing)} marked doing ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "marked_todo":
      middle = `${color(ansi, ANSI.DIM, GLYPHS.pending)} reset to todo ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
      break
    case "marked_canceled":
      middle = `${color(ansi, `${ANSI.RED}${ANSI.DIM}`, GLYPHS.canceled)} canceled ${color(ansi, ANSI.DGRAY, `#${action.hash}`)}`
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
      middle = `${color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.done)} ${color(ansi, ANSI.LIME, "all done")}`
      break
    case "list":
      if (stats.total === 0) {
        middle = `${color(ansi, `${ANSI.DIM}\x1b[3m`, "no tasks")}`
      } else {
        middle = `${color(ansi, ANSI.LGRAY, `${stats.total} task${stats.total === 1 ? "" : "s"}`)}`
      }
      break
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

  return `${middle}${suffix}`
}

function renderHeader(action: RenderAction, stats: Stats, ansi: boolean): string {
  const frame = color(ansi, ANSI.DGRAY, GLYPHS.frameTL)
  // CLI-only brand prefix. The agent path uses `renderToolDisplay` (which
  // skips this wrapper) and gets its identity from the manifest's icon
  // and label in the host tool-frame chrome instead. Keeping the brand
  // local to this CLI wrapper avoids leaking a duplicate "Tasks" word
  // into the agent's transcript where it would sit next to "Task" from
  // the manifest.
  const brand = `${color(ansi, ANSI.DIM, GLYPHS.pending)} ${color(ansi, ANSI.BOLD, "Tasks")}`
  const content = renderHeaderText(action, stats, ansi)
  const sep = content.length === 0 ? "" : ` ${color(ansi, ANSI.DIM, GLYPHS.bullet)} `
  return `${frame} ${brand}${sep}${content}`
}

// ---------------------------------------------------------------------------
// Row rendering
// ---------------------------------------------------------------------------

function renderTopLevelRowBody(v: View, ansi: boolean, maxTitleLen?: number): string {
  const t = v.task
  // Number column (right-aligned width 2).
  const numStr = String(v.n).padStart(2, " ")
  let numCol: string
  if (v.ghost === "removed") {
    numCol = color(ansi, `${ANSI.DIM}${ANSI.STRIKE}`, numStr)
  } else {
    switch (t.status) {
      case "done":
        numCol = color(ansi, ANSI.DIM, numStr)
        break
      case "doing":
        numCol = color(ansi, ANSI.BOLD, numStr)
        break
      case "todo":
      case "canceled":
        numCol = color(ansi, ANSI.LGRAY, numStr)
        break
    }
  }
  const stCol = statusGlyph(t.status, ansi, v.ghost)
  const idCol = v.ghost === "removed"
    ? color(ansi, `${ANSI.DGRAY}${ANSI.STRIKE}`, `#${t.id}`)
    : color(ansi, ANSI.DGRAY, `#${t.id}`)
  const titleCol = styleTitle(t, ansi, maxTitleLen, v.ghost, v.diff)
  return `  ${numCol}  ${stCol}  ${idCol}  ${titleCol}`
}

function renderTopLevelRow(v: View, ansi: boolean, maxTitleLen?: number): string {
  const frame = color(ansi, ANSI.DGRAY, GLYPHS.frameML)
  return `${frame} ${renderTopLevelRowBody(v, ansi, maxTitleLen)}`
}

function renderSubtaskRowBody(v: View, ansi: boolean, maxTitleLen?: number): string {
  const t = v.task
  const isLast = v.siblingCount !== null && v.childIndex === v.siblingCount - 1
  const treeGlyph = color(ansi, ANSI.DGRAY, isLast ? GLYPHS.treeLast : GLYPHS.treeMid)
  const stCol = statusGlyph(t.status, ansi, v.ghost)
  const idCol = v.ghost === "removed"
    ? color(ansi, `${ANSI.DGRAY}${ANSI.STRIKE}`, `#${t.id}`)
    : color(ansi, ANSI.DGRAY, `#${t.id}`)
  const titleCol = styleTitle(t, ansi, maxTitleLen, v.ghost, v.diff)
  return `       ${treeGlyph}  ${stCol}  ${idCol}  ${titleCol}`
}

function renderSubtaskRow(v: View, ansi: boolean, maxTitleLen?: number): string {
  const frame = color(ansi, ANSI.DGRAY, GLYPHS.frameML)
  return `${frame} ${renderSubtaskRowBody(v, ansi, maxTitleLen)}`
}

function renderGap(ansi: boolean): string {
  return color(ansi, ANSI.DGRAY, GLYPHS.frameML)
}

// ---------------------------------------------------------------------------
// Closer rendering
// ---------------------------------------------------------------------------

function renderCloserText(stats: Stats, ansi: boolean): string {
  const dot = color(ansi, ANSI.DIM, GLYPHS.bullet)
  const parts: string[] = []
  parts.push(color(ansi, ANSI.LIME, `${stats.done} done`))
  parts.push(color(ansi, ANSI.SKY, `${stats.doing} doing`))
  parts.push(color(ansi, ANSI.DIM, `${stats.todo} todo`))
  if (stats.canceled > 0) {
    parts.push(color(ansi, `${ANSI.DIM}${ANSI.RED}`, `${stats.canceled} canceled`))
  }
  return parts.join(` ${dot} `)
}

function renderCloser(stats: Stats, ansi: boolean): string {
  const frame = color(ansi, ANSI.DGRAY, GLYPHS.frameBL)
  return `${frame}  ${renderCloserText(stats, ansi)}`
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
  const bodyLines: string[] = []
  if (views.length === 0) {
    if (opts.action.kind === "list" || opts.action.kind === "cleared") {
      const dim = opts.ansi ? `${ANSI.DIM}\x1b[3m` : ""
      const reset = opts.ansi ? ANSI.RESET : ""
      bodyLines.push(`  ${dim}Task({action: "add_many", titles: [...]}) to plan a multi-step change${reset}`)
    }
  } else {
    for (const v of views) {
      bodyLines.push(
        v.task.parent === null
          ? renderTopLevelRowBody(v, opts.ansi, opts.maxTitleLen)
          : renderSubtaskRowBody(v, opts.ansi, opts.maxTitleLen),
      )
    }
  }
  bodyLines.push("")
  return {
    header: renderHeaderText(opts.action, stats, opts.ansi),
    body: bodyLines.join("\n"),
    footer: views.length === 0 ? "" : ` ${renderCloserText(stats, opts.ansi)}`,
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
  const lines: string[] = []
  lines.push(renderHeader(opts.action, stats, opts.ansi))
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
  for (const v of views) {
    if (v.task.parent === null) {
      lines.push(renderTopLevelRow(v, opts.ansi, opts.maxTitleLen))
    } else {
      lines.push(renderSubtaskRow(v, opts.ansi, opts.maxTitleLen))
    }
  }
  lines.push(renderGap(opts.ansi))
  lines.push(renderCloser(stats, opts.ansi))
  return `${lines.join("\n")}\n`
}
