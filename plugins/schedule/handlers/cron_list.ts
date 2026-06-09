/**
 * `CronList` tool — list all scheduled tasks for this session.
 *
 * Model-facing `content` is ANSI-free (formatList); the TUI `display` is the
 * colored row set (the host draws the box + manifest icon around it).
 *
 * @module schedule/handlers/cron_list
 */

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"
import { coloredEntryLine } from "../lib/box.ts"
import { formatList } from "../lib/format.ts"
import { cronStoreForSession } from "../lib/store.ts"

export default async function cronList(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.env.MINIMAL_AGENT_DISABLE_CRON === "1") {
    return {
      kind: "tool_result",
      content: "Scheduling is disabled (MINIMAL_AGENT_DISABLE_CRON=1).",
    }
  }
  const sid = ctx.agent?.sessionId
  if (!sid) return { kind: "tool_result", content: "Scheduling requires an active session id." }

  const now = Date.now()
  const entries = cronStoreForSession(sid, ctx.env).load()
  const content = formatList(entries, now)

  if (entries.length === 0) {
    return { kind: "tool_result", content: content.join("\n"), display: "no scheduled tasks" }
  }

  const sorted = entries.slice().sort((a, b) => a.createdAt - b.createdAt)
  const rows = sorted.map((e) => coloredEntryLine(e, now))
  return {
    kind: "tool_result",
    content: content.join("\n"),
    display: ["", ...rows, ""].join("\n"),
    displayHeader: `${entries.length} task${entries.length === 1 ? "" : "s"}`,
  }
}
