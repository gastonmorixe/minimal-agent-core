/**
 * `AgentOutput` — a bounded tail of a worker's live activity (recent tool calls
 * + text), derived from its session transcript. For "what is A2 doing right
 * now" beyond the one-line widget. Never dumps the whole transcript.
 *
 * @module sub-agents/handlers/agent_output
 */

import { existsSync, readFileSync } from "node:fs"

import type { TUIContext, TUIResult } from "@minimal-agent/plugin-api/types/plugin"

import { statusDetail } from "../lib/content.ts"
import { sessionsDirFromCtx, storeFromCtx } from "../lib/handler-deps.ts"
import { transcriptTail } from "../lib/output.ts"
import { ANSI, color, GLYPHS } from "../lib/style.ts"
import { parseIdArg } from "../lib/validate.ts"

/**
 * Tool handler for `AgentOutput`: tails a worker's recent activity (latest
 * tool calls and notes with timestamps), bounded, never the full transcript.
 */
export default async function agentOutput(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "AgentOutput: unexpected trigger", is_error: true }
  }
  const id = parseIdArg(ctx.trigger.input)
  if (!id)
    return { kind: "tool_result", content: "AgentOutput: an `id` is required.", is_error: true }

  const store = storeFromCtx(ctx)
  if (!store)
    return { kind: "tool_result", content: "AgentOutput: no session id available.", is_error: true }
  const rec = store.get(id)
  if (!rec)
    return {
      kind: "tool_result",
      content: `AgentOutput: unknown sub-agent "${id}".`,
      is_error: true,
    }

  const path = `${sessionsDirFromCtx(ctx)}/${rec.sid}.jsonl`
  const tail = existsSync(path) ? transcriptTail(readFileSync(path, "utf-8")) : []
  const now = Date.now()
  const content =
    tail.length > 0
      ? `${statusDetail(rec, now)}\n\nRecent activity:\n${tail.join("\n")}`
      : `${statusDetail(rec, now)}\n\n(no activity captured yet)`

  const header = `${color(true, ANSI.SKY, "↳")} ${color(true, ANSI.BOLD, rec.id)} ${color(true, ANSI.DIM, GLYPHS.bullet)} ${color(true, ANSI.LGRAY, rec.label)}`
  return {
    kind: "tool_result",
    content,
    displayHeader: header,
    display:
      tail.length > 0
        ? tail.map((l) => color(true, ANSI.DGRAY, l)).join("\n")
        : color(true, ANSI.DIM, "(no activity yet)"),
  }
}
