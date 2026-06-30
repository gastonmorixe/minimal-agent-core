/**
 * AgentCore: port-injected agentic loop for the minimal-agent SDK.
 *
 * Extracted from `src/agent.ts` with all CLI/TUI/plugin dependencies
 * replaced by port interfaces from `src/sdk/ports.ts`. The core depends
 * only on structural interfaces; hosts (CLI, SDK, test harness) inject
 * concrete implementations at construction.
 *
 * Design principles (from software-best-design-patterns):
 *   - Dependency Inversion (DIP): core depends on ports, not concretions.
 *   - Functional core, imperative shell: pure logic inside, I/O at edges.
 *   - Single Responsibility: one reason to change (the agentic loop).
 *
 * @module sdk/agent-core
 */

import { withRollingCacheBreakpoint } from "../agent/cache.ts"
import {
  repairOrphanedToolUse as repairOrphanedToolUseImpl,
  rollbackPendingTurn as rollbackPendingTurnImpl,
} from "../agent/history-repair.ts"
import { type AskUserFn, runPreflightPipeline } from "../agent/preflight-pipeline.ts"
import {
  buildReflectionCheckpointBlock,
  DEFAULT_REFLECTION_COOLDOWN_MS,
  DEFAULT_REFLECTION_INTERVAL,
  parseReflectionAck,
} from "../agent/reflection.ts"
import type { AuthResult } from "../auth.ts"
import type { StopReason } from "../llm/canonical-events.ts"
import {
  clampMaxOutputTokens,
  type EstimableTool,
  estimateRequestInputTokens,
} from "../llm/context-budget.ts"
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import { findModel, findModelForProvider } from "../llm/model-registry.ts"
import { resolveSystemPromptForModel } from "../llm/system-prompt.ts"
import { selectedTransport } from "../llm/transport/select-transport.ts"
import type { SystemBlock } from "../llm/transport/types.ts"
import {
  normalizeModelForAPI,
  type SendOptions,
  type StreamedResponse,
  type TransportFn,
} from "../llm/transport/types.ts"
import { createReflectionAckStripper } from "../reflection-ack-stripper.ts"
import { appendUserTurn } from "../session-restore.ts"

import { c } from "./ansi.ts"
import type { AgentEvent, EventSink, EventUsage } from "./events.ts"
import type {
  AbortSignalProvider,
  AgentCoreConfig,
  MediaResolver,
  ModeProvider,
  PromptContributor,
  SessionPersistence,
  TerminalMetrics,
  ToolDefinition,
  ToolExecutor,
  ToolRegistry,
  TranscriptSink,
} from "./ports.ts"

type MaybePromise<T> = T | Promise<T>

const MAX_TOKENS_CONTINUATION_CAP = 5

/**
 * Project a transport usage snapshot onto the host-facing {@link EventUsage}
 * shape (the four counters a `--json` consumer reports). Missing counters
 * default to 0 so `turn_completed.usage` is always a complete object, per the
 * frozen event contract (usage is REQUIRED on turn_completed).
 */
/**
 * Narrow the transport's free-form `string | null` stop reason to the
 * canonical {@link StopReason} union the event surface expects. The transport
 * already only emits canonical values; this is a type-level bridge, not a
 * runtime validation (an unknown string passes through as the event's value).
 */
function toEventStopReason(stopReason: string | null): StopReason | null {
  return stopReason as StopReason | null
}

function toEventUsage(usage: StreamedResponse["usage"] | undefined): EventUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(usage?.cache_read_input_tokens !== undefined
      ? { cacheReadTokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage?.cache_creation_input_tokens !== undefined
      ? { cacheCreationTokens: usage.cache_creation_input_tokens }
      : {}),
  }
}

