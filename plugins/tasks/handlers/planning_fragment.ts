/**
 * Prompt-fragment handler for the `tasks` plugin's PLAN/PHASES guidance.
 *
 * Runs once at session start (via the loader's `promptFragments`
 * mechanism). Returns one short paragraph telling the model to PLAN and work
 * in PHASES with TASKs and SUB-TASKs. The text gets folded into the same
 * `<ma::sys::tool name="Task">` section the plugin's `PROMPT.md` produces.
 *
 * ## Why this lives here, not in core `instructions.md`
 *
 * The guidance only makes sense when the `Task` tool actually exists. The
 * core instructions block is provider-neutral and ships to EVERY model,
 * including ones with no user-defined-tool support, where "use the Task tool"
 * is noise. By contributing the line as a tasks-plugin fragment we get two
 * layers of gating for free:
 *
 *   1. The fragment self-gates here on `tools.userDefined` (see below): a
 *      model that can't call user tools never sees the paragraph.
 *   2. The loader already drops a plugin's ENTIRE prompt section when its
 *      tool surface is hidden for the turn (see `buildBlock` in
 *      `src/plugins/loader.ts`), so even the PROMPT.md body disappears when
 *      the `Task` tool isn't advertised.
 *
 * ## No hardcoded prompt text
 *
 * The paragraph is read from `prompts/planning.md` (a sibling file), never
 * embedded as a TS string literal. One uniform "prose lives in markdown"
 * convention, same as the rest of the agent's prompts.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { PromptFragmentContext } from "@minimal-agent/plugin-api/types/plugin"

/**
 * Render the PLAN/PHASES fragment.
 *
 * Returns the contents of `prompts/planning.md` when the active model
 * supports user-defined tools, or an empty string otherwise (which makes the
 * loader drop the fragment entirely). When the host wired no model snapshot
 * provider (`ctx.queryModelInfo` is undefined: subprocess fragments,
 * back-compat callers), we emit the paragraph rather than suppress it, since
 * the loader's tool-availability gate is the authoritative second layer.
 */
export default function planningFragment(ctx: PromptFragmentContext): string {
  const info = ctx.queryModelInfo?.()
  // When we CAN read the model snapshot and it reports no user-defined tool
  // support, suppress. When we can't tell (undefined), defer to the loader's
  // section-level gate and emit.
  if (info && !info.tools.userDefined) return ""

  const path = join(ctx.packageDir, "prompts", "planning.md")
  try {
    return readFileSync(path, "utf-8").trim()
  } catch (e) {
    ctx.log.warn(
      "planning-fragment",
      `failed to read planning.md: ${e instanceof Error ? e.message : String(e)}`,
    )
    return ""
  }
}
