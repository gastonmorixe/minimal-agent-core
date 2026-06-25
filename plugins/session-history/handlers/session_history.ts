/**
 * `SessionHistory` tool handler — paginated, filterable read access to
 * the recorded transcript of any saved session.
 *
 * Fully decoupled: this module imports NOTHING from the host (`src/...`).
 * Everything it needs arrives through the handler context — the frozen
 * capability host on `ctx.host` (granted namespaces: `sessions:read`,
 * `blobs:read`, declared in ../manifest.json) and the trigger input. The
 * context/host shapes are re-declared locally in `../lib/host-types.ts`
 * (structural typing; see that module's header for the contract).
 *
 * Naming note: this tool is the ARCHIVAL counterpart to `SessionInfo`.
 * SessionInfo = live runtime state of the current run (context %, quota,
 * cost). SessionHistory = what was said and done, in this session's log
 * or any past one.
 *
 * @module plugins/session-history/handlers/session_history
 */

import type { HandlerContextSlice, PluginHostSlice, ToolResultSlice } from "../lib/host-types.ts"
import { parseInput, type SessionHistoryRequest } from "../lib/input.ts"
import {
  renderList,
  renderMeta,
  renderSearch,
  renderToolCalls,
  renderWindow,
} from "../lib/render.ts"

const DUMP_WARN_BYTES = 256 * 1024

/**
 * Tool handler for `SessionHistory`: routes the parsed action (window, meta,
 * list, search, tool_calls, blob, dump) to the session-transcript store and
 * renders the bounded result.
 */
