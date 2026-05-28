/**
 * Inline-tag handler for `<ma::plugin::interleave-thinking>...</ma::plugin::interleave-thinking>`.
 *
 * Behavior:
 *   1. Drop the tag body from the user-visible output stream by returning
 *      an empty rendered span. The scanner substitutes this for the raw
 *      tag text, so nothing reaches stdout.
 *   2. Persist the body to a per-session log file so a human can inspect
 *      the model's interleaved reasoning after the fact.
 *
 * Log path:
 *     {cwd}/.logs/{sessionId}/interleave-{ISO8601}.log
 *
 * One file per tag invocation. Filename timestamps order the spans so a
 * `ls` of the session directory reads chronologically. The session id is
 * the same UUID used for metadata/headers, so logs line up with API-side
 * session records.
 *
 * Write failures are swallowed (logged to stderr) so a broken filesystem
 * never takes down the output stream.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getSessionId } from "../../../src/metadata.ts";
import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts";

export default async function interleaveThinkingHandler(
  ctx: TUIContext,
): Promise<TUIResult> {
  if (ctx.trigger.type !== "inline_tag") {
    return { kind: "rendered", ansi: "" };
  }

  const body = ctx.trigger.body;
  if (body.length > 0) {
    try {
      const sessionId = getSessionId();
      const dir = join(ctx.cwd, ".logs", sessionId);
      mkdirSync(dir, { recursive: true });
      const timestamp = new Date().toISOString();
      const file = join(dir, `interleave-${timestamp}.log`);
      writeFileSync(file, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.stderr.write(`[interleave-thinking] log write failed: ${msg}\n`);
    }
  }

  return { kind: "rendered", ansi: "" };
}
