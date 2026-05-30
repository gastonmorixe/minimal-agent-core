/**
 * Replay re-derivers : recover the `display` / `displayHeader` /
 * `displayFooter` fields the live transcript drew for a tool call, when
 * the session JSONL was written BEFORE those fields were persisted (or
 * by a tool that doesn't supply them).
 *
 * Each re-deriver is a pure function `(input, content) -> overrides?`:
 *
 *   - `input` is the `tool_use.input` object as the model supplied it.
 *     For `Edit` that's `{ file_path, old_string, new_string,
 *     replace_all }`; for `Task` it's the action verb (`add_many`,
 *     `done`, …) plus action-specific fields.
 *
 *   - `content` is the model-facing `tool_result.content` text. For
 *     Task that text already carries the rendered tree
 *     (`header\n<body>\nfooter`) because the live plugin builds
 *     `content` by joining the same `displayParts`. We just need to
 *     split it back apart.
 *
 *   - The return shape mirrors `ToolResultRecord`'s presentation
 *     fields. `undefined` means "no override produced, fall back to
 *     the default content rendering" — never "throw".
 *
 * Tools we cover today:
 *
 *   1. **Task** — split `content` at the first / last lines and treat
 *      the middle as the body. The Task plugin's `renderResult` joins
 *      `[header, body, footer]` with `\n`, so we get back what the
 *      user saw, minus ANSI styling. Still way better than the
 *      pre-fix bug: header carries `✔ ALL DONE · N/M · …` instead of
 *      the raw JSON args, and the body fits without the `shown N/M L`
 *      truncation footer.
 *
 *   2. **Edit** — synthesize a unified diff from `old_string` /
 *      `new_string`. The live `Edit` tool needs the file's BEFORE
 *      content to build proper context; at replay time the file may
 *      have been edited many more times, so we fall back to a
 *      no-context `-old\n+new` synthetic diff. Renders through the
 *      same `renderUnifiedDiff` colorizer the live tool uses, so the
 *      pink/lime hunk styling matches.
 *
 *   3. **Write** — same idea but with `before=""`, so the entire
 *      `content` of the input shows as `+`-prefixed addition lines.
 *
 * Plugin tools other than Task (WebSearch, MemoryTool, ShowDiff,
 * LockStatus, …) currently have no derivation : pre-fix sessions
 * render their model-facing `content` line-by-line, same as today's
 * unconditional fallback. Adding more derivers later is straight
 * forward : each one is a self-contained function with no global
 * state, and `deriveDisplayFallback` dispatches by tool name.
 *
 * @module session-replay-derivers
 */

import { renderUnifiedDiff } from "../plugins/diff-view/handlers/render.ts"
import type { Task, TaskStatus } from "../plugins/tasks/lib/parse.ts"
import { type RenderAction, renderToolDisplay } from "../plugins/tasks/lib/render.ts"
import { buildViews } from "../plugins/tasks/lib/store.ts"

import { buildEditDiff, buildFileDiff } from "./diff.ts"

/**
 * Override fields a re-deriver may populate. Each one is independently
 * optional : a deriver that only knows the body returns `{display:
 * "..."}` and leaves header/footer untouched.
 */
export interface DerivedDisplay {
  display?: string
  displayHeader?: string
  displayFooter?: string
}

/**
 * Annotation prefixes the agent appends to `content` for the model.
 * Stripped before splitting Task content so the trailing
 * `<ma::agent::output-preview …>…</ma::agent::output-preview>` and
 * `<ma::tui-preview …>…</ma::tui-preview>` blocks don't bleed into
 * the derived header/body/footer.
 *
 * Mirrors `findAnnotationStart` in `src/agent/tool-format.ts`. Kept
 * local here to avoid the import-cycle risk (replay → agent → replay).
 */
const ANNOTATION_OPENERS: readonly string[] = [
  "\n\n[truncated:",
  "\n\n[note:",
  "\n\n<ma::agent::output-preview",
  "\n\n<ma::tui-preview",
]

function stripTrailingAnnotations(content: string): string {
  let earliest = -1
  for (const op of ANNOTATION_OPENERS) {
    const i = content.lastIndexOf(op)
    if (i !== -1 && (earliest === -1 || i < earliest)) earliest = i
  }
  return earliest === -1 ? content : content.slice(0, earliest)
}

