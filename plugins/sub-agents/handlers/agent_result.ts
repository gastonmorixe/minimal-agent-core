/**
 * `AgentResult` — pull a finished worker's distilled deliverable. This is the
 * ONLY tool that carries real worker content into the lead's context, and it
 * is bounded (the worker's result sentinel, not its transcript). When a worker
 * exited without a sentinel, fall back to a short tail of its stdout log so the
 * lead still gets something.
 *
 * @module sub-agents/handlers/agent_result
 */

import { existsSync, readFileSync } from "node:fs"

import type { TUIContext, TUIResult } from "@minimal-agent/plugin-api/types/plugin"

import { resultText } from "../lib/content.ts"
import { sessionsDirFromCtx, storeFromCtx } from "../lib/handler-deps.ts"
import { renderResultDisplay } from "../lib/render.ts"
import { parseIdArg } from "../lib/validate.ts"

/** Strip ANSI and return the last `n` non-empty lines of a worker log. */
function tailLog(path: string, n: number): string | null {
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, "utf-8").replace(/\x1b\[[0-9;]*m/g, "")
    const lines = text
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
    if (lines.length === 0) return null
    return lines.slice(-n).join("\n")
  } catch {
    return null
  }
}

/**
 * Tool handler for `AgentResult`: pulls a finished worker's distilled
 * deliverable (summary + artifacts, or salvaged findings) into the lead's
 * context.
 */
export default async function agentResult(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "AgentResult: unexpected trigger", is_error: true }
  }
  const id = parseIdArg(ctx.trigger.input)
  if (!id)
    return { kind: "tool_result", content: "AgentResult: an `id` is required.", is_error: true }

  const store = storeFromCtx(ctx)
  if (!store)
    return { kind: "tool_result", content: "AgentResult: no session id available.", is_error: true }
  const rec = store.get(id)
  if (!rec)
    return {
      kind: "tool_result",
      content: `AgentResult: unknown sub-agent "${id}".`,
      is_error: true,
    }

  let content = resultText(rec)
  // Surface the worker's log tail whenever the lead would otherwise be blind:
  //   - a `done` worker whose summary is the legacy "no summary captured"
  //     placeholder, OR
  //   - any `failed`/`incomplete` worker (FIX B). A crashed or silent worker's
  //     only forensic trail is its stdout/stderr; without this the lead has to
  //     know to go read `<sid>.log` by hand (exactly the trap that hid the boot
  //     crash). The tail is bounded and stripped of ANSI.
  const blindDone =
    rec.status.kind === "done" && rec.status.result.short.includes("no summary captured")
  const blindTerminal = rec.status.kind === "failed" || rec.status.kind === "incomplete"
  if (blindDone || blindTerminal) {
    const tail = tailLog(`${sessionsDirFromCtx(ctx)}/${rec.sid}.log`, 20)
    if (tail) content += `\n\nLast output (log tail — the worker's stdout/stderr):\n${tail}`
  }
  const disp = renderResultDisplay(rec, true)
  return {
    kind: "tool_result",
    content,
    displayHeader: disp.header,
    display: disp.body,
    displayFooter: disp.footer,
  }
}
