/**
 * Public re-export of the Tier-1 assembly seam in
 * src/adapters/build-agent-core.ts: `buildAgentCore` /
 * `openAgentCoreSession`, their shared `BuildAgentCoreDeps` shape,
 * `toEffort`, and the re-exported adapter classes. Part of the CLI's
 * `host-kit` construction kit (S34 exports-gap decision) — narrower
 * audience than `./host/*`, not for the web host.
 *
 * @module host-public/build-agent-core
 */
export * from "../adapters/build-agent-core.ts"
