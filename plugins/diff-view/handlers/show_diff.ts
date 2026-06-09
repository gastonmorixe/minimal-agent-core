/**
 * Tool-call handler for the `ShowDiff` tool.
 *
 * Note: the handler `id` and file path stay as `show_diff` (loader-internal,
 * never user-visible). The model-facing tool name was renamed to `ShowDiff`
 * to match the convention used by built-ins (`Bash`, `Read`, `WebSearch`,
 * etc.). The legacy `show_diff` name is preserved as an alias on the
 * manifest so resumed sessions and muscle-memory calls keep working
 * silently — see manifest.json's `tool.aliases` field and the dispatcher
 * in src/plugins/loader.ts.
 *
 * Reads `patch` and optional `title` from the tool input and returns the
 * rendered diff as a tool_result. Non-interactive: the agent loop receives
 * the ansi-colored string as the tool output and continues.
 */

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"

import { renderUnifiedDiff } from "./render.ts"

export default async function showDiffHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "ShowDiff: wrong trigger", is_error: true }
  }
  const input = ctx.trigger.input as { patch?: unknown; title?: unknown }
  if (typeof input.patch !== "string") {
    return {
      kind: "tool_result",
      content: "ShowDiff: `patch` must be a string",
      is_error: true,
    }
  }
  const title = typeof input.title === "string" ? input.title : undefined
  const rendered = renderUnifiedDiff(input.patch, title)
  // `content` goes back to the model (keep it as the raw patch — the model
  // already knows what it asked to render, no need to feed it ANSI back).
  // `display` is the ANSI-colored render shown in the transcript with no
  // truncation — see formatToolPreview in src/agent.ts.
  return { kind: "tool_result", content: input.patch, display: rendered }
}
