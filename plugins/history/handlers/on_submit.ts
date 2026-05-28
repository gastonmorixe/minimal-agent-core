/**
 * `prompt.submitted` event handler.
 *
 * Subscribed via `manifest.events`. Called once per user submit with
 * `{text, cwd, sid, exit, queuePos}`. We:
 *
 *   1. Build a fresh {@link HistoryEntry} stamped with the current
 *      time + a base36-millis-rand4hex id (matches memory plugin).
 *   2. Append it to BOTH the per-project file and the global mirror
 *      (`store.appendBoth`).
 *   3. Push it into the in-memory recall so the next ↑ surfaces it
 *      without a disk re-read.
 *
 * Best-effort: any failure (disk full, permission denied, recall
 * uninitialized) is logged and swallowed. The agent's submit path is
 * never blocked or surfaced as user-visible error.
 *
 * @module plugins/history/handlers/on_submit
 */

import type { EventHandler, EventHandlerContext } from "../../../src/plugins/types.ts"
import { recallFor } from "../lib/session.ts"
import { appendBoth, buildEntry, isDisabled } from "../lib/store.ts"

/**
 * Payload shape for `prompt.submitted`. Mirrors the emit site in
 * `src/agent.ts:runReplLiveArea#onSubmit`. We use a loose check at
 * runtime since the bus is untyped at the wire.
 */
interface SubmittedPayload {
  text: string
  cwd: string
  sid: string | null
  exit?: "submitted" | "canceled"
  queuePos?: number
}

function isPayload(v: unknown): v is SubmittedPayload {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.text === "string" &&
    typeof o.cwd === "string" &&
    (o.sid === null || typeof o.sid === "string")
  )
}

const handler: EventHandler<SubmittedPayload> = async (
  ctx: EventHandlerContext<SubmittedPayload>,
) => {
  if (isDisabled()) return
  const payload = ctx.payload as unknown
  if (!isPayload(payload)) {
    ctx.log.warn(`history.on_submit: ignoring malformed payload ${JSON.stringify(payload)}`)
    return
  }
  const { text, sid, exit } = payload
  if (text.trim().length === 0) return
  // We use `ctx.cwd` (the agent's working directory) as the index key
  // for both the on-disk file AND the in-memory recall — not
  // `payload.cwd`. In production they're equal (one agent process, one
  // cwd). In tests it lets us reliably scope state without round-trip
  // mismatches. The entry's `cwd` field still records `payload.cwd` as
  // an audit field — that's what the EMITTER observed.
  const recordCwd = typeof payload.cwd === "string" ? payload.cwd : ctx.cwd
  const entry = buildEntry({
    text,
    cwd: recordCwd,
    sid,
    exit: exit === "canceled" ? "canceled" : "submitted",
  })
  appendBoth(entry, {
    // The project file's path key is the AGENT's cwd (ctx.cwd), even
    // if payload.cwd differs (which only happens in tests). The entry
    // ROW still carries payload.cwd as a metadata field — see the
    // `recordCwd` variable above.
    projectCwd: ctx.cwd,
    logger: (m) => ctx.log.warn(m),
  })
  // Notify the in-memory recall so ↑ on the next turn surfaces the
  // entry. Best-effort — if the recall was never built (e.g. ↑ never
  // pressed), this is the FIRST instantiation and it'll load disk;
  // either way the push runs against a known-good Recall.
  try {
    recallFor(ctx.cwd).push(text)
  } catch (e) {
    ctx.log.warn(`history.on_submit: recall.push failed: ${e instanceof Error ? e.message : e}`)
  }
}

export default handler
