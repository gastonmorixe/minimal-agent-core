/**
 * Replay renderer for historical `Task` tool calls (`--resume` path).
 *
 * Declared in `manifest.json` under `replayRenderers`; the host loader
 * resolves this module through its runtime-discovery seam and registers
 * it in the core replay registry. At replay time the host hands each
 * persisted `Task` tool_result row to {@link renderTaskReplay}, which
 * re-renders the body via the SAME `renderToolDisplay({ansi: true})`
 * the live tool uses — so restored sessions keep the lime/sky/red
 * status styling, dim hashes, and duration columns.
 *
 * The host supplies the per-session sidecar (`<sid>.tasks.jsonl`,
 * already parsed) plus the historical call's wall-clock. Because the
 * sidecar is overwritten in place by every action, the handler
 * time-travels the task list back to the call's cutoff (see
 * {@link snapshotTasksAt}) so an early `start` call renders with `todo`
 * rows even though those tasks are `done` today.
 *
 * Returning `undefined` declines the row: the host then falls back to
 * its plain-text content-split derivation. The handler declines when no
 * sidecar is available or the snapshot has nothing renderable, and
 * swallows its own errors — a malformed sidecar must never break
 * resume.
 *
 * Types for the host envelope are re-declared locally (structural
 * typing); this module imports nothing from the host repo.
 *
 * @module tasks/handlers/replay_render
 */

import type { Task, TaskStatus } from "../lib/parse.ts"
import { type RenderAction, renderToolDisplay } from "../lib/render.ts"
import { buildViews } from "../lib/store.ts"

/**
 * Host envelope for one historical tool_result row. Local structural
 * slice of the host's `ReplayToolRenderInput` (the host's sidecar-task
 * shape is structurally identical to this plugin's own {@link Task}).
 */
export interface ReplayRenderInput {
  /** The tool_use's `input` object as the model supplied it. */
  input: Record<string, unknown>
  /** The model-facing `tool_result.content` text. */
  content: string
  /** Wall-clock at the moment the historical call ran, when known. */
  callTs: Date | null
  /** Parsed sidecar task list, when the host loaded one. */
  sidecarTasks: readonly Task[] | null
}

/** Presentation overrides handed back to the host. */
export interface ReplayRenderResult {
  display?: string
  displayHeader?: string
  displayFooter?: string
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
 * store at re-render time.
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
 * renderer understands. The mapping is verb-driven:
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
 * shows every task as `done`, we emit `{kind: "all_done"}` instead.
 * The live tool does the same check, so this preserves the user's
 * expected closing celebratory line.
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
 * Re-render one historical `Task` row with full ANSI styling, or
 * decline (`undefined`) so the host's plain-text fallback runs.
 *
 * The outer gate accepts an EMPTY sidecar so `add_many` / `add` calls
 * (which precede any persisted task) still render via this path. The
 * inner gate decides per-action whether the post-cutoff snapshot is
 * renderable.
 */
export default function renderTaskReplay(ctx: ReplayRenderInput): ReplayRenderResult | undefined {
  const sidecar = ctx.sidecarTasks
  if (sidecar === null) return undefined
  try {
    const cutoff = ctx.callTs ?? null
    const snapshot = snapshotTasksAt(sidecar, cutoff)
    // Empty snapshot at this cutoff is meaningful for add-like actions
    // (the renderer emits an "+ added N tasks" header with no body
    // rows). For every other action, decline : we'd produce a
    // contentless block and the host's content-split says more.
    const action = ctx.input.action
    if (snapshot.length === 0 && action !== "add_many" && action !== "add") return undefined
    const stats = computeStats(snapshot)
    const renderAction = mapInputToRenderAction(ctx.input, stats)
    const views = buildViews(snapshot)
    const now = cutoff !== null ? () => cutoff.getTime() : undefined
    const parts = renderToolDisplay(views, stats, {
      ansi: true,
      action: renderAction,
      ...(now !== undefined ? { now } : {}),
    })
    return {
      displayHeader: parts.header,
      display: parts.body,
      displayFooter: parts.footer,
    }
  } catch {
    // Malformed sidecar / unexpected input: decline, never throw.
    return undefined
  }
}
