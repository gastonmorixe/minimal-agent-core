/**
 * Module-level pointer to the agent's plugin event bus.
 *
 * Why a global:
 *
 * Several emit-points sit deep in the call graph (notably
 * `client.ts`, which observes response headers and broadcasts
 * `quota.headersReceived`) but the bus itself is owned by the
 * `PluginLoader`. Threading the bus through every call site is
 * intrusive churn for a notification-only path; a tiny module-level
 * setter / getter pair keeps the wiring shallow without giving
 * client code the bus's full surface.
 *
 * Lifecycle:
 *
 * - `setGlobalEventBus(loader.bus())` is called once in
 *   `src/index.ts` immediately after `PluginLoader.load()`.
 * - `getGlobalEventBus()` returns `null` until that call lands —
 *   emitters use `.?.emit()` so a pre-load emit is silently dropped
 *   (the loader hasn't installed any listeners yet anyway).
 * - Tests `setGlobalEventBus(null)` between cases to prevent state
 *   leak; in production the value is set once and never cleared.
 *
 * Not a singleton in the design-pattern sense — just a process-wide
 * convenience pointer. There's exactly one bus per agent process.
 *
 * @module global-bus
 */

import type { EventBus } from "./plugins/event-bus.ts"

let globalBus: EventBus | null = null

/**
 * Install the agent's event bus as the process-wide pointer.
 * Idempotent: passing the same instance twice is a no-op. Pass
 * `null` to clear (tests only).
 */
export function setGlobalEventBus(bus: EventBus | null): void {
  globalBus = bus
}

/**
 * Read the process-wide bus, or `null` if not yet installed.
 * Callers should always handle null — early-boot emit-points and
 * tests can run before `index.ts` wires the loader.
 */
export function getGlobalEventBus(): EventBus | null {
  return globalBus
}
