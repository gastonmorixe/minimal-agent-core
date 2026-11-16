/**
 * Round steps extracted from {@link AgentCore} so that file stays under the
 * 810-line gate: append the first user message of a turn, record a model
 * response, read a reflection ack sent as a tool call, and list the tools
 * one turn advertises. Pure moves: the core passes its state in as deps.
 *
 * The types come through `import()` type positions (like
 * agent-core-helpers.ts does) so the SDK type-only import inventory
 * (src/architecture/sdk-port-boundaries.test.ts) does not grow.
 *
 * @module sdk/agent-core-round
 */

import { parseReflectionAck } from "../agent/reflection.ts"
import { appendInitialTurnContent } from "../agent/turn-content.ts"

import {
  buildInitialUserContent,
  type InitialUserContentDeps,
  itemEvents,
  type NoticeEmitter,
} from "./agent-core-helpers.ts"
import { appendUserTurn } from "./conversation-history.ts"

type Message = import("../llm/messages.ts").Message
type ToolResultBlock = import("../llm/messages.ts").ToolResultBlock
type Diagnostics = import("../diagnostics/hub.ts").Diagnostics
type HookContextEntry = import("./hook-context.ts").HookContextEntry
type SessionContextTake = import("./session-context.ts").SessionContextTake
type TurnContentProviders = NonNullable<
  import("./ports.ts").AgentCoreConfig["turnContentProviders"]
>
type ToolUseBlock = import("../llm/messages.ts").ToolUseBlock
type StreamedResponse = import("../llm/transport/types.ts").StreamedResponse
type AgentEvent = import("./events.ts").AgentEvent
type SessionPersistence = import("./ports.ts").SessionPersistence
type ToolRegistry = import("./ports.ts").ToolRegistry
type ToolAdvertisementFilter = import("./ports.ts").ToolAdvertisementFilter
type ModeProvider = import("./ports.ts").ModeProvider
type RoundTools = NonNullable<import("./send-attempt.ts").RoundRequest["tools"]>

/** What the reflection ack steps read and write on the core. */
export interface ReflectionAckDeps {
  readonly reflectionInterval: number
  readonly reflectionSilenceRemaining: number
  readonly setReflectionSilence: (silenceFor: number) => void
  readonly emitNotice: NoticeEmitter
}

/** What {@link recordModelResponse} needs from the core. */
export interface ResponseRecordDeps extends ReflectionAckDeps {
  readonly messages: Message[]
  readonly persistence: SessionPersistence | null
  readonly emit: (event: AgentEvent) => void
}

/**
 * Record a model response: history, session log, the item events, and a
 * reflection ack the model wrote in its text.
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
  if (deps.reflectionInterval > 0 && response.text.length > 0) {
    const ack = parseReflectionAck(response.text)
    if (ack !== null && ack.silenceFor > 0) {
      deps.setReflectionSilence(ack.silenceFor)
      deps.emitNotice({
        kind: "reflection_ack",
        severity: "info",
        silenceFor: ack.silenceFor,
        reason: ack.reason,
        fromToolFallback: false,
      })
    }
  }
}

/** A reflection ack sent as a `reflection-ack` tool call (fallback path). */
export function noteReflectionAckTool(deps: ReflectionAckDeps, toolBlocks: ToolUseBlock[]): void {
  if (deps.reflectionSilenceRemaining !== 0 || deps.reflectionInterval <= 0) return
  const ackTool = toolBlocks.find((b) => b.name === "reflection-ack")
  if (!ackTool) return
  const silenceForRaw = ackTool.input["silence-for"]
  const reason = typeof ackTool.input.reason === "string" ? ackTool.input.reason : ""
  const silenceFor =
    typeof silenceForRaw === "string"
      ? Number.parseInt(silenceForRaw, 10)
      : typeof silenceForRaw === "number"
        ? Math.floor(silenceForRaw)
        : 1
  if (Number.isFinite(silenceFor) && silenceFor > 0) {
    deps.setReflectionSilence(silenceFor)
    deps.emitNotice({
      kind: "reflection_ack",
      severity: "info",
      silenceFor,
      reason,
      fromToolFallback: true,
    })
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
    },
    opts,
  )

  const tp = deps.turnContentProviders
  if (tp.length > 0) {
    await appendInitialTurnContent(initialUserContent, tp, turnMarker, deps.diagnostics)
  }
  appendUserTurn(deps.messages, initialUserContent)

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
