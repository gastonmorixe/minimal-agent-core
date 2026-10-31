/**
 * `createRuntime`: the package root (`.`) public entry (spec v2 section
 * 2.3, S47).
 *
 * This file only re-exports `../runtime/index.ts`. The implementation
 * lives outside `src/sdk/` on purpose: it wires together concrete session
 * and diagnostics collaborators (`SessionEventLog`, `SessionStore`,
 * `DiagnosticsHub`) that the SDK port-boundary ratchet
 * (`src/architecture/sdk-port-boundaries.test.ts`) forbids any file under
 * `src/sdk/` from importing — by design, so the agent loop itself
 * (`agent-core.ts` and its direct collaborators) never depends on a
 * concrete session implementation, only on the `SessionPersistence` port.
 * `createRuntime` is the one layer whose whole job is to build that
 * concrete wiring, so it sits beside `src/sdk/`, not inside its ratchet.
 *
 * `src/architecture/public-api.test.ts` requires every `exports` target to
 * resolve to a file under `src/sdk/` or `plugin-api/src/`, so this file —
 * not `src/runtime/index.ts` directly — is what `package.json`'s `"."`
 * entry points at.
 *
 * @module sdk/runtime
 */

export * from "../runtime/index.ts"