/**
 * Terminal-agnostic agentic loop driven entirely by injected ports.
 *
 * Owns the append-only conversation history and the send/run loop, but depends
 * only on the structural ports in {@link AgentCoreConfig} (tool registry/executor,
 * transcript + event sinks, session persistence, prompt/mode/media providers).
 * No CLI/TUI/plugin imports, no `process` globals. Hosts (CLI, SDK, tests) wire
 * concrete adapters to the ports and construct the core; the same core powers an
 * interactive REPL, a `--json` event stream, or an in-process SDK call.
 */
export class AgentCore {
  readonly messages: Message[] = []
  private model: string
  private providerId?: string
  private auth: AuthResult
  private effort: string | undefined
  private speed: "normal" | "fast"
  private serviceTier: string | undefined
  private thinkingDisplay: "summarized" | "omitted" | undefined
  private sendFn: TransportFn
  private networkClient: import("../network/index.ts").NetworkClient | undefined
  private toolRegistry: ToolRegistry
  private toolExecutor: ToolExecutor
  private transcriptSink: TranscriptSink
  private sessionPersistence: SessionPersistence | null
  private promptContributors: PromptContributor[]
  private modeProvider: ModeProvider | null
  private mediaResolver: MediaResolver | null
  private abortSignalProvider: AbortSignalProvider | null
  private terminalMetrics: TerminalMetrics | null
  private maxToolRounds: number = Number.POSITIVE_INFINITY
  private reflectionInterval: number = DEFAULT_REFLECTION_INTERVAL
  private reflectionCooldownMs: number = DEFAULT_REFLECTION_COOLDOWN_MS
  private reflectionSilenceRemaining = 0
  private previousTurnAborted = false
  private eventSink: EventSink | null

  constructor(config: AgentCoreConfig) {
    this.model = config.model
    this.providerId = config.providerId
    this.auth = config.auth
    this.sendFn = config.sendFn ?? selectedTransport
    this.networkClient = config.networkClient
    this.toolRegistry = config.toolRegistry
    this.toolExecutor = config.toolExecutor
    this.transcriptSink = config.transcriptSink
    this.sessionPersistence = config.sessionPersistence ?? null
    this.promptContributors = config.promptContributors ?? []
    this.modeProvider = config.modeProvider ?? null
    this.mediaResolver = config.mediaResolver ?? null
    this.abortSignalProvider = config.abortSignalProvider ?? null
    this.terminalMetrics = config.terminalMetrics ?? null
    this.eventSink = config.eventSink ?? null
    this.effort = config.effort
    this.speed = "normal"
    this.serviceTier = config.serviceTier
    this.thinkingDisplay = config.thinkingDisplay
    if (typeof config.reflectionInterval === "number" && config.reflectionInterval >= 0) {
      this.reflectionInterval = Math.floor(config.reflectionInterval)
    }
    if (typeof config.reflectionCooldownMs === "number" && config.reflectionCooldownMs >= 0) {
      this.reflectionCooldownMs = Math.floor(config.reflectionCooldownMs)
    }
    if (typeof config.maxToolRounds === "number" && config.maxToolRounds > 0) {
      this.maxToolRounds = Math.floor(config.maxToolRounds)
    }
    if (config.initialMessages && config.initialMessages.length > 0) {
      for (const m of config.initialMessages) this.messages.push(m)
    }
  }

  getModel(): string {
    return this.model
  }

  setModel(model: string): void {
    this.model = model
  }

  history(): Message[] {
    return [...this.messages]
  }

  /**
   * Emit one structured {@link AgentEvent} to the configured sink, if any.
   *
   * Best-effort and NON-THROWING: a sink that throws must never abort the
   * agent loop. `emit` is called from inside `run()` at the lifecycle seams,
   * so a throwing consumer (a broken `--json` writer, a full pipe) is
   * swallowed here. No-op when no sink was configured.
   */
  private emit(event: AgentEvent): void {
    if (!this.eventSink) return
    try {
      this.eventSink.emit(event)
    } catch {
      // Best-effort: a throwing sink never breaks the run.
    }
  }

  rollbackPendingTurn(): boolean {
    return rollbackPendingTurnImpl(this.messages)
  }

