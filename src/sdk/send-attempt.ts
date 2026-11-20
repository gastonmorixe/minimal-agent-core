/**
 * The transport seam, extracted from {@link AgentCore} so that file stays
 * under the 810-line gate: one send of the current history. Streams the
 * text and returns the response, or the thrown error as data so the loop can decide from its class.
 *
 * Pure over explicit deps: every `this.*` read becomes a struct field.
 * `sendAttempt` mutates nothing on the core except through `emit`.
 *
 * @module sdk/send-attempt
 */

import { withRollingCacheBreakpoint } from "../agent/cache.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { PluginEventsPort } from "../bus/plugin-events-port.ts"
import type { StatusPort } from "../bus/status-port.ts"
import type { CacheTtl } from "../cache/cache-ttl.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { Message } from "../llm/messages.ts"
import type { SystemBlock } from "../llm/transport/types.ts"
import {
  type SendOptions,
  type StreamBlockEdge,
  type StreamedResponse,
  type TransportFn,
} from "../llm/transport/types.ts"
import type { NetworkClient } from "../network/index.ts"

import type { MaybePromise } from "./agent-core-helpers.ts"
import { EMPTY_RESPONSE } from "./agent-core-helpers.ts"
import {
  type CacheSendState,
  keepsThinkingHistory,
  latchStripAfterRejection,
  rollingCacheOptions,
} from "./cache-send-policy.ts"
import type { AgentEvent } from "./events.ts"
import { outputConfigSpread as buildOutputConfig } from "./output-config.ts"
import type { RunOutputStrict } from "./run-output-strict.ts"
import {
  type RunTemperatureState,
  resolveMaxOutputTokens,
  runTemperatureOption,
} from "./run-temperature.ts"

/** Per-turn request parts that every attempt of every round reuses. */
export interface RoundRequest {
  system?: SystemBlock[]
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>
  sendOpts: Partial<SendOptions>
  onThinkingDelta?: (text: string) => MaybePromise<void>
  signal?: AbortSignal
  emitDeltas?: boolean
}

/** One attempt: the response, or the thrown error as data. */
export type AttemptSend =
  | { kind: "response"; response: StreamedResponse }
  | { kind: "error"; err: unknown; yielded: boolean }

/** Every `this.*` read `sendAttempt` makes, as explicit values. */
export interface SendAttemptDeps {
  runOutputSchema: object | undefined
  outputSchema: object | undefined
  strict: RunOutputStrict
  model: string
  providerId: string | undefined
  messages: Message[]
  diagnostics: Diagnostics
  credentialName: string | undefined
  networkClient: NetworkClient | undefined
  effort: string | undefined
  runTemp: RunTemperatureState
  speed: "normal" | "fast"
  serviceTier: string | undefined
  thinkingDisplay: "summarized" | "omitted" | undefined
  defaultStatusPort: StatusPort | undefined
  defaultPluginEvents: PluginEventsPort | undefined
  cacheTtl: CacheTtl
  /** Prompt-cache flags + F2b latch (`cache-send-policy.ts`). Absent: today's request. */
  cacheSend?: CacheSendState
  auth: AuthResult
  sendFn: TransportFn
  emit: (event: AgentEvent) => void
}

/** Wrap `onThinkingDelta` for the realtime path (deltas + transport callback). */
export function wrapThinkingDelta(
  emit: (event: AgentEvent) => void,
  inner: ((text: string) => MaybePromise<void>) | undefined,
  emitDeltas: boolean | undefined,
  round: number,
): ((text: string) => MaybePromise<void>) | undefined {
  if (!emitDeltas) return inner
  const id = `${round}:thinking`
  return (text: string): MaybePromise<void> => {
    if (text.length > 0) emit({ type: "thinking_delta", id, text })
    return inner?.(text)
  }
}

/** The transport's block-edge hook for one round on the realtime path. */
export function blockEdgeEmitter(
  emit: (event: AgentEvent) => void,
  round: number,
): (edge: StreamBlockEdge) => void {
  return ({ block, edge }) => {
    const id = `${round}:${block}`
    emit({ type: edge === "start" ? "block_started" : "block_stopped", itemType: block, id })
  }
}

