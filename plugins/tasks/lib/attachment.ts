/**
 * Per-turn `<ma::agent::tasks>` attachment producer.
 *
 * The agent's task list is stored at `~/.minimal-agent/sessions/<sid>.tasks.jsonl`
 * (one task per line, see `lib/parse.ts`). To make the live state reliably
 * present in the model's context every turn — without busting the
 * system-prompt cache — we prepend a `<ma::agent::tasks>…</ma::agent::tasks>`
 * attachment to the FIRST user message of each `Agent.run` call.
 *
 * Same mechanism as the memory plugin's `ShortTermSnapshot` (see
 * `plugins/memory/lib/short-term-snapshot.ts`). The attachment sits
 * behind the rolling-tail cache breakpoint (which is invalidated every
 * turn anyway by the new user message), so the snapshot costs zero
 * extra cache invalidation.
 *
 * # The `<ma::agent::*>` namespace
 *
 * Every model-facing tag is `<ma::OWNER::leaf>`, partitioned by who
 * produces it:
 *
 * - `<ma::sys::*>`   — composed into the system prompt (the model reads it).
 * - `<ma::agent::*>` — emitted by the AGENT runtime as a per-turn signal the
 *   model reads. `<ma::agent::tasks>` is one of these: live task state
 *   prepended to the user message here.
 * - `<ma::emit::*>`  — emitted by the MODEL and scanned out of assistant
 *   output by `src/plugins/scanner.ts` to fire an inline handler.
 *
 * The output scanner only watches for `<ma::emit::*>`, so an
 * `<ma::agent::tasks>` attachment is unambiguously "data the model reads",
 * never "a trigger the model fired".
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

import type { Task } from "./parse.ts"
import { type StoreDeps, TaskStore } from "./store.ts"

/**
 * LOCAL structural slice of the host's `ContentBlock` union — the text block
 * this producer emits. The host's turn-attachment registry expects
 * `toAttachment(): ContentBlock | null`; a text block satisfies that union
 * structurally, so the real host accepts it without the plugin importing host
 * code (the decoupling contract). Source of truth: `src/client/types.ts`
 * (`TextBlock`).
 */
interface AttachmentTextBlock {
  type: "text"
  text: string
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the tasks list as the body of a `<ma::agent::tasks>` attachment.
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

/**
 * Render the task list as the body of the per-turn `<ma::agent::tasks>`
 * attachment; empty string when there are no tasks (zero token cost).
 */
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
   * ```
   *     <ma::agent::tasks total="5" done="2" doing="1" todo="2" canceled="0">
   *     1   #a7b3c4   done      Add contextSize to SessionTokens
   *     2   #f8e21a   doing     Update src/session-tokens.test.ts
   *     2a  #f8e21aa  done      Zero-state includes contextSize
   *     ...
   *     </ma::agent::tasks>
   * ```
   */
  toAttachment(): AttachmentTextBlock | null {
    if (this.sid === null || this.sid.trim().length === 0) return null

    const store = new TaskStore(this.sid, this.deps)
    const tasks = store.list()
    if (tasks.length === 0) return null

    const s = summary(tasks)
    const body = renderAttachmentBody(tasks)
    return {
      type: "text",
      text: `<ma::agent::tasks total="${s.total}" done="${s.done}" doing="${s.doing}" todo="${s.todo}" canceled="${s.canceled}">\n${body}\n</ma::agent::tasks>`,
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
