/**
 * The preflight ask through the `askUser` port (spec S17).
 *
 * Before each send, the provider may raise issues that need a user choice
 * (for example, thinking blocks that another model signed). With an
 * `askUser` port, each issue is one `ask_user` event and one `ask` call, and
 * the answer changes the request the model gets. Without a port (a headless
 * run), each issue is denied once per turn with an `ask_denied` notice, and
 * the request goes out unchanged. A port that rejects an ask with
 * {@link AskDeniedError} (the session ask registry does so on its deadline
 * when the ask has no default option) gets the same denial: the turn
 * continues and never stops (decision 34).
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

/**
 * An `askUser` port rejects an ask with this error when nobody answered it
 * and it has no default option. The preflight step then denies the issue
 * exactly as a run with no port does: an `ask_denied` notice, a
 * `preflight.ask-denied` diag event, and the request goes out unchanged.
 * A `null` answer is different: it is an explicit user cancel.
 */
export class AskDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AskDeniedError"
  }
}

/** Thrown inside the pipeline to stop it after a denial. Never escapes. */
class PreflightDenied extends Error {}

/** Emit the denial records for one issue (decision 11/34). */
function denyIssue(input: PreflightAskInput, code: string, title: string, why: string): void {
  input.emitNotice({ kind: "ask_denied", severity: "warn", code, title })
  // The diag event keeps a record of the denial in the session log.
  input.diagnostics?.warn(
    "preflight.ask-denied",
    `${why}. Denied "${title}" and sent the request unchanged`,
    { code },
  )
}

/** Build the preflight step for one turn. */
export function createPreflightAsk(input: PreflightAskInput): PreflightAsk {
  const { port } = input
  // Issue codes denied in this turn. A denied code is not asked again.
  const denied = new Set<string>()
  if (!port) {
    return async (messages, modelId, providerId) => {
      for (const issue of detectPreflightIssues(messages, modelId, providerId, input.diagnostics)) {
        if (denied.has(issue.code)) continue
        denied.add(issue.code)
        // Decision 11/34: no host can answer, so the ask resolves at once.
        denyIssue(input, issue.code, issue.title, "no askUser port")
      }
      return { messages, modelId, cancelled: false }
    }
  }
  return async (messages, modelId, providerId) => {
    try {
      return await runPreflightPipeline({
        messages,
        modelId,
        providerId,
        ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
        askUser: async (issue) => {
          if (denied.has(issue.code)) throw new PreflightDenied()
          const request: AskUserRequest = {
            askId: input.nextAskId(),
            code: issue.code,
            title: issue.title,
            detail: issue.detail,
            options: issue.options.map((option) => ({ ...option })),
          }
          input.emit({ type: "ask_user", ...request })
          try {
            return await port.ask(request, input.signal)
          } catch (error) {
            if (!(error instanceof AskDeniedError)) throw error
            denied.add(issue.code)
            denyIssue(input, issue.code, issue.title, error.message)
            throw new PreflightDenied()
          }
        },
      })
    } catch (error) {
      if (!(error instanceof PreflightDenied)) throw error
      // Decision 34: a denial never stops the turn. Send the request unchanged.
      return { messages, modelId, cancelled: false }
    }
  }
}