/**
 * The Task plugin's `content` text is always `header\nbody\nfooter` (or
 * subsets when one of the parts is empty). Split it back into the three
 * presentation slots. Empty results return `undefined` so the caller
 * can fall through to the default rendering path.
 *
 * Heuristic: when content has ≥ 3 non-empty lines, line 0 is header,
 * line N-1 is footer, the rest is the body. With 2 lines we treat them
 * as header + body. With 1 line we surface it as the header. Zero
 * lines → no override.
 *
 * The body slot keeps any blank lines from the middle (the task plugin
 * uses a blank line between top-level tasks and the subtree). Trailing
 * whitespace on each line is preserved verbatim so the alignment the
 * user saw live stays intact.
 */
export function deriveTaskDisplay(opts: {
  content: string
  /**
   * The Task tool_use's `input` object (the same the model sent). Only
   * required when the sidecar-driven re-render path activates : the
   * `action` field maps to a {@link RenderAction} for the header verb.
   */
  input?: Record<string, unknown>
  /**
   * Wall-clock at the moment the historical Task call ran. Used to
   * snapshot {@link sidecarTasks} BACK in time so a `start` call early
   * in the session renders with `todo` rows even though the sidecar
   * (which is overwritten in place by every action) now has those
   * tasks as `done`. When `null` the snapshot uses the sidecar's
   * current state.
   */
  callTs?: Date | null
  /**
   * Full task list parsed from the per-session `<sid>.tasks.jsonl`
   * sidecar. When provided, the deriver renders the body via the
   * plugin's `renderToolDisplay({ansi: true})` for byte-identical
   * coloring with the live agent (status glyph colors, dim hashes,
   * sky-blue durations, etc.). When `null` / `undefined`, falls back
   * to the structural content-split path (header / body / footer
   * with no ANSI inside the body).
   */
  sidecarTasks?: readonly Task[] | null
}): DerivedDisplay | undefined {
  const content = opts.content
  const sidecar = opts.sidecarTasks ?? null
  const input = opts.input ?? null

  // Sidecar-driven re-render: snapshot the task tree at the call's
  // wall-clock and run the live plugin's renderToolDisplay. Wrapped in
  // try/catch so a malformed sidecar / unexpected input falls back to
  // the structural split path instead of breaking resume.
  //
  // The outer gate accepts an EMPTY sidecar so `add_many` /
  // `add` calls (which precede any persisted task) still render via
  // the plugin path. The inner gate decides per-action whether the
  // post-cutoff snapshot is renderable.
  if (sidecar !== null && input !== null) {
    try {
      const cutoff = opts.callTs ?? null
      const snapshot = snapshotTasksAt(sidecar, cutoff)
      // Empty snapshot at this cutoff is meaningful for add-like
      // actions (the plugin renders an "+ added N tasks" header with
      // no body rows). For every other action, fall through to the
      // content-split path : we'd produce a contentless block.
      if (snapshot.length > 0 || input.action === "add_many" || input.action === "add") {
        const stats = computeStats(snapshot)
        const action = mapInputToRenderAction(input, stats)
        const views = buildViews(snapshot)
        const now = cutoff !== null ? () => cutoff.getTime() : undefined
        const parts = renderToolDisplay(views, stats, {
          ansi: true,
          action,
          ...(now !== undefined ? { now } : {}),
        })
        return {
          displayHeader: parts.header,
          display: parts.body,
          displayFooter: parts.footer,
        }
      }
    } catch {
      // Fall through to the structural split path below.
    }
  }

  // Structural fallback: split content into header / body / footer
  // when no sidecar is available (tests, missing file, plugin disabled).
  const trimmed = stripTrailingAnnotations(content).replace(/\n+$/g, "")
  if (trimmed.length === 0) return undefined
  const lines = trimmed.split("\n")
  if (lines.length === 1) return { displayHeader: lines[0] }
  if (lines.length === 2) return { displayHeader: lines[0], display: lines[1] }
  const header = lines[0]
  const footer = lines[lines.length - 1]
  const bodyLines = lines.slice(1, -1)
  return { displayHeader: header, display: bodyLines.join("\n"), displayFooter: footer }
}

/**
 * Reconstruct the state of every task at a historical `cutoff`
 * timestamp using the per-task `created_at` / `started_at` / `done_at`
 * fields the sidecar stores. Tasks created after the cutoff are
 * dropped. Status is back-computed:
 *
 *   - `done_at <= cutoff` → `done`.
 *   - `started_at <= cutoff` → `doing` (and `done_at` reset to null
 *     since we hadn't completed it yet).
 *   - otherwise → `todo` (with `started_at` AND `done_at` cleared).
 *
 * Limitations (intentional):
 *
 *   - `canceled` tasks have no explicit cancel timestamp, so they're
 *     surfaced with their final status regardless of cutoff. This is
 *     a small lie when a task was canceled mid-session and we're
 *     rendering an earlier call, but the alternative is to misclassify
 *     them as `todo` which is also a lie.
 *
 *   - Tasks that were REMOVED before the cutoff are unrecoverable :
 *     the sidecar is rewritten in place (not append-only), so the
 *     remove erases history. Tradeoff is acceptable : most sessions
 *     don't remove tasks.
 *
 *   - `active_ms` is NOT back-adjusted. Top-level row durations may
 *     read slightly high for in-flight `doing` rows at the cutoff.
 *
 * When `cutoff` is `null`, returns a shallow copy of the input
 * (current state).
 */
