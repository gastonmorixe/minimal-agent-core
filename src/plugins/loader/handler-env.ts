/**
 * The environment a plugin handler gets: `ctx.env` (and a subprocess
 * handler's process env), and the host streams.
 *
 * Core adds no terminal data here (S31). Core reads no process stream
 * itself (S44). The host gives the streams through
 * `PluginLoaderOptions.handlerStdio`. Without them, a handler context has
 * no `stdin`, `stdout`, or `stderr`.
 *
 * @module plugins/loader/handler-env
 */

import { childEnv } from "@minimal-agent/core/plugin-api/utils/self-spawn"

import { agentContextToEnv } from "../agent-context.ts"
import type { AgentContext } from "../types.ts"

/** The host streams for plugin handlers. Each one is optional. */
export interface HandlerStdio {
  readonly stdin?: NodeJS.ReadStream
  readonly stdout?: NodeJS.WriteStream
  readonly stderr?: NodeJS.WriteStream
}

/**
 * `process.env` without `BUN_BE_BUN`, then the agent identity
 * (`MINIMAL_AGENT_*`). This is `ctx.env` and the env of every subprocess
 * handler (tool, fragment, event), so a plugin command never inherits
 * `BUN_BE_BUN` (see `plugin-api/utils/self-spawn`).
 */
export function buildHandlerEnv(agent: AgentContext | undefined): Record<string, string> {
  return {
    ...childEnv(process.env),
    ...(agent ? agentContextToEnv(agent) : {}),
  }
}
