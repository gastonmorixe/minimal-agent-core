/**
 * Pure formatters for the SessionHistory tool — model-facing plain text.
 * No I/O, no host access; every function maps DTOs from the capability
 * host to a compact string. Kept separate from the handler so rendering
 * is unit-testable without a host.
 *
 * Output discipline: every paged response ends with an explicit "next
 * page" hint when more data exists, so the model never has to guess the
 * cursor arithmetic.
 *
 * @module plugins/session-history/lib/render
 */

import type {
  RecordWindow,
  SearchHit,
  SessionIndexEntry,
  SessionMetaView,
  ToolCallHit,
} from "./host-types.ts"

/** Render a paged window of session records with stable indexes. */
export function renderWindow(w: RecordWindow, anchor: "start" | "end", offset: number): string {
  if (w.total === 0) return `Session ${w.sid}: empty (0 records).`
  const lines: string[] = [
    `Session ${w.sid} · records ${w.firstIndex}..${w.lastIndex} of ${w.total} (anchor=${anchor}, offset=${offset})`,
    "",
  ]
  for (const r of w.items) {
    const ts = r.ts ? ` ${r.ts}` : ""
    lines.push(`[#${r.index}]${ts} ${r.summary}`)
    if (r.preview.length > 0) {
      for (const ln of r.preview.split("\n")) lines.push(`    ${ln}`)
      if (r.clipped)
        lines.push(`    … (${r.fullChars} chars total; raise previewChars to see more)`)
    }
  }
  const hint = nextWindowHint(w, anchor, offset)
  if (hint) lines.push("", hint)
  return lines.join("\n")
}

/** Compute the next-page hint for a window, or null at the boundary. */
export function nextWindowHint(
  w: RecordWindow,
  anchor: "start" | "end",
  offset: number,
): string | null {
  const shown = w.items.length
  if (anchor === "end") {
    const consumed = offset + shown
    if (consumed >= w.total) return null
    return `Older records exist: call again with {anchor:"end", offset:${consumed}}.`
  }
  const consumed = offset + shown
  if (consumed >= w.total) return null
  return `More records exist: call again with {anchor:"start", offset:${consumed}}.`
}

/** Render a one-session summary (model, cwd, counts, liveness, blobs). */
export function renderMeta(m: SessionMetaView): string {
  const counts = Object.entries(m.counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")
  const live =
    m.liveness.status === "live"
      ? `live (pid ${m.liveness.pid ?? "?"}${m.liveness.since ? ` since ${m.liveness.since}` : ""})`
      : `${m.liveness.status}${m.liveness.reason ? ` (${m.liveness.reason})` : ""}`
  return [
    `Session: ${m.sid}`,
    m.parentSid ? `Forked from: ${m.parentSid}` : null,
    `Created: ${m.createdAt ?? "(unknown)"} · last activity: ${m.lastActivity ?? "(unknown)"}`,
    `Model: ${m.model ?? "(unknown)"} · agent ${m.agentVersion ?? "?"}`,
    `CWD: ${m.cwd ?? "(unknown)"}`,
    `Agent process: ${live}`,
    `Records: ${m.recordCount} (${counts})`,
    `First prompt: ${m.firstPrompt ?? "(none)"}`,
    `Sidecars: tasks=${m.hasTasks ? "yes" : "no"} scratch=${m.hasScratch ? "yes" : "no"} blobs=${m.blobCount}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n")
}

/** Render the saved-sessions index, newest first, with paging hints. */
export function renderList(
  items: readonly SessionIndexEntry[],
  total: number,
  offset: number,
): string {
  if (total === 0) return "No saved sessions match."
  const lines = [`Sessions ${offset + 1}..${offset + items.length} of ${total} (newest first):`, ""]
  for (const e of items) {
    lines.push(`${e.sid}  ${e.createdAt}  ${e.model}  ${e.cwd}`)
  }
  if (offset + items.length < total) {
    lines.push("", `More exist: call again with {action:"list", offset:${offset + items.length}}.`)
  }
  return lines.join("\n")
}

/** Render tool-invocation hits (tool, input preview, record index). */
export function renderToolCalls(
  hits: readonly ToolCallHit[],
  total: number,
  offset: number,
  tool: string | undefined,
): string {
  const what = tool ? `'${tool}' calls` : "tool calls"
  if (total === 0) return `No ${what} recorded.`
  const lines = [`${what}: showing ${hits.length} of ${total} (newest first, offset ${offset})`, ""]
  for (const h of hits) {
    lines.push(
      `[#${h.index}]${h.ts ? ` ${h.ts}` : ""} ${h.tool}${h.toolUseId ? ` (${h.toolUseId})` : ""}`,
    )
    lines.push(`    ${h.inputPreview}`)
  }
  if (offset + hits.length < total) {
    lines.push("", `More exist: call again with {offset:${offset + hits.length}}.`)
  }
  return lines.join("\n")
}

/** Render text-search hits with per-record previews and counts. */
export function renderSearch(
  hits: readonly SearchHit[],
  total: number,
  scanned: number,
  query: string,
  offset: number,
): string {
  if (total === 0) return `No matches for ${JSON.stringify(query)} (scanned ${scanned} session(s)).`
  // The query and count live in the TUI displayHeader now — start directly
  // with the hits. See handler's `displayHeader` for the search case.
  const lines: string[] = []
  for (const h of hits) {
    lines.push(`${h.sid} [#${h.index}]${h.ts ? ` ${h.ts}` : ""} (${h.kind})`)
    lines.push(`    ${h.preview}`)
  }
  if (offset + hits.length < total) {
    lines.push("", `More exist: call again with {offset:${offset + hits.length}}.`)
  }
  return lines.join("\n")
}