  notePreviousTurnAborted(): void {
    this.previousTurnAborted = true
  }

  pushSystemMessage(text: string): void {
    this.messages.push({ role: "system", content: text })
  }

  repairOrphanedToolUse(): ToolResultBlock[] {
    return repairOrphanedToolUseImpl(this.messages, null)
  }

  private resolveMaxOutputTokens(ctx?: {
    system?: SystemBlock[]
    tools?: EstimableTool[]
  }): number | undefined {
    const apiModel = normalizeModelForAPI(this.model)
    const entry = this.providerId
      ? (findModelForProvider(apiModel, this.providerId) ?? findModel(apiModel))
      : findModel(apiModel)
    if (!entry) return undefined
    const modelMax = entry.capabilities.maxOutputTokens
    const contextWindow = entry.capabilities.contextWindow
    if (!entry.capabilities.outputTokensShareContextWindow) return modelMax
    const inputTokens = estimateRequestInputTokens({
      modelId: apiModel,
      estimateTokens: entry.estimateTokens,
      messages: this.messages,
      ...(ctx?.system ? { system: ctx.system } : {}),
      ...(ctx?.tools ? { tools: ctx.tools } : {}),
    })
    return clampMaxOutputTokens({ modelMax, contextWindow, inputTokens })
  }

