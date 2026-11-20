/**
 * Round steps extracted from {@link AgentCore} so that file stays under the
 * 810-line gate: append the first user message of a turn, record a model
 * response, and list the tools one turn advertises. Pure moves: the core passes its state in as deps.
 *
 * @module sdk/agent-core-round
 */

import { appendInitialTurnContent } from "../agent/turn-content.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { Message, ToolResultBlock } from "../llm/messages.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import {
  buildInitialUserContent,
  type InitialUserContentDeps,
  itemEvents,
} from "./agent-core-helpers.ts"
import { appendUserTurn } from "./conversation-history.ts"
import type { AgentEvent } from "./events.ts"
import type { HookContextEntry } from "./hook-context.ts"
import type {
  AgentCoreConfig,
  ModeProvider,
  SessionPersistence,
  ToolAdvertisementFilter,
  ToolRegistry,
} from "./ports.ts"
import type { RoundRequest } from "./send-attempt.ts"
import type { SessionContextTake } from "./session-context.ts"

type TurnContentProviders = NonNullable<AgentCoreConfig["turnContentProviders"]>
type RoundTools = NonNullable<RoundRequest["tools"]>

/** What {@link recordModelResponse} needs from the core. */
export interface ResponseRecordDeps {
  readonly messages: Message[]
  readonly persistence: SessionPersistence | null
  readonly emit: (event: AgentEvent) => void
}

/**
 * Record a model response: history, session log, and the item events.
 */
export function recordModelResponse(
  deps: ResponseRecordDeps,
  response: StreamedResponse,
  round: number,
): void {
  if (response.blocks.length > 0) {
    const id = response.providerMessageId
    deps.messages.push(
      id
        ? { role: "assistant", content: response.blocks, providerMessageId: id }
        : { role: "assistant", content: response.blocks },
    )
    deps.persistence?.appendAssistant(
      response.blocks,
      response.stopReason,
      response.usage,
      id ? { providerMessageId: id } : undefined,
    )
    for (const ev of itemEvents(response.blocks, round)) deps.emit(ev)
  }
}

/** What {@link appendInitialUserTurn} needs from the core. */
export interface InitialUserTurnDeps extends InitialUserContentDeps {
  readonly diagnostics: Diagnostics
  readonly turnContentProviders: TurnContentProviders
  readonly messages: Message[]
  readonly persistence: SessionPersistence | null
  readonly emit: (event: AgentEvent) => void
}

/**
 * Build the first user message of a new turn, append it to history, persist
 * it, and emit `user_message`. Runtime markers follow orphan-repair results
 * because tool_result blocks must be immediately after their matching
 * tool_use.
 */
export async function appendInitialUserTurn(
  deps: InitialUserTurnDeps,
  opts: {
    userText: string
    orphanRepair: ToolResultBlock[]
    turnMarker: "aborted" | "resumed" | null
    session: SessionContextTake
    turnContext: readonly HookContextEntry[] | undefined
  },
): Promise<void> {
  const { userText, orphanRepair, turnMarker } = opts
  const initialUserContent = await buildInitialUserContent(
    {
      modeProvider: deps.modeProvider,
      promptContributors: deps.promptContributors,
      mediaResolver: deps.mediaResolver,
      diagnostics: deps.diagnostics,
      text: deps.text,
      ...(deps.sideband ? { sideband: deps.sideband } : {}),
      ...(deps.model ? { model: deps.model } : {}),
    },
    opts,
  )

  const tp = deps.turnContentProviders
  if (tp.length > 0) {
    await appendInitialTurnContent(initialUserContent, tp, turnMarker, deps.diagnostics)
  }
  // No content (empty user text, marker with no text): add no empty message.
  if (initialUserContent.length > 0) appendUserTurn(deps.messages, initialUserContent)

  const userRecordContent =
    orphanRepair.length > 0
      ? initialUserContent.filter((b) => b.type !== "tool_result")
      : initialUserContent
  if (userRecordContent.length > 0) {
    deps.persistence?.appendUser(userRecordContent)
  }
  if (userText.length > 0) deps.emit({ type: "user_message", text: userText })
}

/**
 * The tool schemas one turn advertises to the model. Advertisement-time
 * filter (CLI `--tools` / SDK allow-list). Mode gating is deliberately NOT
 * applied here — modes keep the tool schema byte-stable and refuse at
 * dispatch. Prefer `config.toolFilter`; the deprecated
 * ModeProvider.filterTools is a last-resort fallback only.
 */
export function advertisedToolSchemas(
  registry: ToolRegistry,
  filter: ToolAdvertisementFilter | null,
  modeProvider: ModeProvider | null,
): RoundTools {
  const allTools: ReturnType<ToolRegistry["list"]> = registry.list()
  const advertisedTools =
    filter?.filter(allTools) ?? modeProvider?.filterTools?.(allTools) ?? allTools
  // M8: a tool with no text has no `description` key.
  return advertisedTools.map((t) =>
    t.description === undefined
      ? { name: t.name, input_schema: t.input_schema }
      : { name: t.name, description: t.description, input_schema: t.input_schema },
  )
}
