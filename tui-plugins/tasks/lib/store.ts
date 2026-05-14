/**
 * Per-session task store. One instance per session, backed by a JSONL
 * file at `~/.minimal-agent/sessions/<sid>.tasks.jsonl`.
 *
 * The store is the only module that touches disk. Everything above it
 * (renderer, handler, attachment) reasons in terms of {@link Task}
 * objects and store-returned views. Below it: {@link parse.ts} is pure
 * (id generation, JSONL).
 *
 * ## Single-doing discipline
 *
 * `start(id)` flips a task to `doing` AND demotes any other top-level
 * `doing` back to `todo`. This keeps the user's progress meter
 * unambiguous: one focus at a time. Override with `{parallel: true}`.
 * Subtask focus is independent of top-level focus (a subtask being
 * `doing` doesn't demote sibling subtasks unless explicitly asked).
 *
 * ## Position numbering
 *
 * Top-level tasks get a 1-indexed `n` re-derived on every read. Subtasks
 * have `n: null` (their position is implied by parent + alpha suffix).
 * Numbers are NOT stored on disk — they shift on reorder/remove.
 *
 * ## Concurrency
 *
 * One writer per session by construction (the session id is unique).
 * Full-rewrite on every mutation is fine: the file is tiny (typical
 * plan is <20 lines, never more than a few hundred).
 *
 * @module tasks/lib/store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import {
  isTaskId,
  isSubtaskId,
  localIsoSeconds,
  newTopLevelId,
  parseFile,
  serializeFile,
  subtaskId,
  type NewTaskInput,
  type Task,
  type TaskStatus,
} from "./parse.ts"

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

/**
 * A task plus the derived display position. Subtasks have `n: null`.
 * The renderer and attachment consume {@link View}, not raw {@link Task}.
 *
 * `ghost` and `diff` are one-shot overlays the handler may attach when
 * it wants the renderer to surface "what just changed" (rather than only
 * the post-state). The store itself never populates them.
 */
export interface View {
  task: Task
  /** 1-indexed display position for top-level tasks; `null` for subtasks. */
  n: number | null
  /** 0-indexed child position for subtasks (used by the renderer to pick `├` vs `╰`). `null` for top-level. */
  childIndex: number | null
  /** Total child count of this task's parent (used by the renderer to detect "last child"). `null` for top-level. */
  siblingCount: number | null
  /**
   * When set, this row is a one-shot "tombstone" for a task that no
   * longer exists in the store (just removed). Rendered with a red `✘`
   * icon and red strikethrough title so the user sees WHAT was removed,
   * not just that something was. The closer's stats still reflect the
   * post-mutation state — the ghost is purely visual.
   */
  ghost?: "removed"
  /**
   * When set, the title column renders as a diff:
   *
   *     <oldTitle struck through red>  →  <newTitle bold>
   *
   * Used by `update` so the user sees WHAT changed, not just the new
   * title. The handler is responsible for skipping this when old===new.
   */
  diff?: { oldTitle: string }
}

/** Counts for the closer line and the attachment header. */
export interface Stats {
  total: number
  done: number
  doing: number
  todo: number
  canceled: number
}

// ---------------------------------------------------------------------------
// Path resolution + injection
// ---------------------------------------------------------------------------

/** Test/integration deps. Defaults read live env. */
export interface StoreDeps {
  /** Override the home directory. */
  home?: string
  /** Override the time source (passed through to {@link localIsoSeconds}). */
  now?: () => Date
  /** Override the RNG used for new top-level ids. */
  rand?: () => Buffer
}

function resolveTasksPath(sid: string, deps: StoreDeps): string {
  const home = deps.home ?? homedir()
  return join(home, ".minimal-agent", "sessions", `${sid}.tasks.jsonl`)
}

/**
 * Pure helper: derive views (with display positions + child-tree
 * metadata) from a flat task list in file order. The handler reuses
 * this to build augmented views from PRE-mutation tasks when a
 * just-removed task needs to be re-injected as a ghost row.
 */