  async *run(
    userText: string,
    opts?: Partial<SendOptions> & {
      onThinkingStart?: () => MaybePromise<void>
      onThinkingChunk?: (chunk: string) => MaybePromise<void>
      onThinkingStop?: () => MaybePromise<void>
      onTextStop?: () => MaybePromise<void>
      drainQueuedUserText?: () => string | null
      onQueueInject?: (text: string) => void
      signal?: AbortSignal
      askUser?: AskUserFn
    },
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    const {
      onThinkingStart,
      onThinkingChunk,
      onThinkingStop,
      onTextStop,
      drainQueuedUserText,
      onQueueInject,
      signal,
      askUser,
      ...sendOpts
    } = opts ?? {}
    const thinkingStart = onThinkingStart
    const onThinkingDelta = onThinkingChunk ?? sendOpts.onThinkingDelta
    const thinkingStop = onThinkingStop
    const textStop = onTextStop
    const writeTranscript = (line: string): void => {
      this.transcriptSink.write(line)
    }

    const initialUserContent: ContentBlock[] = []

    const orphanRepair = this.repairOrphanedToolUse()
    for (const b of orphanRepair) initialUserContent.push(b)

    if (this.previousTurnAborted) {
      this.previousTurnAborted = false
      initialUserContent.push({
        type: "text",
        text: "<ma::agent::turn-aborted />\nThe previous turn was interrupted by the user before it finished. Everything already completed above is preserved (this is not an error). Treat the earlier plan as paused: address the new instruction below, and do not silently resume the prior plan unless the user asks you to continue it.",
      })
    }

    const initialModeAttach = this.modeProvider?.consumePendingAttachment?.() ?? null
    if (initialModeAttach) initialUserContent.push(initialModeAttach)

    for (const contributor of this.promptContributors) {
      const blocks = contributor.turnAttachments?.() ?? []
      for (const b of blocks) initialUserContent.push(b)
    }

    for (const contributor of this.promptContributors) {
      const echoes = contributor.saveEchoes?.() ?? []
      for (const e of echoes) initialUserContent.push(e)
    }

    if (userText.length > 0) {
      if (this.mediaResolver) {
        initialUserContent.push(...(await this.mediaResolver.resolveUserContent(userText)))
      } else {
        initialUserContent.push({ type: "text", text: userText })
      }
    }

    appendUserTurn(this.messages, initialUserContent)

    const userRecordContent =
      orphanRepair.length > 0
        ? initialUserContent.filter((b) => b.type !== "tool_result")
        : initialUserContent
    if (userRecordContent.length > 0) {
      this.sessionPersistence?.appendUser(userRecordContent)
    }

    let rounds = 0
    let maxTokensStreak = 0
    this.reflectionSilenceRemaining = 0
    let exitedByCap = true
    let lastResponse: StreamedResponse = {
      blocks: [],
      text: "",
      stopReason: null,
    }

    const systemPromptBlocks: ContentBlock[] = []
    for (const contributor of this.promptContributors) {
      const blocks = contributor.systemPromptBlocks?.() ?? []
      for (const b of blocks) systemPromptBlocks.push(b)
    }

    const system = resolveSystemPromptForModel(normalizeModelForAPI(this.model), {
      sessionContext:
        systemPromptBlocks.length > 0
          ? systemPromptBlocks.map((b) => (b.type === "text" ? b.text : "")).join("\n")
          : undefined,
      reflectionInterval: this.reflectionInterval,
      reflectionCooldownMs: this.reflectionCooldownMs,
      maxToolRounds: this.maxToolRounds,
      blobStoreEnabled: false,
    })

    const allTools: ToolDefinition[] = this.toolRegistry.list()

    const mergedTools: Array<{
      name: string
      description: string
      input_schema: Record<string, unknown>
    }> = allTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))

    while (rounds < this.maxToolRounds) {
      if (signal?.aborted) {
        this.emit({ type: "error", message: "aborted" })
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      }
      rounds++
      // A new assistant turn (one model response) begins. `turn` is the
      // monotonic round index per the frozen event contract.
      this.emit({ type: "turn_started", turn: rounds })

      if (askUser) {
        const preflightResult = await runPreflightPipeline({
          messages: this.messages,
          modelId: this.model,
          askUser,
        })
        if (preflightResult.cancelled) {
          this.emit({ type: "error", message: "aborted" })
          throw Object.assign(new Error("aborted"), { name: "AbortError" })
        }
        if (preflightResult.adoptModelId) {
          this.model = preflightResult.adoptModelId
        }
        if (preflightResult.messages !== this.messages) {
          this.messages.length = 0
          for (const m of preflightResult.messages) this.messages.push(m)
        }
      }

      const maxOutputTokens = this.resolveMaxOutputTokens({ system, tools: mergedTools })
      const gen = this.sendFn({
        auth: this.auth,
        messages: withRollingCacheBreakpoint(this.messages),
        model: this.model,
        selectedProviderId: this.providerId,
        ...(this.networkClient ? { networkClient: this.networkClient } : {}),
        tools: mergedTools,
        system,
        ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
        ...(this.effort ? { outputConfig: { effort: this.effort } } : {}),
        ...(this.speed === "fast" ? { speed: "fast" as const } : {}),
        ...(this.serviceTier ? { serviceTier: this.serviceTier } : {}),
        ...(this.thinkingDisplay
          ? { thinking: { type: "adaptive" as const, display: this.thinkingDisplay } }
          : {}),
        ...sendOpts,
        ...(thinkingStart ? { onThinkingStart: thinkingStart } : {}),
        ...(onThinkingDelta ? { onThinkingDelta } : {}),
        ...(thinkingStop ? { onThinkingStop: thinkingStop } : {}),
        ...(textStop ? { onTextStop: textStop } : {}),
        ...(signal ? { signal } : {}),
      })

      let response: StreamedResponse | undefined
      const ackStripper = createReflectionAckStripper()
      while (true) {
        const { done, value } = await gen.next()
        if (done) {
          response = value as unknown as StreamedResponse
          const tail = ackStripper.flush()
          if (tail.length > 0) yield tail
          break
        }
        const cleaned = ackStripper.write(value)
        if (cleaned.length > 0) yield cleaned
      }

      lastResponse = response ?? { blocks: [], text: "", stopReason: null }

      if (lastResponse.blocks.length > 0) {
        this.messages.push({ role: "assistant", content: lastResponse.blocks })
        this.sessionPersistence?.appendAssistant(
          lastResponse.blocks,
          lastResponse.stopReason,
          lastResponse.usage,
        )
        // Structured per-item events. itemType maps the three content-block
        // categories; the correlation id is the tool_use block id for a tool
        // call (so the later tool_result joins on it), or an index-derived id
        // `${rounds}:${i}` for text/thinking (which carry no native id).
        for (let i = 0; i < lastResponse.blocks.length; i++) {
          const block = lastResponse.blocks[i]
          if (block === undefined) continue
          if (block.type !== "text" && block.type !== "tool_use" && block.type !== "thinking") {
            continue
          }
          const itemType = block.type
          const id = block.type === "tool_use" ? block.id : `${rounds}:${i}`
          const label = block.type === "tool_use" ? block.name : undefined
          const text =
            block.type === "tool_use"
              ? block.name
              : block.type === "text"
                ? block.text
                : block.type === "thinking"
                  ? (block.thinking ?? "")
                  : undefined
          this.emit({
            type: "item_started",
            itemType,
            id,
            ...(label !== undefined ? { label } : {}),
          })
          this.emit({
            type: "item_completed",
            itemType,
            id,
            ...(text !== undefined ? { text } : {}),
          })
        }
      }

      if (this.reflectionInterval > 0 && lastResponse.text.length > 0) {
        const ack = parseReflectionAck(lastResponse.text)
        if (ack !== null && ack.silenceFor > 0) {
          this.reflectionSilenceRemaining = ack.silenceFor
          const reasonSuffix = ack.reason.length > 0 ? ` — ${ack.reason}` : ""
          writeTranscript(
            `  ${c.dim("›")} ${c.dim(`reflection ack: silencing next ${ack.silenceFor} checkpoint${ack.silenceFor === 1 ? "" : "s"}${reasonSuffix}`)}`,
          )
        }
      }

      const toolBlocks = lastResponse.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use")

      if (this.reflectionSilenceRemaining === 0 && this.reflectionInterval > 0) {
        const ackTool = toolBlocks.find((b) => b.name === "reflection-ack")
        if (ackTool) {
          const silenceForRaw = ackTool.input["silence-for"]
          const reason = typeof ackTool.input.reason === "string" ? ackTool.input.reason : ""
          const silenceFor =
            typeof silenceForRaw === "string"
              ? Number.parseInt(silenceForRaw, 10)
              : typeof silenceForRaw === "number"
                ? Math.floor(silenceForRaw)
                : 1
          if (Number.isFinite(silenceFor) && silenceFor > 0) {
            this.reflectionSilenceRemaining = silenceFor
            const reasonSuffix = reason.length > 0 ? ` — ${reason}` : ""
            writeTranscript(
              `  ${c.dim("›")} ${c.dim(`reflection ack: silencing next ${silenceFor} checkpoint${silenceFor === 1 ? "" : "s"}${reasonSuffix} (from tool_use fallback)`)}`,
            )
          }
        }
      }

      if (lastResponse.stopReason === "max_tokens") {
        if (toolBlocks.length > 0) {
          maxTokensStreak = 0
          writeTranscript(
            `\n  ${c.boldYellow("!")} ${c.yellow("Response hit the max_tokens ceiling mid tool-call — salvaged the in-flight call and continuing")}`,
          )
        } else {
          maxTokensStreak++
          if (maxTokensStreak <= MAX_TOKENS_CONTINUATION_CAP) {
            writeTranscript(
              `\n  ${c.boldYellow("!")} ${c.yellow(`Response hit the max_tokens ceiling — auto-continuing (${maxTokensStreak}/${MAX_TOKENS_CONTINUATION_CAP})`)}`,
            )
            if (lastResponse.blocks.length === 0) {
              const placeholder: ContentBlock[] = [
                {
                  type: "text",
                  text: "[response truncated at the output-token limit before any content was produced]",
                },
              ]
              this.messages.push({ role: "assistant", content: placeholder })
              this.sessionPersistence?.appendAssistant(
                placeholder,
                lastResponse.stopReason,
                lastResponse.usage,
              )
            }
            const cont: ContentBlock[] = [
              {
                type: "text",
                text:
                  "<ma::agent::output-truncated />\n" +
                  "Your previous response was cut off at the max_tokens output ceiling. Continue exactly from where you stopped. Do not repeat what you already wrote. If you were about to call a tool, issue that tool call now.",
              },
            ]
            this.messages.push({ role: "user", content: cont })
            this.sessionPersistence?.appendUser(cont)
            continue
          }
          writeTranscript(
            `\n  ${c.boldYellow("!")} ${c.yellow(`Response hit the max_tokens ceiling ${MAX_TOKENS_CONTINUATION_CAP} times in a row — stopping. Consider narrowing the request or raising max_tokens.`)}`,
          )
          exitedByCap = false
          break
        }
      } else {
        maxTokensStreak = 0
      }

      if (toolBlocks.length === 0) {
        const pendingMode = this.modeProvider?.consumePendingAttachment?.() ?? null
        if (pendingMode != null && !signal?.aborted) {
          const userContent: ContentBlock[] = [pendingMode]
          this.messages.push({ role: "user", content: userContent })
          this.sessionPersistence?.appendUser(userContent)
          continue
        }
        // Natural exit: the model returned no tool calls. The turn settled,
        // so emit turn_completed with the final stop reason + usage.
        this.emit({
          type: "turn_completed",
          turn: rounds,
          stopReason: toEventStopReason(lastResponse.stopReason),
          usage: toEventUsage(lastResponse.usage),
        })
        exitedByCap = false
        break
      }

      const toolResults: ToolResultBlock[] = []
      for (const tool of toolBlocks) {
        const result = await this.toolExecutor.execute(tool, signal)
        const toolResult: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: tool.id,
          content: result.content,
          is_error: result.isError,
        }
        toolResults.push(toolResult)
        this.sessionPersistence?.appendToolResult(toolResult)
        // The tool result joins back to its item_started on the SAME id
        // (the tool_use block id), per the frozen correlation contract.
        this.emit({
          type: "tool_result",
          id: tool.id,
          name: tool.name,
          isError: result.isError,
        })
      }
      // A turn that executed tools also settled here (next iteration is a
      // fresh model response). Emit turn_completed before looping.
      this.emit({
        type: "turn_completed",
        turn: rounds,
        stopReason: toEventStopReason(lastResponse.stopReason),
        usage: toEventUsage(lastResponse.usage),
      })

      const userContent: ContentBlock[] = []
      userContent.push(...toolResults)
      const loopModeAttach = this.modeProvider?.consumePendingAttachment?.() ?? null
      if (loopModeAttach) userContent.push(loopModeAttach)
      for (const contributor of this.promptContributors) {
        const echoes = contributor.saveEchoes?.() ?? []
        for (const e of echoes) userContent.push(e)
      }
      const queuedText = drainQueuedUserText?.() ?? null
      if (queuedText && queuedText.trim().length > 0) {
        userContent.push({ type: "text", text: queuedText })
        this.sessionPersistence?.appendUser([{ type: "text", text: queuedText }])
        onQueueInject?.(queuedText)
      }

      if (this.reflectionInterval > 0 && rounds % this.reflectionInterval === 0) {
        if (this.reflectionSilenceRemaining > 0) {
          this.reflectionSilenceRemaining -= 1
        } else {
          userContent.push(buildReflectionCheckpointBlock(rounds, this.reflectionCooldownMs))
        }
      }

      this.messages.push({ role: "user", content: userContent })
    }

    if (exitedByCap && Number.isFinite(this.maxToolRounds)) {
      writeTranscript(
        `\n  ${c.boldYellow("!")} ${c.yellow(`Emergency cap reached (${this.maxToolRounds} tool rounds) — sending final tools-disabled wrap-up`)}`,
      )

      const lastMsg = this.messages[this.messages.length - 1]
      if (lastMsg && lastMsg.role === "user") {
        const content = Array.isArray(lastMsg.content)
          ? lastMsg.content
          : [{ type: "text" as const, text: lastMsg.content }]
        content.push({
          type: "text",
          text:
            `<ma::agent::emergency-cap-triggered round="${this.maxToolRounds}" />\n` +
            "You have reached the configured emergency tool-round cap for this user turn. Tools are disabled for this final response. Summarize what you accomplished, surface anything the user should know, and stop.",
        })
        lastMsg.content = content
      }

      const wrapGen = this.sendFn({
        auth: this.auth,
        messages: withRollingCacheBreakpoint(this.messages),
        model: this.model,
        ...(this.networkClient ? { networkClient: this.networkClient } : {}),
        system,
        ...((): { maxTokens?: number } => {
          const mt = this.resolveMaxOutputTokens({ system })
          return mt !== undefined ? { maxTokens: mt } : {}
        })(),
        ...(this.effort ? { outputConfig: { effort: this.effort } } : {}),
        ...(this.speed === "fast" ? { speed: "fast" as const } : {}),
        ...(this.serviceTier ? { serviceTier: this.serviceTier } : {}),
        ...(this.thinkingDisplay
          ? { thinking: { type: "adaptive" as const, display: this.thinkingDisplay } }
          : {}),
        ...sendOpts,
        ...(thinkingStart ? { onThinkingStart: thinkingStart } : {}),
        ...(onThinkingDelta ? { onThinkingDelta } : {}),
        ...(thinkingStop ? { onThinkingStop: thinkingStop } : {}),
        ...(textStop ? { onTextStop: textStop } : {}),
        ...(signal ? { signal } : {}),
      })
      let wrapResponse: StreamedResponse | undefined
      const wrapAckStripper = createReflectionAckStripper()
      while (true) {
        const { done, value } = await wrapGen.next()
        if (done) {
          wrapResponse = value as unknown as StreamedResponse
          const tail = wrapAckStripper.flush()
          if (tail.length > 0) yield tail
          break
        }
        const cleaned = wrapAckStripper.write(value)
        if (cleaned.length > 0) yield cleaned
      }
      if (wrapResponse) {
        lastResponse = wrapResponse
        if (wrapResponse.blocks.length > 0) {
          this.messages.push({ role: "assistant", content: wrapResponse.blocks })
          this.sessionPersistence?.appendAssistant(
            wrapResponse.blocks,
            wrapResponse.stopReason,
            wrapResponse.usage,
          )
        }
      }
    }

    return lastResponse
  }

  async *send(
    userText: string,
    opts?: Partial<SendOptions>,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: userText }],
    })

    const sendMaxTokens = this.resolveMaxOutputTokens()
    const gen = this.sendFn({
      auth: this.auth,
      messages: withRollingCacheBreakpoint(this.messages),
      model: this.model,
      ...(this.networkClient ? { networkClient: this.networkClient } : {}),
      ...(sendMaxTokens !== undefined ? { maxTokens: sendMaxTokens } : {}),
      ...(this.effort ? { outputConfig: { effort: this.effort } } : {}),
      ...(this.speed === "fast" ? { speed: "fast" as const } : {}),
      ...(this.serviceTier ? { serviceTier: this.serviceTier } : {}),
      ...(this.thinkingDisplay
        ? { thinking: { type: "adaptive" as const, display: this.thinkingDisplay } }
        : {}),
      ...opts,
    })

    let response: StreamedResponse | undefined
    const ackStripper = createReflectionAckStripper()
    while (true) {
      const { done, value } = await gen.next()
      if (done) {
        response = value as unknown as StreamedResponse
        const tail = ackStripper.flush()
        if (tail.length > 0) yield tail
        break
      }
      const cleaned = ackStripper.write(value)
      if (cleaned.length > 0) yield cleaned
    }

    const result = response ?? { blocks: [], text: "", stopReason: null }

    if (result.blocks.length > 0) {
      this.messages.push({ role: "assistant", content: result.blocks })
    }

    return result
  }
}
