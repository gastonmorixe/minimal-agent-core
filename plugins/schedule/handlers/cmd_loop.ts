/**
 * `/loop` command — run a prompt on repeat while the session is open.
 *
 *   /loop 10s tail the deploy   → SUB-MINUTE: dynamic pace, re-arms every 10s
 *   /loop 5m check the deploy   → fixed-interval recurring loop (cron)
 *   /loop check CI then fix it  → self-paced loop (default cadence; the
 *                                 model can re-arm; first fire ~1 min)
 *   /loop 20m /review-pr 1234   → re-run another command each iteration
 *   /loop                       → the maintenance prompt (or .claude/loop.md)
 *   /loop 15m                   → maintenance prompt on a fixed interval
 *
 * Deterministic: it writes the task to the same store the Cron* tools use
 * and returns a semantic scrollback notice block (no model turn). The
 * heartbeat injects the prompt when due.
 *
 * @module schedule/handlers/cmd_loop
 */

import type { CommandContext, CommandResult } from "@minimal-agent/plugin-api/types/plugin"
import { ansiStyle as c } from "@minimal-agent/plugin-api/utils/ansi"

import { clockHHMMSS, GLYPH_LOOP, taskFooter, taskInfo, wrapText } from "../lib/format.ts"
import { intervalToCron, parseDurationMs } from "../lib/interval.ts"
import { resolveLoopPrompt } from "../lib/loop-md.ts"
import { parseLoopArgs } from "../lib/loop-parse.ts"
import { type CronCreateInput, cronStoreForSession } from "../lib/store.ts"

/** First fire for a self-paced loop (so it starts promptly, not in 5m). */
const DYNAMIC_FIRST_MS = 60_000
/** Cron's floor: intervals shorter than this can't be expressed as cron. */
const MIN_CRON_MS = 60_000

/**
 * Command handler for `/loop`: parses the optional interval and prompt and
 * registers a recurring task (or the built-in maintenance loop) in the
 * session cron store.
 */
export default async function cmdLoop(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.env.MINIMAL_AGENT_DISABLE_CRON === "1") {
    return { kind: "error", message: "scheduling is disabled (MINIMAL_AGENT_DISABLE_CRON=1)" }
  }
  const sid = ctx.agent?.sessionId
  if (!sid) return { kind: "error", message: "scheduling requires an active session" }

  const { interval, prompt } = parseLoopArgs(ctx.argv)
  const usingDefault = prompt.length === 0
  const effectivePrompt = usingDefault ? resolveLoopPrompt(ctx.cwd) : prompt

  const now = Date.now()
  const subMinuteMs = interval ? parseDurationMs(interval) : null

  let create: CronCreateInput
  let rounded = false
  if (interval && subMinuteMs !== null && subMinuteMs < MIN_CRON_MS) {
    // SUB-MINUTE → dynamic pace. Cron can't express it, so the task fires off
    // its own `nextAtMs` and re-arms by the stored `intervalMs` (see
    // scheduler.due). The 1s heartbeat makes ~10s cadences land on time
    // (modulo firing between turns). Floor at 1s.
    const ms = Math.max(1000, subMinuteMs)
    create = {
      cron: "* * * * *", // unused for firing; kept for schema/back-compat
      prompt: effectivePrompt,
      recurs: true,
      pace: "dynamic",
      nextAtMs: now + ms,
      intervalMs: ms,
      label: interval,
      source: "loop",
    }
  } else if (interval) {
    const ic = intervalToCron(interval)
    if (!ic) return { kind: "error", message: `could not parse interval "${interval}"` }
    rounded = ic.rounded
    create = {
      cron: ic.cron,
      prompt: effectivePrompt,
      recurs: true,
      label: ic.label,
      source: "loop",
    }
  } else {
    create = {
      cron: "* * * * *",
      prompt: effectivePrompt,
      recurs: true,
      pace: "dynamic",
      nextAtMs: now + DYNAMIC_FIRST_MS,
      label: "self-paced",
      source: "loop",
    }
  }

  const res = cronStoreForSession(sid, ctx.env).create(create, now)
  if (!res.ok) return { kind: "error", message: res.error }

  const e = res.value
  const info = rounded ? `${taskInfo(e, now)} · rounded to ${e.label}` : taskInfo(e, now)
  const body = wrapText(effectivePrompt, 72)
  if (usingDefault) body.push(c.dim("maintenance prompt — edit .claude/loop.md to customize"))

  return {
    kind: "notice",
    block: {
      icon: GLYPH_LOOP,
      title: "loop",
      info,
      timestamp: clockHHMMSS(now),
      body,
      footer: taskFooter(e, now),
      color: "gold",
    },
  }
}
