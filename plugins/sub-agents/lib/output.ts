/**
 * Bounded "what is this worker doing" tail, derived from its session JSONL.
 * Powers the `AgentOutput` tool: a small, recent window of the worker's
 * activity (tool calls + text snippets with timestamps), never the whole
 * transcript. Pure (text in, lines out).
 *
 * @module sub-agents/lib/output
 */

interface MaybeBlock {
  type?: string
  name?: string
  text?: string
  input?: Record<string, unknown>
}

function firstArg(input: Record<string, unknown> | undefined): string {
  const o = input ?? {}
  const v =
    (typeof o.command === "string" && o.command) ||
    (typeof o.file_path === "string" && o.file_path) ||
    (typeof o.path === "string" && o.path) ||
    (typeof o.pattern === "string" && o.pattern) ||
    (typeof o.query === "string" && o.query) ||
    ""
  return (v || "").replace(/\s+/g, " ").trim()
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

/**
 * Return the last `maxEvents` human-readable activity lines from a worker's
 * JSONL transcript: `HH:MM:SS → Tool: arg` for tool calls, `HH:MM:SS · text`
 * for assistant prose. Tolerant of blank/corrupt lines.
 */
export function transcriptTail(jsonlText: string, maxEvents = 14): string[] {
  const events: string[] = []
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let rec: { kind?: string; ts?: string; content?: unknown }
    try {
      rec = JSON.parse(trimmed)
    } catch {
      continue
    }
    const ts = typeof rec.ts === "string" && rec.ts.length >= 19 ? rec.ts.slice(11, 19) : "--:--:--"
    if (rec.kind === "assistant" && Array.isArray(rec.content)) {
      for (const b of rec.content as MaybeBlock[]) {
        if (b?.type === "tool_use") {
          const arg = firstArg(b.input)
          events.push(`${ts} → ${b.name ?? "tool"}${arg ? `: ${clip(arg, 56)}` : ""}`)
        } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) {
          events.push(`${ts} · ${clip(b.text, 72)}`)
        }
      }
    }
  }
  return events.slice(-maxEvents)
}
