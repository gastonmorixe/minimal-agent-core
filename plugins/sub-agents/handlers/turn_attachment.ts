/**
 * Turn-attachment factory: the per-turn `<ma::agent::subagents>` fleet
 * digest producer.
 *
 * Declared in `manifest.json` under `turnAttachments`; the host loader
 * resolves this module through its runtime-discovery seam and registers
 * the default export into the host's turn-attachment registry. At boot
 * the host calls it with the live session context and threads the
 * returned producer into the agent's per-turn attachment seam.
 *
 * Types for the host envelope are re-declared locally (structural
 * typing); this module imports nothing from the host repo.
 *
 * @module sub-agents/handlers/turn_attachment
 */

import { SubagentsAttachment } from "../lib/attachment.ts"

/** Local structural slice of the host's `TurnAttachmentContext`. */
interface TurnAttachmentContext {
  /** The live session id, or `null` when no session is plumbed through. */
  sessionId: string | null
}

/**
 * Build the fleet digest producer for this session.
 * `SubagentsAttachment` already returns `null` from `toAttachment()`
 * when the sid is missing or no worker is active, so construction is
 * unconditional (mirrors the host's old direct construction).
 */
export default function makeSubagentsAttachment(ctx: TurnAttachmentContext): SubagentsAttachment {
  return new SubagentsAttachment(ctx.sessionId)
}
