/**
 * The environment a plugin handler gets in `ctx.env` (and a subprocess
 * handler as its process env).
 *
 * Core adds no terminal data here (S31). The host can add its own entries
 * through `PluginLoaderOptions.handlerEnv`. Since S41 no host passes the
 * palette or a protocol version: plugin styles come from `ui.setup`.
 *
 * @module plugins/loader/handler-env
 */

import { agentContextToEnv } from "../agent-context.ts"
import type { AgentContext } from "../types.ts"

/** Host-supplied extra handler env, read at each call. */
export type HostHandlerEnv = () => Readonly<Record<string, string>>

/** `process.env`, then the host entries, then the agent identity (`MINIMAL_AGENT_*`). */
export function buildHandlerEnv(
  agent: AgentContext | undefined,
  hostEnv: HostHandlerEnv | undefined,
): Record<string, string> {
  return {
    ...process.env,
    ...(hostEnv ? hostEnv() : {}),
    ...(agent ? agentContextToEnv(agent) : {}),
  } as Record<string, string>
}
