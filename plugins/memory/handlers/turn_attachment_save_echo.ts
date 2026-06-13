/**
 * Turn-attachment factory: the `<ma::agent::memory-saved>` save-echo
 * drain.
 *
 * Declared in `manifest.json` under `turnAttachments`; the host loader
 * resolves this module through its runtime-discovery seam and registers
 * the default export into the host's turn-attachment registry. At boot
 * the host calls it with the live session context; the returned
 * collector subscribes to the host event bus and is drained
 * (`consumeAll()`) at every user-message seam, so the model's next turn
 * carries the id of every memory it just saved.
 *
 * Types for the host envelope are re-declared locally (structural
 * typing); this module imports nothing from the host repo. The bus
 * arrives untyped (`unknown`) through the seam and is narrowed
 * structurally before use.
 *
 * @module memory/handlers/turn_attachment_save_echo
 */

import { SaveEchoCollector, setSaveBus } from "../lib/save-echo.ts"

/** Local structural slice of the host's `TurnAttachmentContext`. */
interface TurnAttachmentContext {
  /** The live session id, or `null` when no session is plumbed through. */
  sessionId: string | null
  /** The host's event bus, when present. Narrowed structurally below. */
  bus?: unknown
}

/**
 * Attach a {@link SaveEchoCollector} to the host bus AND publish the same
 * bus to the plugin-local emit pointer (`setSaveBus`) so the inline-tag
 * save handler — which has no `ctx.bus` of its own — can fire
 * `memory.saved` onto the very bus this collector subscribes to. Both
 * sides meet on the one host bus the loader hands in here, replacing the
 * old `src/global-bus.ts` singleton.
 *
 * Returns `null` (no contribution) when the host supplied no bus — without
 * a bus there is nothing to collect, and the host treats `null` as a clean
 * decline (graceful degradation, never an error).
 */
export default function makeSaveEcho(ctx: TurnAttachmentContext): SaveEchoCollector | null {
  const bus = ctx.bus
  if (bus === null || typeof bus !== "object") return null
  if (typeof (bus as { on?: unknown }).on !== "function") return null
  if (typeof (bus as { emit?: unknown }).emit === "function") {
    setSaveBus(bus as Parameters<typeof setSaveBus>[0])
  }
  return SaveEchoCollector.attach(bus as Parameters<typeof SaveEchoCollector.attach>[0])
}