/**
 * One send of the current history. Streams the text and returns the
 * response, or the thrown error as data so the loop can decide from its
 * class.
 *
 * @yields Cleaned text deltas.
 */
export async function* sendAttemptInto(
  deps: SendAttemptDeps,
  req: RoundRequest,
  round: number,
): AsyncGenerator<string, AttemptSend, undefined> {
  const keep = keepsThinkingHistory(deps.cacheSend, deps.model, deps.providerId)
  const first = yield* sendOnce(deps, req, round, keep)
  // F2b: the kept history was rejected before any output. Latch strip mode
  // for the session and resend the same turn once, stripped.
  if (
    first.kind === "error" &&
    keep &&
    !first.yielded &&
    latchStripAfterRejection(deps.cacheSend, first.err, deps.diagnostics, deps.model)
  ) {
    return yield* sendOnce(deps, req, round, false)
  }
  return first
}

/** One send with a fixed thinking-history choice. */
async function* sendOnce(
  deps: SendAttemptDeps,
  req: RoundRequest,
  round: number,
  keepThinking: boolean,
): AsyncGenerator<string, AttemptSend, undefined> {
  const schema = deps.runOutputSchema ?? deps.outputSchema
  // R2/R4. The session bridges the once-per-run strict warn into a `ch: "diag"` entry.
  const strict = deps.strict.forRequest(schema, deps.model, deps.providerId, deps.diagnostics)
  const maxOutputTokens = resolveMaxOutputTokens(deps.model, deps.providerId, deps.messages, {
    ...(req.system ? { system: req.system } : {}),
    ...(req.tools ? { tools: req.tools } : {}),
  })
  // On the realtime path, forward the transport's thinking chunks as
  // `thinking_delta` events too (keyed to this turn). When emitDeltas is
  // off this is exactly the original callback, so transport behavior and
  // the frozen golden are unchanged.
  const onThinkingDelta = wrapThinkingDelta(deps.emit, req.onThinkingDelta, req.emitDeltas, round)
  let yielded = false
  const out = (text: string): string => {
    yielded = true
    if (req.emitDeltas) deps.emit({ type: "text_delta", id: `${round}:text`, text })
    return text
  }
  try {
    const gen = deps.sendFn({
      auth: deps.auth,
      messages: withRollingCacheBreakpoint(
        deps.messages,
        deps.cacheTtl,
        rollingCacheOptions(deps.cacheSend, keepThinking),
      ),
      model: deps.model,
      selectedProviderId: deps.providerId,
      ...(deps.credentialName ? { credentialName: deps.credentialName } : {}),
      ...(deps.networkClient ? { networkClient: deps.networkClient } : {}),
      diagnostics: deps.diagnostics,
      ...(req.tools ? { tools: req.tools } : {}),
      ...(req.system ? { system: req.system } : {}),
      ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
      ...buildOutputConfig({ effort: deps.effort, outputSchema: schema, strict }),
      // D4. The session bridges the once-per-run warn into a `ch: "diag"` entry.
      ...runTemperatureOption(deps.runTemp, deps.model, deps.providerId, deps.diagnostics),
      ...(deps.speed === "fast" ? { speed: "fast" as const } : {}),
      ...(deps.serviceTier ? { serviceTier: deps.serviceTier } : {}),
      ...(deps.thinkingDisplay
        ? { thinking: { type: "adaptive" as const, display: deps.thinkingDisplay } }
        : {}),
      // Construction-time defaults (S23, S28); a per-call value in
      // req.sendOpts below wins.
      ...(deps.defaultStatusPort ? { statusPort: deps.defaultStatusPort } : {}),
      ...(deps.defaultPluginEvents ? { pluginEvents: deps.defaultPluginEvents } : {}),
      ...req.sendOpts,
      ...(onThinkingDelta ? { onThinkingDelta } : {}),
      ...(req.emitDeltas ? { onBlockEdge: blockEdgeEmitter(deps.emit, round) } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    })
    while (true) {
      const { done, value } = await gen.next()
      if (done) {
        return {
          kind: "response",
          response: (value as StreamedResponse | undefined) ?? EMPTY_RESPONSE,
        }
      }
      if (value.length > 0) yield out(value)
    }
  } catch (err) {
    return { kind: "error", err, yielded }
  }
}
