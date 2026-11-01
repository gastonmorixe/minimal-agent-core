/**
 * The preflight ask through the `askUser` port (spec S17).
 *
 * Before each send, the provider may raise issues that need a user choice
 * (for example, thinking blocks that another model signed). With an
 * `askUser` port, each issue is one `ask_user` event and one `ask` call, and
 * the answer changes the request the model gets. Without a port (a headless
 * run), each issue is denied once per turn with an `ask_denied` notice, and
 * the request goes out unchanged.
 *
 * @module sdk/preflight-ask
 */

import {
  detectPreflightIssues,
  type PreflightPipelineOutcome,
  runPreflightPipeline,
} from "../agent/preflight-pipeline.ts"
import type { TurnNotice } from "../agent/turn-notice.ts"
import type { Message } from "../llm/messages.ts"

import type { AgentEvent } from "./events.ts"
import type { AskUserPort, AskUserRequest } from "./host-ports.ts"

/** What one turn's preflight step needs from the core. */
export interface PreflightAskInput {
  /** The host's port. `undefined` runs headless. */
  port: AskUserPort | undefined
  /** A new ask id, unique per core. */
  nextAskId: () => string
  emit: (event: AgentEvent) => void
  emitNotice: (notice: TurnNotice) => void
  signal?: AbortSignal | undefined
  /** The core's diagnostics handle (S20). Preflight failures go here. */
  diagnostics?: import("../diagnostics/hub.ts").Diagnostics
}

/** One turn's preflight step. The core calls it before each send of the turn. */
export type PreflightAsk = (
  messages: Message[],
  modelId: string,
  providerId?: string,
) => Promise<PreflightPipelineOutcome>

/** Build the preflight step for one turn. */
export function createPreflightAsk(input: PreflightAskInput): PreflightAsk {
  const { port } = input
  if (!port) {
    const denied = new Set<string>()
    return async (messages, modelId, providerId) => {
      for (const issue of detectPreflightIssues(messages, modelId, providerId, input.diagnostics)) {
        if (denied.has(issue.code)) continue
        denied.add(issue.code)
        const { code, title } = issue
        input.emitNotice({ kind: "ask_denied", severity: "warn", code, title })
        // Decision 11/34: no host can answer, so the ask resolves at once.
        // The diag event keeps a record of it in the session log.
        input.diagnostics?.warn(
          "preflight.ask-denied",
          `no askUser port. Denied "${title}" and sent the request unchanged`,
          { code },
        )
      }
      return { messages, modelId, cancelled: false }
    }
  }
  return (messages, modelId, providerId) =>
    runPreflightPipeline({
      messages,
      modelId,
      providerId,
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
      askUser: (issue) => {
        const request: AskUserRequest = {
          askId: input.nextAskId(),
          code: issue.code,
          title: issue.title,
          detail: issue.detail,
          options: issue.options.map((option) => ({ ...option })),
        }
        input.emit({ type: "ask_user", ...request })
        return port.ask(request, input.signal)
      },
    })
}