export default async function sessionHistory(ctx: HandlerContextSlice): Promise<ToolResultSlice> {
  if (ctx.trigger.type !== "tool") {
    return err("SessionHistory only runs as a tool call.")
  }
  const host = ctx.host
  if (!host?.sessions) {
    return err(
      "SessionHistory needs the 'sessions:read' capability but the host did not grant it. " +
        "Check the plugin's manifest capabilities.",
    )
  }

  const parsed = parseInput(ctx.trigger.input ?? {})
  if (!parsed.ok) return err(parsed.error)
  const req = parsed.req

  try {
    return await run(req, host, ctx.cwd)
  } catch (e) {
    return err(`SessionHistory failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function run(
  req: SessionHistoryRequest,
  host: PluginHostSlice,
  cwd: string,
): Promise<ToolResultSlice> {
  const sessions = host.sessions
  if (!sessions) return err("sessions:read capability missing.")

  switch (req.action) {
    case "list": {
      const { items, total } = await sessions.list({
        query: req.query,
        cwd: req.cwd,
        limit: req.limit,
        offset: req.offset,
      })
      return ok(renderList(items, total, req.offset), `${total} session(s)`)
    }

    case "meta": {
      const sid = await resolveSid(req.sid, sessions, cwd)
      if (!sid.ok) return err(sid.error)
      const meta = await sessions.meta(sid.sid)
      if (!meta) return err(unknownSid(sid.sid))
      return ok(renderMeta(meta), `meta · ${shortSid(sid.sid)}`)
    }

    case "window": {
      const sid = await resolveSid(req.sid, sessions, cwd)
      if (!sid.ok) return err(sid.error)
      const w = await sessions.window(sid.sid, {
        anchor: req.anchor,
        offset: req.offset,
        limit: req.limit,
        previewChars: req.previewChars,
      })
      if (!w) return err(unknownSid(sid.sid))
      return ok(
        renderWindow(w, req.anchor, req.offset),
        `${shortSid(sid.sid)} · ${w.items.length}/${w.total} records`,
      )
    }

    case "search": {
      // sid undefined = cross-session search; "last" resolves to one sid.
      let sid: string | undefined
      if (req.sid !== undefined) {
        const r = await resolveSid(req.sid, sessions, cwd)
        if (!r.ok) return err(r.error)
        sid = r.sid
      }
      const { hits, total, scannedSessions } = await sessions.search({
        sid,
        query: req.query,
        limit: req.limit,
        offset: req.offset,
        previewChars: req.previewChars,
      })
      return ok(
        renderSearch(hits, total, scannedSessions, req.query, req.offset),
        `${JSON.stringify(req.query)} · ${total} match(es)`,
      )
    }

    case "tool_calls": {
      const sid = await resolveSid(req.sid, sessions, cwd)
      if (!sid.ok) return err(sid.error)
      const r = await sessions.toolCalls(sid.sid, {
        tool: req.tool,
        limit: req.limit,
        offset: req.offset,
      })
      if (!r) return err(unknownSid(sid.sid))
      return ok(
        renderToolCalls(r.hits, r.total, req.offset, req.tool),
        `${r.total} call(s)${req.tool ? ` · ${req.tool}` : ""}`,
      )
    }

    case "blob": {
      const sid = await resolveSid(req.sid, sessions, cwd)
      if (!sid.ok) return err(sid.error)
      const blobs = host.blobs
      if (!blobs) return err("blobs:read capability missing — cannot read raw tool outputs.")
      const blob = await blobs.read(sid.sid, req.toolUseId, { maxBytes: req.maxBytes })
      if (!blob) {
        return err(
          `No blob for tool_use_id ${JSON.stringify(req.toolUseId)} in session ${sid.sid}. ` +
            `Blobs are only written for large tool outputs and may be LRU-evicted.`,
        )
      }
      const head = blob.clipped
        ? `Raw tool output (${blob.bytes} bytes total, CLIPPED to ${blob.text.length} chars; raise maxBytes for more):\n\n`
        : `Raw tool output (${blob.bytes} bytes, complete):\n\n`
      return ok(head + blob.text, `blob · ${blob.bytes}B${blob.clipped ? " (clipped)" : ""}`)
    }

    case "dump": {
      const sid = await resolveSid(req.sid, sessions, cwd)
      if (!sid.ok) return err(sid.error)
      const d = await sessions.dump(sid.sid, { format: req.format })
      if (!d) return err(unknownSid(sid.sid))
      const warn =
        d.bytes > DUMP_WARN_BYTES
          ? `NOTE: this dump is ${Math.round(d.bytes / 1024)} KB — for targeted reads prefer ` +
            `{action:"window"} or {action:"search"}.\n\n`
          : ""
      return ok(warn + d.text, `dump · ${req.format} · ${Math.round(d.bytes / 1024)}KB`)
    }

    default: {
      return err(`Unhandled action: ${JSON.stringify(req satisfies never)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// sid resolution ("last" → newest session for this cwd, else newest overall;
// anything else → unique-prefix match against the index, e.g. "260d72dd")
// ---------------------------------------------------------------------------

type SidResolution = { ok: true; sid: string } | { ok: false; error: string }

async function resolveSid(
  sid: string,
  sessions: NonNullable<PluginHostSlice["sessions"]>,
  cwd: string,
): Promise<SidResolution> {
  if (sid === "last") {
    const inCwd = await sessions.list({ cwd, limit: 1 })
    if (inCwd.items.length > 0) return { ok: true, sid: inCwd.items[0].sid }
    const anywhere = await sessions.list({ limit: 1 })
    if (anywhere.items.length > 0) return { ok: true, sid: anywhere.items[0].sid }
    return { ok: false, error: "No saved sessions found." }
  }

  // Short sid support: resolve a prefix (e.g. "260d72dd") to the full id. An
  // exact full sid is its own unique prefix, so it resolves to itself.
  const { items } = await sessions.list({ query: sid, limit: 200 })
  const needle = sid.toLowerCase()
  const matches = items.filter((e) => e.sid.toLowerCase().startsWith(needle))
  if (matches.length === 1) return { ok: true, sid: matches[0].sid }
  if (matches.length > 1) {
    const exact = matches.find((e) => e.sid.toLowerCase() === needle)
    if (exact) return { ok: true, sid: exact.sid }
    const shown = matches.slice(0, 8).map((e) => e.sid)
    return {
      ok: false,
      error:
        `Ambiguous session id prefix ${JSON.stringify(sid)} — ${matches.length} sessions match: ` +
        `${shown.join(", ")}${matches.length > shown.length ? ", …" : ""}. Use a longer prefix.`,
    }
  }
  // No prefix match in the index — pass through unchanged so the action's own
  // lookup decides (covers files present on disk but missing from the index).
  return { ok: true, sid }
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok(content: string, header: string): ToolResultSlice {
  return { kind: "tool_result", content, displayHeader: header }
}

function err(message: string): ToolResultSlice {
  return { kind: "tool_result", content: message, is_error: true }
}

function unknownSid(sid: string): string {
  return `Unknown session id ${JSON.stringify(sid)} — no transcript file on disk. Use {action:"list"} to see saved sessions.`
}

function shortSid(sid: string): string {
  return sid.length > 8 ? sid.slice(0, 8) : sid
}
