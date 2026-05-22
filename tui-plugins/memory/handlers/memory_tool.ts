/**
 * `MemoryTool`: the model-facing CRUD tool for saved memories.
 *
 * Companion to the inline-tag save path (`<tui::memory>`). The tag remains
 * the preferred way for the model to save mid-response (low-friction,
 * doesn't interrupt prose); this tool handles every other operation:
 *
 *   - `list`  : show entries in a scope, paginated, with truncated bodies.
 *   - `read`  : fetch a single bullet by id, full body.
 *   - `add`   : append a new bullet (symmetric with the inline tag).
 *   - `edit`  : replace a bullet's body by id (timestamp bumps).
 *   - `remove`: drop a bullet by id.
 *   - `clear` : wipe a scope. Refused for `global` / `project` (footgun);
 *                only `short-term` allowed.
 *
 * Why a structured tool: once the model wants to mutate or browse memory,
 * it needs structured I/O (an id to act on, a list to choose from). The
 * inline tag is a fire-and-forget channel. The tool is the conversation
 * channel. PROMPT.md teaches the split.
 *
 * ## Pagination contract for `list`
 *
 * To keep tool results small (memories may number in the hundreds), the
 * `list` action ALWAYS paginates:
 *
 *   - `limit` : page size. Default {@link DEFAULT_LIST_LIMIT}, max
 *                {@link MAX_LIST_LIMIT}.
 *   - `offset`: number of entries to skip, counted from the most-recent
 *                end (i.e. offset=0 returns the newest page). Default 0.
 *
 * The result header always reports `total`, the slice's `offset`, and
 * when a next page exists, a paste-ready `next: MemoryTool({…})` hint.
 * Bodies in list results are clipped to {@link LIST_PREVIEW_MAX} chars;
 * full bodies are recovered via `read`.
 *
 * Note on `add`: the tool returns the new id directly in `tool_result`, so
 * we deliberately do NOT also emit `memory.saved` on the bus: otherwise
 * the model would see the id twice (tool result + next-turn `<memory-saved>`
 * echo) which reads as "did I save twice?". The inline-tag handler emits
 * because it has no other way to surface the id. The tool doesn't need it.
 *
 * @module memory/handlers/memory_tool
 */

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"

import {
  bulletsToJson,
  bulletToJson,
  formatAdded,
  formatCleared,
  formatEdited,
  formatList,
  formatRead,
  formatRemoved,
  LIST_PREVIEW_MAX,
} from "../lib/format.ts"
import type { Bullet } from "../lib/parse.ts"
import { MemoryStore, type StoreKind } from "../lib/store.ts"

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Default page size when `limit` is not provided on a `list` call.
 *
 * Picked at 20 to balance "useful slice of recent activity" against
 * "doesn't flood the model's context on every browsing call". The model
 * pages backward with `offset` for older entries.
 */
export const DEFAULT_LIST_LIMIT = 20

/**
 * Hard ceiling on a single page. Larger values are clamped down with a
 * warning embedded in the header. Keeps a malformed or runaway call
 * from synthesizing a multi-MB tool result.
 */
export const MAX_LIST_LIMIT = 100

// Re-export the body preview ceiling so PROMPT.md and tests have a
// single source of truth.
export { LIST_PREVIEW_MAX }

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set(["list", "read", "add", "edit", "remove", "clear"])
const VALID_SCOPES = new Set<StoreKind>(["global", "project", "short-term"])
const VALID_FORMATS = new Set(["text", "json"])

type Action = "list" | "read" | "add" | "edit" | "remove" | "clear"

interface ParsedInput {
  action: Action
  scope: StoreKind
  id?: string
  body?: string
  query?: string
  limit?: number
  offset?: number
  format: "text" | "json"
}

interface ValidationOk {
  ok: true
  value: ParsedInput
}
interface ValidationError {
  ok: false
  error: string
}
type Validation = ValidationOk | ValidationError

