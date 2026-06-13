/**
 * Input parsing + validation for the SessionHistory tool. Pure: raw
 * `Record<string, unknown>` in, a typed discriminated union out (or a
 * string error). Keeps the handler free of defensive casts and gives the
 * defaults a single source of truth.
 *
 * @module plugins/session-history/lib/input
 */

export type SessionHistoryRequest =
  | {
      action: "window"
      sid: string
      anchor: "start" | "end"
      offset: number
      limit: number
      previewChars: number | undefined
    }
  | { action: "meta"; sid: string }
  | { action: "list"; query?: string; cwd?: string; offset: number; limit: number | undefined }
  | {
      action: "search"
      sid: string | undefined
      query: string
      offset: number
      limit: number | undefined
      previewChars: number | undefined
    }
  | { action: "tool_calls"; sid: string; tool?: string; offset: number; limit: number | undefined }
  | { action: "blob"; sid: string; toolUseId: string; maxBytes: number | undefined }
  | { action: "dump"; sid: string; format: "markdown" | "xml" }

export type ParseResult = { ok: true; req: SessionHistoryRequest } | { ok: false; error: string }

/** The tool's documented default page size for `window`. */
export const WINDOW_DEFAULT_LIMIT = 10

const ACTIONS = new Set(["window", "meta", "list", "search", "tool_calls", "blob", "dump"])

/**
 * Parse and validate the raw `SessionHistory` tool input into a typed
 * request, defaulting the action to `window` and range-checking every
 * numeric knob.
 */
export function parseInput(input: Record<string, unknown>): ParseResult {
  const action = typeof input.action === "string" ? input.action : "window"
  if (!ACTIONS.has(action)) {
    return {
      ok: false,
      error: `Unknown action ${JSON.stringify(action)}. Use one of: ${[...ACTIONS].join(", ")}.`,
    }
  }

  const sid = str(input.sid) ?? "last"
  const offset = nat(input.offset) ?? 0
  const limit = pos(input.limit)
  const previewChars = pos(input.previewChars)

  switch (action) {
    case "window": {
      const anchor = input.anchor === "start" ? "start" : "end"
      if (input.anchor !== undefined && input.anchor !== "start" && input.anchor !== "end") {
        return { ok: false, error: `anchor must be "start" or "end".` }
      }
      return {
        ok: true,
        req: { action, sid, anchor, offset, limit: limit ?? WINDOW_DEFAULT_LIMIT, previewChars },
      }
    }
    case "meta":
      return { ok: true, req: { action, sid } }
    case "list":
      return {
        ok: true,
        req: { action, query: str(input.query), cwd: str(input.cwd), offset, limit },
      }
    case "search": {
      const query = str(input.query)
      if (!query) return { ok: false, error: `search requires a non-empty "query".` }
      return {
        ok: true,
        req: {
          action,
          sid: str(input.sid), // honest undefined = cross-session search
          query,
          offset,
          limit,
          previewChars,
        },
      }
    }
    case "tool_calls":
      return { ok: true, req: { action, sid, tool: str(input.tool), offset, limit } }
    case "blob": {
      const toolUseId = str(input.toolUseId)
      if (!toolUseId) return { ok: false, error: `blob requires "toolUseId".` }
      return { ok: true, req: { action, sid, toolUseId, maxBytes: pos(input.maxBytes) } }
    }
    case "dump":
      return {
        ok: true,
        req: { action, sid, format: input.format === "xml" ? "xml" : "markdown" },
      }
    default:
      return { ok: false, error: `Unknown action ${JSON.stringify(action)}.` }
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function nat(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined
}

function pos(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.trunc(v) : undefined
}
