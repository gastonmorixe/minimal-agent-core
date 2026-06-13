/**
 * Turn-attachment factory: the per-turn `<ma::agent::short-term-memory>`
 * snapshot producer.
 *
 * Declared in `manifest.json` under `turnAttachments`; the host loader
 * resolves this module through its runtime-discovery seam and registers
 * the default export into the host's turn-attachment registry. At boot
 * the host calls it with the live session context and threads the
 * returned producer into the agent's per-turn attachment seam.
 *
 * Types for the host envelope are re-declared locally (structural
 * typing, the session-history host-types idiom); this module imports
 * nothing from the host repo.
 *
 * @module memory/handlers/turn_attachment_short_term
 */

import { ShortTermSnapshot } from "../lib/short-term-snapshot.ts"

/** Local structural slice of the host's `TurnAttachmentContext`. */
interface TurnAttachmentContext {
  /** The live session id, or `null` when no session is plumbed through. */
  sessionId: string | null
}

/**
 * Build the short-term-memory snapshot producer for this session.
 * `ShortTermSnapshot` already returns `null` from `toAttachment()` when
 * the sid is missing or the scratch file is empty, so construction is
 * unconditional (mirrors the host's old direct construction).
 */
export default function makeShortTermSnapshot(ctx: TurnAttachmentContext): ShortTermSnapshot {
  return new ShortTermSnapshot(ctx.sessionId)
}