export function snapshotTasksAt(tasks: readonly Task[], cutoff: Date | null): Task[] {
  if (cutoff === null) return [...tasks]
  const cutoffMs = cutoff.getTime()
  const out: Task[] = []
  for (const t of tasks) {
    const createdAtMs = Date.parse(t.created_at)
    if (Number.isFinite(createdAtMs) && createdAtMs > cutoffMs) continue
    let status: TaskStatus = t.status
    let started_at: string | null = t.started_at
    let done_at: string | null = t.done_at
    const doneAtMs = t.done_at ? Date.parse(t.done_at) : Number.NaN
    const startedAtMs = t.started_at ? Date.parse(t.started_at) : Number.NaN
    if (t.status === "canceled") {
      // Preserve as-is. See module doc for the trade-off.
    } else if (Number.isFinite(doneAtMs) && doneAtMs <= cutoffMs) {
      status = "done"
    } else if (Number.isFinite(startedAtMs) && startedAtMs <= cutoffMs) {
      status = "doing"
      done_at = null
    } else {
      status = "todo"
      started_at = null
      done_at = null
    }
    out.push({ ...t, status, started_at, done_at })
  }
  return out
}

/**
 * Compute the post-mutation `Stats` aggregate for the rendered footer.
 * Mirrors `TaskStore.stats()` so we don't have to construct a full
 * store at re-derive time.
 */
function computeStats(tasks: readonly Task[]): {
  total: number
  done: number
  doing: number
  todo: number
  canceled: number
} {
  const s = { total: tasks.length, done: 0, doing: 0, todo: 0, canceled: 0 }
  for (const t of tasks) s[t.status] += 1
  return s
}

/**
 * Map a Task tool_use's `input` object to a {@link RenderAction} the
 * plugin's renderer understands. The mapping is verb-driven:
 *
 *   - `add_many` → `added_many` with the title count.
 *   - `add` → `added_many` with `count: 1` (we don't have the new
 *     hash : it's generated at exec time and not echoed back in the
 *     input). Loses the per-row "targeted" highlight but renders the
 *     correct header verb.
 *   - `start` / `done` / `status` → `started` / `marked_done` /
 *     `marked_<value>` with the task hash (`#` prefix stripped).
 *   - `update` / `remove` → `updated` / `removed` with the hash.
 *   - `reorder` / `list` / `clear` → kind-only.
 *
 * **`marked_done → all_done` upgrade**: when the post-mutation snapshot
 * shows every top-level task as `done`, we emit `{kind: "all_done"}`
 * instead. The live plugin does the same check (see
 * `task_tool.ts :: ok` and the header-text selector for the "ALL DONE"
 * row), so this preserves the user's expected closing celebratory line.
 */
function mapInputToRenderAction(
  input: Record<string, unknown>,
  stats: { total: number; done: number; doing: number; todo: number; canceled: number },
): RenderAction {
  const action = typeof input.action === "string" ? input.action : ""
  const stripHash = (raw: unknown): string => {
    const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : ""
    return s.startsWith("#") ? s.slice(1) : s
  }
  const allDone = stats.total > 0 && stats.done === stats.total
  switch (action) {
    case "add_many": {
      const titles = Array.isArray(input.titles) ? input.titles : []
      return { kind: "added_many", count: titles.length }
    }
    case "add":
      return { kind: "added_many", count: 1 }
    case "start":
      return { kind: "started", hash: stripHash(input.id) }
    case "done":
      return allDone ? { kind: "all_done" } : { kind: "marked_done", hash: stripHash(input.id) }
    case "status": {
      const status = typeof input.status === "string" ? input.status : ""
      const hash = stripHash(input.id)
      if (status === "doing") return { kind: "marked_doing", hash }
      if (status === "todo") return { kind: "marked_todo", hash }
      if (status === "canceled") return { kind: "marked_canceled", hash }
      // status === "done"
      return allDone ? { kind: "all_done" } : { kind: "marked_done", hash }
    }
    case "update":
      return { kind: "updated", hash: stripHash(input.id) }
    case "remove":
      return { kind: "removed", hash: stripHash(input.id) }
    case "reorder":
      return { kind: "reordered" }
    case "list":
      return { kind: "list" }
    case "clear":
      return { kind: "cleared", count: stats.total }
    default:
      return { kind: "list" }
  }
}

