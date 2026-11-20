/**
 * The handler context fields that come from the current session scope.
 *
 * The loader is shared by every session of a process. Its own identity
 * fields (`agent`, the model-info and target sources) are the process
 * values. Inside a scoped run (`infra/session-scope.ts`, a host with many
 * sessions), a handler must see the session of that run instead. This
 * module gives those fields. Outside a scoped run it gives the loader's own
 * values, so a host with one session sees no change.
 *
 * @module plugins/loader/session-scope-ctx
 */

import { currentSessionScope, type SessionScope } from "../../infra/session-scope.ts"
import type { PluginHost } from "../host/capabilities.ts"
import type { AgentContext, ToolHandlerContext } from "../types.ts"

import { buildHandlerEnv } from "./handler-env.ts"

export { withRunFact } from "./run-mode-fact.ts"

/** The loader values that a session scope can replace. */
export interface LoaderIdentity {
  readonly agent: AgentContext | undefined
  readonly queryModelInfo: ToolHandlerContext["queryModelInfo"]
  readonly recommendSubagentModels: ToolHandlerContext["recommendSubagentModels"]
  readonly queryTarget: ToolHandlerContext["queryTarget"]
  readonly host: PluginHost | undefined
}

/** The identity fields of one handler context. Absent fields stay absent. */
export interface ScopedIdentity {
  env: Record<string, string>
  agent: AgentContext | undefined
  queryModelInfo?: NonNullable<ToolHandlerContext["queryModelInfo"]>
  recommendSubagentModels?: NonNullable<ToolHandlerContext["recommendSubagentModels"]>
  queryTarget?: NonNullable<ToolHandlerContext["queryTarget"]>
  host?: PluginHost
}

/** The host with the token counters of `scope`, when it has the session-info capability. */
function scopedHost(host: PluginHost | undefined, scope: SessionScope): PluginHost | undefined {
  if (!host?.sessionInfo) return host
  const sessionInfo = Object.freeze({ ...host.sessionInfo, tokens: () => scope.tokens.snapshot() })
  return Object.freeze({ ...host, sessionInfo })
}

/** The identity of the agent: the current session scope, else the loader's own. */
export function scopedAgent(own: AgentContext | undefined): AgentContext | undefined {
  return currentSessionScope()?.agent() ?? own
}

/**
 * The identity fields of a handler context: the current session scope when a
 * scoped run is in progress, else the loader's own values.
 */
export function scopedIdentity(own: LoaderIdentity): ScopedIdentity {
  const scope = currentSessionScope()
  if (scope === undefined) {
    return {
      env: buildHandlerEnv(own.agent),
      agent: own.agent,
      ...(own.queryModelInfo ? { queryModelInfo: own.queryModelInfo } : {}),
      ...(own.recommendSubagentModels
        ? { recommendSubagentModels: own.recommendSubagentModels }
        : {}),
      ...(own.queryTarget ? { queryTarget: own.queryTarget } : {}),
      ...(own.host ? { host: own.host } : {}),
    }
  }
  const agent = scope.agent()
  const host = scopedHost(own.host, scope)
  return {
    env: buildHandlerEnv(agent),
    agent,
    queryModelInfo: () => scope.queryModelInfo(),
    recommendSubagentModels: () => scope.recommendSubagentModels(),
    queryTarget: () => scope.queryTarget(),
    ...(host ? { host } : {}),
  }
}
