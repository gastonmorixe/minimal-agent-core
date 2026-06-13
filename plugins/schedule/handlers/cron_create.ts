/**
 * `CronCreate` tool — schedule a new task.
 *
 * Accepts EITHER a raw 5-field `cron` OR a human `every` interval, plus
 * the `prompt` to run and whether it `recurs`. One-shots store an absolute
 * fire time; sub-minute `every` (e.g. "10s") runs on the dynamic pace (cron
 * can't express sub-minute). Returns a model-facing confirmation + a colored
 * box display (the host draws the ╭─/│/╰─ chrome + the manifest icon).
 *
 * @module schedule/handlers/cron_create
 */

import type { TUIContext, TUIResult } from "@minimal-agent/plugin-api/types/plugin"

import { isValidCron, nextFire, parseCron } from "../lib/cron.ts"
import { describeCreated, taskFooter, taskInfo, wrapText } from "../lib/format.ts"
import { intervalToCron, parseDurationMs } from "../lib/interval.ts"
import { type CronCreateInput, cronStoreForSession } from "../lib/store.ts"

/** Cron's floor: intervals shorter than this run on the dynamic pace. */
const MIN_CRON_MS = 60_000

function fail(message: string): TUIResult {
  return { kind: "tool_result", content: message, is_error: true }
}

/**
 * Tool handler for `CronCreate`: validates the cron/interval spec and prompt,
 * then registers the task (recurring or one-shot) in the session store.
 */
export default async function cronCreate(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.env.MINIMAL_AGENT_DISABLE_CRON === "1") {
    return fail("Scheduling is disabled (MINIMAL_AGENT_DISABLE_CRON=1).")
  }
  const sid = ctx.agent?.sessionId
  if (!sid) return fail("Scheduling requires an active session id.")

  const input = ctx.trigger.type === "tool" ? ctx.trigger.input : {}
  const prompt = String(input.prompt ?? "").trim()
  if (!prompt) return fail("`prompt` is required.")
  const recurs = input.recurs !== false // default: recurring

  const now = Date.now()
  const rawCron = typeof input.cron === "string" ? input.cron.trim() : ""
  const every = typeof input.every === "string" ? input.every.trim() : ""

  let create: CronCreateInput
  let rounded = false
  const everyMs = every ? parseDurationMs(every) : null

  if (rawCron) {
    if (!isValidCron(rawCron)) return fail(`Invalid cron expression: "${rawCron}".`)
    create = { cron: rawCron, prompt, recurs, source: "tool" }
    if (!recurs) {
      const nf = nextFire(parseCron(rawCron), new Date(now))
      if (!nf) return fail("That schedule has no upcoming fire time.")
      create.nextAtMs = nf.getTime()
    }
  } else if (every && everyMs !== null && recurs && everyMs < MIN_CRON_MS) {
    // Sub-minute recurring → dynamic pace, re-arming by intervalMs.
    const ms = Math.max(1000, everyMs)
    create = {
      cron: "* * * * *",
      prompt,
      recurs: true,
      pace: "dynamic",
      nextAtMs: now + ms,
      intervalMs: ms,
      label: every,
      source: "tool",
    }
  } else if (every) {
    const ic = intervalToCron(every)
    if (!ic) return fail(`Could not parse interval "${every}" (try e.g. "5m", "2h", "1d").`)
    create = { cron: ic.cron, prompt, recurs, label: ic.label, source: "tool" }
    rounded = ic.rounded
    if (!recurs) {
      const nf = nextFire(parseCron(ic.cron), new Date(now))
      if (!nf) return fail("That schedule has no upcoming fire time.")
      create.nextAtMs = nf.getTime()
    }
  } else {
    return fail('Provide either `cron` (5-field) or `every` (e.g. "5m", "10s").')
  }

  const res = cronStoreForSession(sid, ctx.env).create(create, now)
  if (!res.ok) return fail(res.error)

  const e = res.value
  const info = rounded ? `${taskInfo(e, now)} · rounded to ${e.label}` : taskInfo(e, now)
  // Body: blank-padded prompt so the host box gets breathing room (matches the
  // /loop command box). The host gutters each line and dims the header/footer.
  const body = ["", ...wrapText(e.prompt, 72), ""].join("\n")
  return {
    kind: "tool_result",
    content:
      `Scheduled task ${e.id} (${recurs ? "recurring" : "one-shot"}). ` +
      `${describeCreated(e, now, rounded)[0]}. ` +
      `It injects the prompt between turns when due. Cancel with CronDelete("${e.id}").`,
    display: body,
    displayHeader: info,
    displayFooter: taskFooter(e, now),
  }
}
