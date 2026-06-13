/**
 * Inline-tag handler for `<ma::emit::interleave-thinking>...</ma::emit::interleave-thinking>`.
 *
 * Behavior:
 *   1. Drop the tag body from the user-visible output stream by returning
 *      an empty rendered span. The scanner substitutes this for the raw
 *      tag text, so nothing reaches stdout.
 *   2. Persist the body to a per-session log file so a human can inspect
 *      the model's interleaved reasoning after the fact.
 *
 * Log path:
 *     `{cwd}/.logs/{sessionId}/interleave-{ISO8601}.log`
 *
 * One file per tag invocation. Filename timestamps order the spans so a
 * `ls` of the session directory reads chronologically. The session id is
 * the same UUID used for metadata/headers, so logs line up with API-side
 * session records.
 *
 * Write failures are swallowed (logged to stderr) so a broken filesystem
 * never takes down the output stream.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { TUIContext, TUIResult } from "@minimal-agent/plugin-api/types/plugin"

/**
 * Resolve the agent session id from the handler context WITHOUT importing core.
 *
 * Core threads its per-process session UUID to every plugin handler two ways:
 * `ctx.agent.sessionId` (the frozen agent identity) and the
 * `MINIMAL_AGENT_SESSION_ID` env var (published by the loader for subprocess
 * handlers). We prefer the structured field and fall back to env. When neither
 * is present (ad-hoc / legacy dispatch without an agent), we use a stable
 * placeholder so the log path stays well-formed.
 *
 * @param ctx - The TUI handler context the loader supplies.
 * @returns The session id, or `"no-session"` when the host didn't supply one.
 */
function resolveSessionId(ctx: TUIContext): string {
  const fromAgent = ctx.agent?.sessionId?.trim()
  if (fromAgent) return fromAgent
  const fromEnv = ctx.env?.MINIMAL_AGENT_SESSION_ID?.trim()
  if (fromEnv) return fromEnv
  return "no-session"
}

/**
 * Inline-tag handler for `<thinking::interleave>` blocks: re-renders the
 * tagged working-note body as a dim framed panel in the transcript while
 * keeping the raw text model-visible.
 */
export default async function interleaveThinkingHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "inline_tag") {
    return { kind: "rendered", ansi: "" }
  }

  const body = ctx.trigger.body
  if (body.length > 0) {
    try {
      const sessionId = resolveSessionId(ctx)
      const dir = join(ctx.cwd, ".logs", sessionId)
      mkdirSync(dir, { recursive: true })
      const timestamp = new Date().toISOString()
      const file = join(dir, `interleave-${timestamp}.log`)
      writeFileSync(file, body)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      ctx.stderr.write(`[interleave-thinking] log write failed: ${msg}\n`)
    }
  }

  return { kind: "rendered", ansi: "" }
}
