/**
 * Turn-attachment factory: the per-turn `<ma::agent::tasks>` snapshot
 * producer.
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
 * @module tasks/handlers/turn_attachment
 */

import { TasksAttachment } from "../lib/attachment.ts"

/** Local structural slice of the host's `TurnAttachmentContext`. */
interface TurnAttachmentContext {
  /** The live session id, or `null` when no session is plumbed through. */
  sessionId: string | null
}

/**
 * Build the tasks snapshot producer for this session. `TasksAttachment`
 * already returns `null` from `toAttachment()` when the sid is missing
 * or the session has no tasks, so construction is unconditional
 * (mirrors the host's old direct construction): a disabled plugin just
 * means the file stays empty and the producer costs nothing.
 */
export default function makeTasksAttachment(ctx: TurnAttachmentContext): TasksAttachment {
  return new TasksAttachment(ctx.sessionId)
}
