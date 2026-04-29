/**
 * Inline-tag handler for `<tui::memory>...</tui::memory>`.
 *
 * Behavior:
 *   1. Append the body as a new bullet to the `## Saved memories` section
 *      of this plugin's PROMPT.md, between the `<!-- memories-begin -->`
 *      and `<!-- memories-end -->` sentinels. Because the loader re-reads
 *      PROMPT.md on every session start, the memory becomes part of the
 *      system prompt in all future sessions.
 *   2. Render a short confirmation line in place of the tag span so the
 *      user can see the save happened. The body itself is not echoed.
 *
 * Write failures are surfaced to the user as a one-line error so saves
 * aren't silently lost.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts";

const BEGIN = "<!-- memories-begin -->";
const END = "<!-- memories-end -->";

export default async function memoryHandler(
  ctx: TUIContext,
): Promise<TUIResult> {
  if (ctx.trigger.type !== "inline_tag") {
    return { kind: "rendered", ansi: "" };
  }

  const body = ctx.trigger.body.trim();
  if (body.length === 0) {
    return { kind: "rendered", ansi: "" };
  }

  // Collapse to a single line so the bullet stays clean. Multi-line memories
  // are joined with spaces; the model is instructed to keep them short.
  const oneLine = body.replace(/\s+/g, " ");
  const bullet = `- ${oneLine}`;

  const promptPath = join(ctx.packageDir, "PROMPT.md");

  try {
    const original = readFileSync(promptPath, "utf-8");
    const beginIdx = original.indexOf(BEGIN);
    const endIdx = original.indexOf(END);
    if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
      throw new Error(
        `memory sentinels not found in ${promptPath}; expected ${BEGIN} ... ${END}`,
      );
    }

    const before = original.slice(0, beginIdx + BEGIN.length);
    const after = original.slice(endIdx);
    const middle = original.slice(beginIdx + BEGIN.length, endIdx);

    // Existing bullets, trimmed of surrounding blank lines.
    const existing = middle.replace(/^\s+|\s+$/g, "");
    const newMiddle =
      existing.length === 0 ? `\n${bullet}\n` : `\n${existing}\n${bullet}\n`;

    const next = `${before}${newMiddle}${after}`;
    writeFileSync(promptPath, next);

    // Dim grey confirmation line.
    const preview = oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
    const ansi = `\x1b[2m· memory saved: ${preview}\x1b[0m\n`;
    return { kind: "rendered", ansi };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.stderr.write(`[memory] save failed: ${msg}\n`);
    const ansi = `\x1b[31m· memory save failed: ${msg}\x1b[0m\n`;
    return { kind: "rendered", ansi };
  }
}
