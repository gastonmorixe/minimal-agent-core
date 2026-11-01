/**
 * Public re-export of src/agent/agent-name.ts (`resolveAgentName`,
 * `autoName`, `AGENT_NAMES`, `hashToIndex`) — the boot-time display-name
 * resolver the host entry point calls once per session (S34 exports-gap
 * decision, Phase 0 / Bucket C).
 *
 * @module host-public/agent-identity
 */
export * from "../agent/agent-name.ts"
