/**
 * Public re-export shim for `@minimal-agent/core/host/agent-context`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `createAgentContext` / `agentContextToEnv` / `agentContextFromEnv` — the
 * one place that marshals the shared `AgentContext` to/from a
 * `MINIMAL_AGENT_*` env-var record. Needed at boot and by anything
 * rendering a live-area handler context. See
 * `../plugins/agent-context.ts` for the full contract.
 *
 * @module host-public/agent-context
 */

export * from "../plugins/agent-context.ts"