function validateInput(raw: Record<string, unknown>): Validation {
  if (typeof raw.action !== "string" || !VALID_ACTIONS.has(raw.action)) {
    return {
      ok: false,
      error: `\`action\` must be one of: ${[...VALID_ACTIONS].join(", ")}`,
    }
  }
  const action = raw.action as Action

  if (typeof raw.scope !== "string" || !VALID_SCOPES.has(raw.scope as StoreKind)) {
    return {
      ok: false,
      error: `\`scope\` must be one of: ${[...VALID_SCOPES].join(", ")}`,
    }
  }
  const scope = raw.scope as StoreKind

  // Per-action required fields.
  let id: string | undefined
  if (action === "read" || action === "edit" || action === "remove") {
    if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
      return { ok: false, error: `\`id\` is required for action="${action}"` }
    }
    id = raw.id.trim()
  } else if (raw.id !== undefined) {
    return { ok: false, error: `\`id\` is not used for action="${action}"` }
  }

  let body: string | undefined
  if (action === "add" || action === "edit") {
    if (typeof raw.body !== "string" || raw.body.trim().length === 0) {
      return { ok: false, error: `\`body\` is required for action="${action}"` }
    }
    body = raw.body
  } else if (raw.body !== undefined) {
    return { ok: false, error: `\`body\` is not used for action="${action}"` }
  }

  let query: string | undefined
  if (raw.query !== undefined) {
    if (typeof raw.query !== "string") {
      return { ok: false, error: "`query` must be a string" }
    }
    if (action !== "list") {
      return { ok: false, error: `\`query\` is only valid for action="list"` }
    }
    query = raw.query
  }

  let limit: number | undefined
  if (raw.limit !== undefined) {
    if (
      typeof raw.limit !== "number" ||
      !Number.isFinite(raw.limit) ||
      !Number.isInteger(raw.limit) ||
      raw.limit < 1
    ) {
      return { ok: false, error: "`limit` must be a positive integer" }
    }
    if (action !== "list") {
      return { ok: false, error: `\`limit\` is only valid for action="list"` }
    }
    limit = Math.floor(raw.limit)
  }

  let offset: number | undefined
  if (raw.offset !== undefined) {
    if (
      typeof raw.offset !== "number" ||
      !Number.isFinite(raw.offset) ||
      !Number.isInteger(raw.offset) ||
      raw.offset < 0
    ) {
      return { ok: false, error: "`offset` must be a non-negative integer" }
    }
    if (action !== "list") {
      return { ok: false, error: `\`offset\` is only valid for action="list"` }
    }
    offset = Math.floor(raw.offset)
  }

  let format: "text" | "json" = "text"
  if (raw.format !== undefined) {
    if (typeof raw.format !== "string" || !VALID_FORMATS.has(raw.format)) {
      return { ok: false, error: `\`format\` must be one of: ${[...VALID_FORMATS].join(", ")}` }
    }
    format = raw.format as "text" | "json"
  }

  return { ok: true, value: { action, scope, id, body, query, limit, offset, format } }
}

// ---------------------------------------------------------------------------
// Store factory (mirrors handlers/memory.ts logic)
// ---------------------------------------------------------------------------

function makeStore(
  scope: StoreKind,
  cwd: string,
  sid: string | null,
  envHome: string | undefined,
): MemoryStore | null {
  const deps = envHome ? { home: envHome } : undefined
  if (scope === "global") return MemoryStore.global({ ...deps, sid })
  if (scope === "project") return MemoryStore.project(cwd, { ...deps, sid })
  if (scope === "short-term") {
    if (!sid) return null
    return MemoryStore.shortTerm(sid, deps)
  }
  return null
}

// ---------------------------------------------------------------------------
// Default export: tool dispatch
// ---------------------------------------------------------------------------

