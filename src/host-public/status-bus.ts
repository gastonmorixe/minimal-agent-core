/**
 * Public re-export shim for `@minimal-agent/core/host/status-bus`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `GLOBAL_STATUS_BUS` / `StatusBus` — still load-bearing for core-engine
 * status reporting (`agent/tool-round.ts`, `llm/transport/canonical-send.ts`,
 * `network/activity-observer.ts`), so this stays a normal, unqualified
 * import for those files. The same module is also needed by several
 * CLI-destined files (`host/interactive-session.ts`,
 * `host/reflection-cooldown.ts`, the live-area status renderer, and 4 e2e
 * tests) once they move to the CLI repo — this subpath is what lets them
 * depend on it from outside core. See `../bus/status.ts` for the full
 * contract.
 *
 * @module host-public/status-bus
 */

export * from "../bus/status.ts"
