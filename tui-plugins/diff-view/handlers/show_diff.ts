/**
 * Tool-call handler for `show_diff`.
 *
 * Reads `patch` and optional `title` from the tool input and returns the
 * rendered diff as a tool_result. Non-interactive: the agent loop receives
 * the ansi-colored string as the tool output and continues.
 */

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts";
import { renderUnifiedDiff } from "./render.ts";

export default async function showDiffHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "show_diff: wrong trigger", is_error: true };
  }
  const input = ctx.trigger.input as { patch?: unknown; title?: unknown };
  if (typeof input.patch !== "string") {
    return {
      kind: "tool_result",
      content: "show_diff: `patch` must be a string",
      is_error: true,
    };
  }
  const title = typeof input.title === "string" ? input.title : undefined;
  const rendered = renderUnifiedDiff(input.patch, title);
  return { kind: "tool_result", content: rendered };
}