export default async function memoryToolHandler(
  ctx: TUIContext,
): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return {
      kind: "tool_result",
      content: "MemoryTool: wrong trigger type",
      is_error: true,
    }
  }

  const v = validateInput(ctx.trigger.input)
  if (!v.ok) {
    return { kind: "tool_result", content: `MemoryTool: ${v.error}`, is_error: true }
  }
  const { action, scope, id, body, query, limit, offset, format } = v.value

  const sid = ctx.env.MINIMAL_AGENT_SESSION_ID?.trim() || null
  const store = makeStore(scope, ctx.cwd, sid, ctx.env.HOME)
  if (store === null) {
    return {
      kind: "tool_result",
      content:
        `MemoryTool: scope="short-term" requires a session id, but none is plumbed through ` +
        `(MINIMAL_AGENT_SESSION_ID is empty).`,
      is_error: true,
    }
  }

  // Defensive: never let a memory write mutate the shipped plugin tree.
  if (store.path.startsWith(`${ctx.packageDir}/`)) {
    return {
      kind: "tool_result",
      content: `MemoryTool: refused write under packageDir (${store.path})`,
      is_error: true,
    }
  }

  try {
    switch (action) {
      case "list":
        return doList(store, scope, query, limit, offset, format)
      case "read":
        return doRead(store, scope, id!, format)
      case "add":
        return doAdd(store, scope, body!, format)
      case "edit":
        return doEdit(store, scope, id!, body!, format)
      case "remove":
        return doRemove(store, scope, id!, format)
      case "clear":
        return doClear(store, scope, format)
      default: {
        // Exhaustiveness check: `action` is narrowed to `never` once every
        // case is handled. If a new action is added to the union without a
        // case here, this throws at runtime AND fails the typecheck.
        const _exhaustive: never = action
        return {
          kind: "tool_result",
          content: `MemoryTool: unhandled action ${String(_exhaustive)}`,
          is_error: true,
        }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { kind: "tool_result", content: `MemoryTool: ${msg}`, is_error: true }
  }
}

// ---------------------------------------------------------------------------
// Pagination helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Slice the most-recent page from a list of bullets in source order
 * (oldest first, newest last).
 *
 * Semantics: `offset` is measured FROM THE NEWEST END.
 *   - offset=0, limit=20 → the last 20 entries (most recent page).
 *   - offset=20, limit=20 → the 20 entries before that.
 *   - offset >= total → empty page.
 *
 * Within the returned slice we preserve source order: the page reads
 * top-to-bottom as oldest→newest, matching how the model reads files
 * generally. Pagination still walks backward through history.
 *
 * Pure function. Exported for unit tests.
 */
export function paginateNewestFirst<T>(
  items: readonly T[],
  offset: number,
  limit: number,
): { slice: T[]; nextOffset: number | null } {
  const total = items.length
  const o = Math.max(0, Math.floor(offset))
  const l = Math.max(1, Math.floor(limit))
  const end = Math.max(0, total - o)
  const start = Math.max(0, end - l)
  const slice = items.slice(start, end)
  const nextOffset = start > 0 ? o + l : null
  return { slice, nextOffset }
}

/**
 * Clamp a user-provided limit into the supported range, returning the
 * effective value alongside whether clamping occurred. Used to surface
 * a warning in the header when a model passes `limit: 5000`.
 */
function resolveLimit(rawLimit: number | undefined): {
  effective: number
  wasClamped: boolean
} {
  if (rawLimit === undefined) {
    return { effective: DEFAULT_LIST_LIMIT, wasClamped: false }
  }
  if (rawLimit > MAX_LIST_LIMIT) {
    return { effective: MAX_LIST_LIMIT, wasClamped: true }
  }
  return { effective: rawLimit, wasClamped: false }
}

// ---------------------------------------------------------------------------
// Per-action implementations
// ---------------------------------------------------------------------------

function doList(
  store: MemoryStore,
  scope: StoreKind,
  query: string | undefined,
  rawLimit: number | undefined,
  rawOffset: number | undefined,
  format: "text" | "json",
): TUIResult {
  const all = store.list()
  const filtered: Bullet[] = query
    ? all.filter((b) => b.body.toLowerCase().includes(query.toLowerCase()))
    : all

  const { effective: limit, wasClamped } = resolveLimit(rawLimit)
  const offset = Math.max(0, rawOffset ?? 0)
  const { slice: sliced, nextOffset } = paginateNewestFirst(filtered, offset, limit)

  const formatOpts = {
    scope,
    total: filtered.length,
    offset,
    limit,
    nextOffset,
    query,
  }

  const display = formatList(sliced, { ...formatOpts, ansi: true })
  const content =
    format === "json"
      ? JSON.stringify(
          {
            scope,
            total: filtered.length,
            shown: sliced.length,
            offset,
            limit,
            next_offset: nextOffset,
            query: query ?? null,
            ...(wasClamped ? { limit_clamped_from: rawLimit, limit_max: MAX_LIST_LIMIT } : {}),
            bullets: bulletsToJson(sliced),
          },
          null,
          2,
        )
      : formatList(sliced, { ...formatOpts, ansi: false }) +
        (wasClamped ? `  note: limit clamped to ${MAX_LIST_LIMIT}\n` : "")
  return { kind: "tool_result", content, display }
}

function doRead(
  store: MemoryStore,
  scope: StoreKind,
  id: string,
  format: "text" | "json",
): TUIResult {
  const b = store.read(id)
  if (b === null) {
    return {
      kind: "tool_result",
      content: `MemoryTool: no bullet with id="${id}" in scope="${scope}"`,
      is_error: true,
    }
  }
  const display = formatRead(b, scope, true)
  if (format === "json") {
    return {
      kind: "tool_result",
      content: JSON.stringify({ scope, bullet: bulletToJson(b) }, null, 2),
      display,
    }
  }
  return { kind: "tool_result", content: formatRead(b, scope, false), display }
}

function doAdd(
  store: MemoryStore,
  scope: StoreKind,
  body: string,
  format: "text" | "json",
): TUIResult {
  const { bullet, evicted } = store.add(body)
  const display = formatAdded(bullet, scope, evicted.length, true)
  if (format === "json") {
    return {
      kind: "tool_result",
      content: JSON.stringify(
        {
          scope,
          id: bullet.id,
          ts: bullet.ts,
          evicted: evicted.length,
        },
        null,
        2,
      ),
      display,
    }
  }
  return {
    kind: "tool_result",
    content: formatAdded(bullet, scope, evicted.length, false),
    display,
  }
}

function doEdit(
  store: MemoryStore,
  scope: StoreKind,
  id: string,
  body: string,
  format: "text" | "json",
): TUIResult {
  const updated = store.edit(id, body)
  if (updated === null) {
    return {
      kind: "tool_result",
      content: `MemoryTool: no bullet with id="${id}" in scope="${scope}"`,
      is_error: true,
    }
  }
  const display = formatEdited(updated, scope, true)
  if (format === "json") {
    return {
      kind: "tool_result",
      content: JSON.stringify({ scope, bullet: bulletToJson(updated) }, null, 2),
      display,
    }
  }
  return { kind: "tool_result", content: formatEdited(updated, scope, false), display }
}

function doRemove(
  store: MemoryStore,
  scope: StoreKind,
  id: string,
  format: "text" | "json",
): TUIResult {
  const removed = store.remove(id)
  if (removed === null) {
    return {
      kind: "tool_result",
      content: `MemoryTool: no bullet with id="${id}" in scope="${scope}"`,
      is_error: true,
    }
  }
  const display = formatRemoved(removed, scope, true)
  if (format === "json") {
    return {
      kind: "tool_result",
      content: JSON.stringify({ scope, removed: bulletToJson(removed) }, null, 2),
      display,
    }
  }
  return {
    kind: "tool_result",
    content: formatRemoved(removed, scope, false),
    display,
  }
}

function doClear(
  store: MemoryStore,
  scope: StoreKind,
  format: "text" | "json",
): TUIResult {
  // Store.clear() throws for global/project. Convert to a clean error.
  if (scope !== "short-term") {
    return {
      kind: "tool_result",
      content:
        `MemoryTool: clear is only allowed for scope="short-term" (refused to wipe ${scope}). ` +
        `Use repeated remove(id) for persistent scopes.`,
      is_error: true,
    }
  }
  const count = store.clear()
  const display = formatCleared(count, scope, true)
  if (format === "json") {
    return {
      kind: "tool_result",
      content: JSON.stringify({ scope, cleared: count }, null, 2),
      display,
    }
  }
  return { kind: "tool_result", content: formatCleared(count, scope, false), display }
}
