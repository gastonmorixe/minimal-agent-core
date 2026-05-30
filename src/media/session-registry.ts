/**
 * Process-wide media registry singleton.
 *
 * minimal-agent runs one agent session per process, so a module singleton is
 * the lowest-friction way to share the registry between the TUI capture (editor
 * paste interceptor) and the submit path (agent.run) without threading a
 * registry through every constructor. Tests use `createMediaRegistry()`
 * directly and never touch this.
 *
 * @module media/session-registry
 */

import { createMediaRegistry, type MediaRegistry } from "./registry.ts"

let instance: MediaRegistry | null = null

/** The shared per-session registry, created on first use. */
export function getSessionMediaRegistry(): MediaRegistry {
  if (!instance) instance = createMediaRegistry()
  return instance
}

/** Drop the singleton (session reset / tests). */
export function resetSessionMediaRegistry(): void {
  instance?.clear()
  instance = null
}
