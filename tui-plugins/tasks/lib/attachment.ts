/**
 * Per-turn `<ma::tui::tasks>` attachment producer.
 *
 * The agent's task list is stored at `~/.minimal-agent/sessions/<sid>.tasks.jsonl`
 * (one task per line, see `lib/parse.ts`). To make the live state reliably
 * present in the model's context every turn — without busting the
 * system-prompt cache — we prepend a `<ma::tui::tasks>…</ma::tui::tasks>`
 * attachment to the FIRST user message of each `Agent.run` call.
 *
 * Same mechanism as the memory plugin's `ShortTermSnapshot` (see
 * `tui-plugins/memory/lib/short-term-snapshot.ts`). The attachment sits
 * behind the rolling-tail cache breakpoint (which is invalidated every
 * turn anyway by the new user message), so the snapshot costs zero
 * extra cache invalidation.
 *
 * # Why the `ma::tui::` namespace
 *
 * Two prefix conventions in the codebase:
 *
 * - `<tui::name>` — emitted by the MODEL, scanned and extracted from
 *   assistant output by `src/plugins/scanner.ts`.
 * - `<ma::tui::name>` — emitted by the AGENT runtime as a user-message
 *   attachment. Distinct namespace so the scanner doesn't accidentally
 *   try to extract these, and so the source of the tag is unambiguous.
 *
 * # When the attachment is omitted
 *
 * - Zero tasks in the session file (or file missing entirely). The model
 *   sees nothing — no token cost when tasks aren't in play.
 * - No session id available (rare; defensive fallback).
 *
 * # Loop-seam vs initial-seam
 *
 * Initial-seam only. The model already saw the snapshot at the start of
 * the turn; re-emitting on every tool round would balloon context with
 * stale repeats. Tool calls update the file synchronously; the model
 * sees the post-update state via the tool's `tool_result.content`
 * (which is rendered through the same pure-text view).
 *
 * @module tasks/lib/attachment
 */

import type { ContentBlock } from "../../../src/client.ts"

import type { Task } from "./parse.ts"
import { TaskStore, type StoreDeps } from "./store.ts"

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the tasks list as the body of a `<ma::tui::tasks>` attachment.
 *
 * Compact ASCII, no ANSI, parseable. Each top-level task is one line
 * with `N  #hash  status  title`; subtasks use `Na`/`Nb`/... in the
 * leftmost column to indicate parentage without adding a separate field.
 *
 * Exported for tests; the public API is {@link TasksAttachment.toAttachment}.
 */
/**
 * Format `active_ms` for the attachment's duration column. Same ladder
 * the renderer uses (1s precision → minutes → hours → days), but
 * inlined here to keep the attachment module pure (no dependency on
 * the renderer). Empty string for `< 1s`.
 */
function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return ""
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}m${rs.toString().padStart(2, "0")}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return `${h}h${rm.toString().padStart(2, "0")}m`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return `${d}d${rh.toString().padStart(2, "0")}h`
}

export function renderAttachmentBody(tasks: readonly Task[]): string {
  if (tasks.length === 0) return ""
  // Pre-compute per-task display position: top-level tasks get a 1-indexed
  // integer "N"; subtasks get "Na" / "Nb" / ... based on their parent's N
  // and the suffix character of the subtask id.
  const positions = new Map<string, string>()
  let topN = 0
  for (const t of tasks) {
    if (t.parent === null) {
      topN += 1
      positions.set(t.id, String(topN))
    } else {
      const parentPos = positions.get(t.parent)
      if (parentPos === undefined) {
        // Orphaned subtask (parent missing from list). Fall back to bare id
        // so the model still has something to work with.
        positions.set(t.id, "?")
      } else {
        const suffix = t.id.slice(-1) // a, b, c, ...
        positions.set(t.id, `${parentPos}${suffix}`)
      }
    }
  }
  // Find column widths for clean alignment. Position width is "longest
  // position string" (e.g. "10c" = 3 chars).
  let posWidth = 0
  for (const p of positions.values()) posWidth = Math.max(posWidth, p.length)
  const lines: string[] = []
  for (const t of tasks) {
    const pos = positions.get(t.id) ?? "?"
    const posCol = pos.padEnd(posWidth)
    const idCol = `#${t.id}`.padEnd(8) // "#abc123" = 7, "#abc123a" = 8
    const statusCol = t.status.padEnd(8) // "canceled" = 8
    // Duration trails the title with a 2-space gap. Omitted entirely
    // for tasks with no duration so the row ends at the title and
    // doesn't carry a whitespace gutter through the middle of the
    // line. Mirrors the human-facing renderer's row shape so the
    // model's view and the user's TUI agree on column order.
    const durText = fmtDur(t.active_ms)
    const durSuffix = durText.length > 0 ? `  ${durText}` : ""
    lines.push(`${posCol}  ${idCol}  ${statusCol}  ${t.title}${durSuffix}`)
  }
  return lines.join("\n")
}

/**
 * Compute summary counts. Same shape as {@link Stats} from `store.ts`
 * but locally re-derived so this module doesn't depend on the full
 * store at render time.
 */
function summary(tasks: readonly Task[]): {
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

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

/**
 * Per-session attachment producer.
 *
 * Construct one per agent. Holds the session id and reads the tasks
 * file on every {@link toAttachment} call. When the session id is
 * `null` (no session plumbed through), every call returns `null`.
 */
export class TasksAttachment {
  constructor(
    public readonly sid: string | null,
    private readonly deps: StoreDeps = {},
  ) {}

  /**
   * Render the current attachment, or `null` if there are no tasks (so
   * the agent can append unconditionally).
   *
   * Output shape:
   *
   *     <ma::tui::tasks total="5" done="2" doing="1" todo="2" canceled="0">
   *     1   #a7b3c4   done      Add contextSize to SessionTokens
   *     2   #f8e21a   doing     Update src/session-tokens.test.ts
   *     2a  #f8e21aa  done      Zero-state includes contextSize
   *     ...
   *     </ma::tui::tasks>
   */
  toAttachment(): ContentBlock | null {
    if (this.sid === null || this.sid.trim().length === 0) return null

    const store = new TaskStore(this.sid, this.deps)
    const tasks = store.list()
    if (tasks.length === 0) return null

    const s = summary(tasks)
    const body = renderAttachmentBody(tasks)
    return {
      type: "text",
      text: `<ma::tui::tasks total="${s.total}" done="${s.done}" doing="${s.doing}" todo="${s.todo}" canceled="${s.canceled}">\n${body}\n</ma::tui::tasks>`,
    }
  }

  /**
   * Convenience: returns just the rendered text (or `null`). Used by
   * tests that want to assert on string shape without unwrapping the
   * ContentBlock.
   */
  toText(): string | null {
    const a = this.toAttachment()
    return a?.type === "text" ? a.text : null
  }
}
