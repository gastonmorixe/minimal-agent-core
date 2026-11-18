/**
 * Shape-aware emit for plugin handler contexts.
 *
 * Shared by the event-sub / hook-sub contexts (`event-subs.ts`) and the
 * module prompt-fragment context (`fragments.ts`).
 *
 * @module plugins/loader/shape-emit
 */

import type { EventBus } from "../event-bus.ts"
import { CHANNEL_BY_NAME } from "../hooks/channels.ts"
import type { Hooks } from "../hooks/hooks.ts"

/**
 * Build a fire-and-forget `emit(channel, payload)` for a plugin context.
 *
 *   1. **Declared non-async channels** (`broadcast-sync` / `chain` /
 *      `stream` in `channels.ts`) route via the Hooks facade
 *      (`hooks.emitSync`). Required for channels like `editor.footer.set`
 *      whose host listener lives on the HookBus, NOT the EventBus.
 *   2. **Declared `broadcast-async` and ad-hoc channels** go straight to
 *      the EventBus. Preserves the legacy "any string is a valid event
 *      name" contract.
 *
 * Never throws: a failure is logged as `<label>: emit("<chan>") failed: ...`.
 * The returned function holds only `bus` / `hooks`, so a caller may keep it
 * and call it after the handler returns.
 */
export function createShapeAwareEmit(
  bus: EventBus,
  hooks: Hooks,
  label: string,
  logger: (msg: string) => void,
): (channel: string, payload?: unknown) => void {
  return (chan: string, p?: unknown): void => {
    try {
      const shape = CHANNEL_BY_NAME.get(chan)?.shape
      if (shape === "broadcast-async" || shape === undefined) {
        bus.emit(chan, p)
        return
      }
      hooks.emitSync(chan, p)
    } catch (e) {
      try {
        logger(`${label}: emit("${chan}") failed: ${e instanceof Error ? e.message : String(e)}`)
      } catch {
        /* a broken logger must not throw into the plugin */
      }
    }
  }
}
