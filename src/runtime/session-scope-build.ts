/**
 * Build the plugin scope of one runtime session (`infra/session-scope.ts`).
 *
 * Every value is read from the session's own `AgentCore` at each call, so a
 * target switch (`AgentCore.switchTarget`) shows at once, and an other
 * session in the same process never changes it.
 *
 * @module runtime/session-scope-build
 */

import type { SessionScope } from "../infra/session-scope.ts"
import { buildModelInfoSnapshot, buildSubagentModelRecommendations } from "../llm/model-info.ts"
import type { AgentCore } from "../sdk/agent-core.ts"
import { outputSharesContextWindow, SessionTokenCounter } from "../session/session-tokens.ts"

import type { SessionPluginScopeOptions } from "./session.ts"

/** The plugin scope of the session `sid`, over its live `core`. */
export function buildSessionScope(
  sid: string,
  core: AgentCore,
  options: SessionPluginScopeOptions,
): SessionScope {
  const version = options.version ?? ""
  return {
    sid,
    agent: () =>
      Object.freeze({ sessionId: sid, pid: process.pid, model: core.getModel(), version }),
    queryTarget: () => {
      const t = core.getTarget()
      return {
        ...(t.credentialName !== undefined ? { credentialName: t.credentialName } : {}),
        ...(t.providerId !== undefined ? { providerId: t.providerId } : {}),
        model: t.model,
        ...(t.effort !== undefined ? { effort: t.effort } : {}),
      }
    },
    queryModelInfo: () => buildModelInfoSnapshot(core.getModel(), core.getProviderId()),
    recommendSubagentModels: () => buildSubagentModelRecommendations(core.getModel()),
    tokens: new SessionTokenCounter(() =>
      outputSharesContextWindow(core.getModel(), core.getProviderId()),
    ),
  }
}