export function buildViews(tasks: readonly Task[]): View[] {
  const out: View[] = []
  let n = 0
  const childrenByParent = new Map<string, Task[]>()
  for (const t of tasks) {
    if (t.parent !== null) {
      const arr = childrenByParent.get(t.parent) ?? []
      arr.push(t)
      childrenByParent.set(t.parent, arr)
    }
  }
  for (const t of tasks) {
    if (t.parent === null) {
      n += 1
      out.push({ task: t, n, childIndex: null, siblingCount: null })
    } else {
      const siblings = childrenByParent.get(t.parent) ?? []
      const childIndex = siblings.indexOf(t)
      out.push({ task: t, n: null, childIndex, siblingCount: siblings.length })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

/**
 * Custom error class for store-level "user gave us a bad reference".
 * Distinguishes from genuine I/O errors so the handler can return a
 * clean tool-result rather than a stack trace.
 */
export class TaskStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TaskStoreError"
  }
}

export class TaskStore {
  readonly path: string
  private readonly deps: StoreDeps

  constructor(sid: string, deps: StoreDeps = {}) {
    if (typeof sid !== "string" || sid.trim().length === 0) {
      throw new TaskStoreError(`TaskStore: sid must be a non-empty string`)
    }
    this.path = resolveTasksPath(sid, deps)
    this.deps = deps
  }

  // -------------------------------------------------------------------------
  // Read paths
  // -------------------------------------------------------------------------

  /** Read all tasks from disk in display order. Returns `[]` if file missing. */
  list(): Task[] {
    if (!existsSync(this.path)) return []
    const content = readFileSync(this.path, "utf8")
    return parseFile(content)
  }

  /**
   * Build views with derived `n` (display position) and child-tree
   * metadata. The renderer and attachment consume this shape.
   *
   * Order: file order (which is display order). Numbers are re-derived
   * (1-indexed across top-level only) on every call.
   */
  views(): View[] {
    return buildViews(this.list())
  }

  /** Aggregate counts for headers. */
  stats(): Stats {
    const tasks = this.list()
    const s: Stats = { total: tasks.length, done: 0, doing: 0, todo: 0, canceled: 0 }
    for (const t of tasks) s[t.status] += 1
    return s
  }

  /**
   * Resolve an id reference into a task. Accepts a bare id, a `#`-prefixed
   * id, or a positive integer (1-indexed top-level position). Returns
   * `null` if no task matches.
   */
  resolve(ref: string | number): Task | null {
    if (typeof ref === "number") {
      if (!Number.isInteger(ref) || ref < 1) return null
      const tops = this.list().filter((t) => t.parent === null)
      return tops[ref - 1] ?? null
    }
    const bare = ref.startsWith("#") ? ref.slice(1) : ref
    // Disambiguation: a 6-hex top-level id OR 7-char subtask id is ALWAYS
    // treated as a hash, even when every character is a digit. This avoids
    // the all-digit-hash trap (~6% of random hashes are six digits and
    // would otherwise be mis-parsed as a position).
    if (isTaskId(bare)) {
      return this.list().find((t) => t.id === bare) ?? null
    }
    // Fall through: pure digit strings of any other length are positions.
    if (/^\d+$/.test(bare)) return this.resolve(Number.parseInt(bare, 10))
    return null
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Append a new task. Returns the created task. The id is freshly
   * generated; for subtasks the parent's children are scanned to pick
   * the next alpha suffix.
   *
   * `after` (top-level only): if set and resolves to a task, the new task
   * is inserted immediately after it instead of at the end. Ignored for
   * subtasks (children are always appended).
   */
  add(input: NewTaskInput, after?: string | number): Task {
    const status: TaskStatus = input.status ?? "todo"
    const created_at = localIsoSeconds(this.deps.now)
    const title = input.title.trim()
    if (title === "") {
      throw new TaskStoreError(`TaskStore.add: title cannot be empty`)
    }

    const tasks = this.list()
    let id: string

    if (input.parent !== undefined && input.parent !== null) {
      const parent = this.findParent(input.parent, tasks)
      // Pick the next alpha suffix from the highest existing suffix + 1
      // (not just "count of children", to keep stable ids after removes).
      const usedSuffixes = tasks
        .filter((t) => t.parent === parent.id && isSubtaskId(t.id))
        .map((t) => t.id.charCodeAt(t.id.length - 1) - "a".charCodeAt(0))
      const nextCounter = usedSuffixes.length === 0 ? 0 : Math.max(...usedSuffixes) + 1
      id = subtaskId(parent.id, nextCounter)
    } else {
      // Top-level: random until collision-free. The id space is 16.7M;
      // a real collision in a session is astronomically unlikely, but
      // tests inject a deterministic RNG that may collide on purpose.
      const usedIds = new Set(tasks.map((t) => t.id))
      let tries = 0
      do {
        id = newTopLevelId(this.deps.rand)
        tries += 1
        if (tries > 100) {
          throw new TaskStoreError(`TaskStore.add: failed to generate a unique id after 100 tries`)
        }
      } while (usedIds.has(id))
    }

    const task: Task = {
      id,
      parent: input.parent ?? null,
      status,
      title,
      created_at,
      done_at: status === "done" ? created_at : null,
      reason: null,
    }

    // Insertion point.
    let insertAt = tasks.length
    if (task.parent === null && after !== undefined) {
      const anchor = this.resolveFrom(after, tasks)
      if (anchor !== null && anchor.parent === null) {
        // Insert after the anchor AND after all of the anchor's existing
        // children, so subtasks stay clustered under their parent.
        const anchorIdx = tasks.indexOf(anchor)
        let lastInBlock = anchorIdx
        for (let i = anchorIdx + 1; i < tasks.length; i++) {
          if (tasks[i].parent === anchor.id) lastInBlock = i
          else if (tasks[i].parent === null) break
        }
        insertAt = lastInBlock + 1
      }
    } else if (task.parent !== null) {
      // Subtask: place right after the last existing sibling, or right
      // after the parent if no siblings yet.
      const parentIdx = tasks.findIndex((t) => t.id === task.parent)
      let lastSiblingIdx = parentIdx
      for (let i = parentIdx + 1; i < tasks.length; i++) {
        if (tasks[i].parent === task.parent) lastSiblingIdx = i
        else if (tasks[i].parent === null) break
      }
      insertAt = lastSiblingIdx + 1
    }

    const next = [...tasks.slice(0, insertAt), task, ...tasks.slice(insertAt)]
    this.writeAll(next)
    return task
  }

  /** Bulk variant of {@link add}. All titles get the same `parent` (if any). */
  addMany(titles: readonly string[], opts: { parent?: string | number } = {}): Task[] {
    const out: Task[] = []
    let parentId: string | null = null
    if (opts.parent !== undefined && opts.parent !== null) {
      const parent = this.resolve(opts.parent)
      if (parent === null) {
        throw new TaskStoreError(`TaskStore.addMany: parent "${opts.parent}" not found`)
      }
      if (parent.parent !== null) {
        throw new TaskStoreError(`TaskStore.addMany: parent "${opts.parent}" is itself a subtask (no nesting beyond depth 1)`)
      }
      parentId = parent.id
    }
    for (const title of titles) {
      out.push(this.add({ title, parent: parentId }))
    }
    return out
  }

  /** Edit a task's title. Returns the updated task or `null` if not found. */
  update(ref: string | number, title: string): Task | null {
    const trimmed = title.trim()
    if (trimmed === "") {
      throw new TaskStoreError(`TaskStore.update: title cannot be empty`)
    }
    const tasks = this.list()
    const idx = tasks.findIndex((t) => t === this.resolveFrom(ref, tasks))
    if (idx < 0) return null
    const updated: Task = { ...tasks[idx], title: trimmed }
    tasks[idx] = updated
    this.writeAll(tasks)
    return updated
  }

  /**
   * Change a task's status. `done_at` is stamped when flipping TO `done`
   * and cleared when flipping AWAY from `done`. `reason` is set only
   * when flipping TO `canceled`.
   */
  setStatus(ref: string | number, status: TaskStatus, reason?: string | null): Task | null {
    const tasks = this.list()
    const target = this.resolveFrom(ref, tasks)
    if (target === null) return null
    const idx = tasks.indexOf(target)
    const now = localIsoSeconds(this.deps.now)

    const next: Task = {
      ...target,
      status,
      done_at: status === "done" ? target.done_at ?? now : null,
      reason: status === "canceled" ? (reason?.trim() || target.reason || null) : null,
    }
    tasks[idx] = next
    this.writeAll(tasks)
    return next
  }

  /**
   * Atomic "start working on this task" — flips it to `doing` AND (by
   * default) demotes any sibling that was already `doing`.
   *
   * Discipline scope:
   *  - target is top-level → demotes other top-level `doing` tasks back to `todo`.
   *  - target is a subtask → demotes other `doing` SIBLINGS (same parent) back to `todo`.
   *  - `parallel: true` skips the demotion step.
   */
  start(ref: string | number, opts: { parallel?: boolean } = {}): Task | null {
    const tasks = this.list()
    const target = this.resolveFrom(ref, tasks)
    if (target === null) return null
    const now = localIsoSeconds(this.deps.now)

    if (!opts.parallel) {
      const scope = target.parent // null for top-level scope, parentId for subtask scope
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]
        if (t.id === target.id) continue
        if (t.parent === scope && t.status === "doing") {
          tasks[i] = { ...t, status: "todo" }
        }
      }
    }

    const idx = tasks.indexOf(target)
    const next: Task = { ...target, status: "doing", done_at: null, reason: null }
    // Re-find idx because `target` is the original; the slice that
    // contains it may have been swapped via the demotion loop above only
    // if the original was already demoted — which is impossible since we
    // skip target via id-equality. So idx is still valid.
    tasks[idx] = next
    this.writeAll(tasks)
    void now // reserved for a future "started_at" field; not on disk yet.
    return next
  }

  /** Shorthand for `setStatus(ref, "done")`. */
  done(ref: string | number): Task | null {
    return this.setStatus(ref, "done")
  }

  /**
   * Remove a task and (cascading) any of its subtasks. Returns the
   * removed tasks (in file order) or `[]` if not found.
   */
  remove(ref: string | number): Task[] {
    const tasks = this.list()
    const target = this.resolveFrom(ref, tasks)
    if (target === null) return []
    const toRemove = new Set<string>([target.id])
    // Cascade subtasks.
    for (const t of tasks) {
      if (t.parent === target.id) toRemove.add(t.id)
    }
    const removed: Task[] = []
    const next: Task[] = []
    for (const t of tasks) {
      if (toRemove.has(t.id)) removed.push(t)
      else next.push(t)
    }
    this.writeAll(next)
    return removed
  }

  /**
   * Reorder TOP-LEVEL tasks. `order` is an array of ids (top-level only)
   * in the desired new order. Tasks not in `order` are appended at the
   * end in their previous relative order. Subtasks ride along with their
   * parent and keep their internal order.
   *
   * Returns the full new task list.
   */
  reorder(order: readonly (string | number)[]): Task[] {
    const tasks = this.list()
    const resolved: string[] = []
    const seen = new Set<string>()
    for (const ref of order) {
      const t = this.resolveFrom(ref, tasks)
      if (t === null) {
        throw new TaskStoreError(`TaskStore.reorder: id "${ref}" not found`)
      }
      if (t.parent !== null) {
        throw new TaskStoreError(`TaskStore.reorder: id "${ref}" is a subtask; reorder operates on top-level tasks only`)
      }
      if (seen.has(t.id)) {
        throw new TaskStoreError(`TaskStore.reorder: duplicate id "${ref}" in order`)
      }
      resolved.push(t.id)
      seen.add(t.id)
    }
    // Group tasks by top-level id (each group: the top-level task + its subtasks in file order).
    const groups = new Map<string, Task[]>()
    let currentTop: string | null = null
    for (const t of tasks) {
      if (t.parent === null) {
        currentTop = t.id
        groups.set(currentTop, [t])
      } else if (currentTop !== null && t.parent === currentTop) {
        groups.get(currentTop)!.push(t)
      } else {
        // Orphaned subtask — shouldn't happen in well-formed files. Drop
        // it into the parent's group if we have one, else leave it
        // attached to the current top (best-effort).
        const arr = groups.get(t.parent) ?? groups.get(currentTop ?? "")
        if (arr !== undefined) arr.push(t)
      }
    }
    // Build the new order: requested ids first, then any top-level ids
    // not mentioned, in their previous relative order.
    const finalIds: string[] = [...resolved]
    for (const id of groups.keys()) {
      if (!seen.has(id)) finalIds.push(id)
    }
    const next: Task[] = []
    for (const id of finalIds) {
      const grp = groups.get(id)
      if (grp) next.push(...grp)
    }
    this.writeAll(next)
    return next
  }

  /**
   * Wipe ALL tasks for this session. If any task is `doing` and
   * `force !== true`, throws to protect against accidental loss of
   * in-flight state.
   */
  clear(force: boolean = false): number {
    const tasks = this.list()
    if (!force && tasks.some((t) => t.status === "doing")) {
      throw new TaskStoreError(`TaskStore.clear: refusing to clear with tasks in "doing" state; pass force: true to override`)
    }
    this.writeAll([])
    return tasks.length
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private findParent(ref: string | number, tasks: readonly Task[]): Task {
    const parent = this.resolveFrom(ref, tasks)
    if (parent === null) {
      throw new TaskStoreError(`TaskStore: parent "${ref}" not found`)
    }
    if (parent.parent !== null) {
      throw new TaskStoreError(`TaskStore: "${ref}" is itself a subtask; depth-2 nesting is not allowed`)
    }
    return parent
  }

  /** Resolve against an already-loaded task list (saves a re-read). */
  private resolveFrom(ref: string | number, tasks: readonly Task[]): Task | null {
    if (typeof ref === "number") {
      if (!Number.isInteger(ref) || ref < 1) return null
      const tops = tasks.filter((t) => t.parent === null)
      return tops[ref - 1] ?? null
    }
    const bare = ref.startsWith("#") ? ref.slice(1) : ref
    // Same disambiguation as `resolve` — hash-shaped strings (6 or 7 chars
    // matching the id regex) win, even when all-digit. See the comment on
    // `resolve` for the rationale (all-digit hashes occur ~6% of the time).
    if (isTaskId(bare)) {
      return tasks.find((t) => t.id === bare) ?? null
    }
    if (/^\d+$/.test(bare)) return this.resolveFrom(Number.parseInt(bare, 10), tasks)
    return null
  }

  private writeAll(tasks: readonly Task[]): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.path, serializeFile(tasks), "utf8")
  }
}
