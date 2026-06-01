/**
 * `/schedule` command — schedule by raw cron, or list / cancel tasks.
 *
 *   /schedule "0 9 * * 1-5" run the morning report
 *   /schedule list
 *   /schedule cancel <id>
 *   /schedule                       → usage
 *
 * Deterministic: writes to the same store the Cron* tools use and returns a
 * colored boxed scrollback notice (no model turn). The heartbeat fires due
 * tasks between turns.
 *
 * @module schedule/handlers/cmd_schedule
 */

import type { CommandContext, CommandResult } from "../../../src/plugins/types.ts"
import { coloredEntryLine, renderBox } from "../lib/box.ts"
import { isValidCron } from "../lib/cron.ts"
import { clockHHMMSS, GLYPH_TIME, kindGlyph, taskFooter, taskInfo, wrapText } from "../lib/format.ts"
import { parseScheduleArgs } from "../lib/loop-parse.ts"
import { cronStoreForSession } from "../lib/store.ts"

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

export default async function cmdSchedule(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.env.MINIMAL_AGENT_DISABLE_CRON === "1") {
    return { kind: "error", message: "scheduling is disabled (MINIMAL_AGENT_DISABLE_CRON=1)" }
  }
  const sid = ctx.agent?.sessionId
  if (!sid) return { kind: "error", message: "scheduling requires an active session" }

  const store = cronStoreForSession(sid, ctx.env)
  const now = Date.now()
  const action = parseScheduleArgs(ctx.argv)

  switch (action.kind) {
    case "usage":
      return {
        kind: "notice",
        lines: [
          `${DIM}usage:${RESET} /schedule "<cron>" <prompt>   schedule a recurring prompt`,
          `${DIM}       /schedule list${RESET}                list scheduled tasks`,
          `${DIM}       /schedule cancel <id>${RESET}         cancel a task`,
        ],
      }

    case "list": {
      const entries = store.load()
      if (entries.length === 0) {
        return {
          kind: "notice",
          lines: renderBox({ icon: GLYPH_TIME, title: "schedule", info: "no tasks", body: [] }),
        }
      }
      const sorted = entries.slice().sort((a, b) => a.createdAt - b.createdAt)
      return {
        kind: "notice",
        lines: renderBox({
          icon: GLYPH_TIME,
          title: "schedule",
          info: `${entries.length} task${entries.length === 1 ? "" : "s"}`,
          timestamp: clockHHMMSS(now),
          body: sorted.map((e) => coloredEntryLine(e, now)),
          footer: "cancel /schedule cancel <id>",
        }),
      }
    }

    case "cancel": {
      const ok = store.delete(action.id ?? "")
      return ok
        ? { kind: "notice", lines: [`${DIM}✓ canceled ${action.id}${RESET}`] }
        : { kind: "error", message: `no scheduled task with id "${action.id}"` }
    }

    case "create": {
      const cron = action.cron ?? ""
      if (!isValidCron(cron)) {
        return { kind: "error", message: `invalid cron expression: "${cron}"` }
      }
      const res = store.create(
        { cron, prompt: action.prompt ?? "", recurs: true, source: "schedule" },
        now,
      )
      if (!res.ok) return { kind: "error", message: res.error }
      const e = res.value
      return {
        kind: "notice",
        lines: renderBox({
          icon: kindGlyph(e),
          title: "schedule",
          info: taskInfo(e, now),
          timestamp: clockHHMMSS(now),
          body: wrapText(e.prompt, 72),
          footer: taskFooter(e, now),
        }),
      }
    }

    case "error":
      return { kind: "error", message: action.message ?? "invalid /schedule usage" }

    default: {
      const _exhaustive: never = action
      return { kind: "error", message: `unhandled: ${JSON.stringify(_exhaustive)}` }
    }
  }
}