/**
 * Synthesize a unified diff for an `Edit` tool call from its persisted
 * input. We don't have the file's BEFORE content (the file likely
 * changed many edits later), so we use `old_string` itself as `before`
 * and run the same `buildEditDiff` the live tool uses. The hunk has
 * no surrounding context (it would be the same `-`/`+` lines anyway)
 * but the structural diff is faithful : `-` for every old line, `+`
 * for every new line, with hunk markers and `--- a/…` / `+++ b/…`
 * headers ready for `renderUnifiedDiff` to color.
 *
 * Returns `undefined` when `old_string` / `new_string` are missing or
 * empty : we'd produce a contentless diff in that case and the live
 * tool wouldn't have either.
 */
export function deriveEditDisplay(input: Record<string, unknown>): DerivedDisplay | undefined {
  const filePath = typeof input.file_path === "string" ? input.file_path : null
  const oldString = typeof input.old_string === "string" ? input.old_string : null
  const newString = typeof input.new_string === "string" ? input.new_string : null
  const replaceAll = input.replace_all === true
  if (filePath === null || oldString === null || newString === null) return undefined
  if (oldString.length === 0) return undefined
  // No-context diff: pass before=oldString so the diff machinery finds
  // the match at offset 0 and emits the `-old / +new` hunk without
  // surrounding context. Loses the contextual ribbon lines (` ` rows)
  // the live diff has, which is acceptable : the user mainly cares
  // about WHAT changed, and that's preserved verbatim.
  const patch = buildEditDiff(filePath, oldString, oldString, newString, replaceAll, 0)
  if (patch === "") return undefined
  const display = renderUnifiedDiff(patch)
  return { display }
}

/**
 * Synthesize a "new file" diff for a `Write` tool call from its
 * persisted input. The live tool computes the diff between the file's
 * pre-write content and the new content; at replay time the file's
 * pre-write content is unknowable, so we render the WHOLE input as
 * additions (i.e. treat it as a brand-new file).
 *
 * Visually this differs from the live render when the Write actually
 * modified an existing file : pre-fix sessions show "+" for every
 * line of the new content instead of a focused hunk on the edited
 * region. The structural information is still faithful (the user can
 * see the file's final state in green) and there's no false-negative
 * (we don't omit anything that did change).
 */
export function deriveWriteDisplay(input: Record<string, unknown>): DerivedDisplay | undefined {
  const filePath = typeof input.file_path === "string" ? input.file_path : null
  const contentArg = typeof input.content === "string" ? input.content : null
  if (filePath === null || contentArg === null) return undefined
  if (contentArg.length === 0) return undefined
  const patch = buildFileDiff(filePath, "", contentArg, 0)
  if (patch === "") return undefined
  const display = renderUnifiedDiff(patch, `New file: ${filePath}`)
  return { display }
}

/**
 * Tool-name → re-deriver dispatch. Used by `toolDisplaysFromRecords`
 * in `src/session-replay.ts` when the persisted `tool_result` row has
 * no `display` / `displayHeader` / `displayFooter` of its own. Errors
 * inside a re-deriver are swallowed (returns undefined) so a buggy
 * deriver never breaks the resume path : the worst case is "this tool
 * row falls back to the unconditional content render".
 *
 * Tools not in the dispatch table return `undefined` quietly. Adding
 * a new deriver = adding a new case here.
 */
export function deriveDisplayFallback(opts: {
  toolName: string
  input: Record<string, unknown> | undefined
  content: string
  isError: boolean
  /**
   * Wall-clock at the moment the historical call ran. Forwarded to
   * `deriveTaskDisplay` for cutoff-based status reconstruction. Other
   * derivers (Edit / Write) ignore it.
   */
  callTs?: Date | null
  /**
   * Sidecar task list (already parsed). Forwarded to
   * `deriveTaskDisplay` for ANSI-colored re-rendering. When omitted /
   * empty, the task deriver falls back to its content-split path
   * (works but loses body colors).
   */
  sidecarTasks?: readonly Task[] | null
}): DerivedDisplay | undefined {
  if (opts.isError) return undefined
  const input = opts.input ?? {}
  try {
    switch (opts.toolName) {
      case "Task":
        return deriveTaskDisplay({
          content: opts.content,
          input,
          callTs: opts.callTs ?? null,
          sidecarTasks: opts.sidecarTasks ?? null,
        })
      case "Edit":
        return deriveEditDisplay(input)
      case "Write":
        return deriveWriteDisplay(input)
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}
