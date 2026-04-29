/**
 * Inline-tag handler for `<tui::diff>...</tui::diff>`.
 *
 * Takes the body of the tag (which should be a unified diff), optionally
 * honors a `title` attribute for a heading, and returns an ANSI-rendered
 * block. Non-interactive: the scanner replaces the original span with the
 * rendered output in the live stream.
 */

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts";
import { renderUnifiedDiff } from "./render.ts";

export default async function inlineDiffHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "inline_tag") {
    return { kind: "rendered", ansi: "" };
  }
  const title = ctx.trigger.attrs.title;
  const rendered = renderUnifiedDiff(ctx.trigger.body, title);
  // Pad with a leading newline so the rendered block doesn't glue onto
  // whatever text preceded the tag in the stream.
  return { kind: "rendered", ansi: `\n${rendered}\n` };
}
