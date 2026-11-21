/**
 * Per-run sampling temperature (D4) and other per-request options read
 * from the current model's registry entry: helpers for `AgentCore`.
 *
 * The core owns one {@link RunTemperatureState} (the run value, the one-shot
 * pending value, and the once-per-run "ignored" flag). These helpers start a
 * run, decide per model request whether the value is sent, and report a
 * dropped value once per run.
 *
 * @module sdk/run-temperature
 */

import {
  clampMaxOutputTokens,
  type EstimableTool,
  estimateRequestInputTokens,
  utf8ByteLength,
} from "../llm/context-budget.ts"
import { findModel, findModelForProvider, type ModelEntry } from "../llm/model-registry.ts"
import { normalizeModelForAPI, type SystemBlock } from "../llm/transport/types.ts"

/** The conversation history shape the input-token estimate reads. */
type RequestMessages = Parameters<typeof estimateRequestInputTokens>[0]["messages"]

/**
 * The part of a diagnostics handle this module uses. Structural on purpose:
 * it keeps the SDK type-only import inventory unchanged.
 */
export interface WarnPort {
  /** Emit a `warn` diagnostic. */
  warn(source: string, message: string, data: { model: string; temperature: number }): void
}

/** The run temperature state the core keeps. */
export interface RunTemperatureState {
  /** Temperature of the current run. Set at run start, cleared in its `finally`. */
  value: number | undefined
  /** One-shot temperature for the NEXT run, from `setNextRunTemperature`. */
  pending: number | undefined
  /** True after this run reported that its model ignores temperature. */
  reported: boolean
}

/** A state with no run value, no pending value, and nothing reported. */
export function emptyRunTemperature(): RunTemperatureState {
  return { value: undefined, pending: undefined, reported: false }
}

/**
 * The state at the start of a run: the run option wins over the pending
 * one-shot value, the pending value is consumed, and the flag resets.
 */
export function startRunTemperature(
  runOption: number | undefined,
  pending: number | undefined,
): RunTemperatureState {
  return { value: runOption ?? pending, pending: undefined, reported: false }
}

/**
 * Registry entry of `model` (provider-scoped first, then global), or
 * `undefined` when the registry does not know the model.
 */
export function lookupModelEntry(model: string, providerId?: string): ModelEntry | undefined {
  const apiModel = normalizeModelForAPI(model)
  return providerId
    ? (findModelForProvider(apiModel, providerId) ?? findModel(apiModel))
    : findModel(apiModel)
}

/** The request parts that size the output-token cap. */
export type MaxOutputTokensContext = { system?: SystemBlock[]; tools?: EstimableTool[] }

/**
 * The `maxTokens` to send for `model`, or `undefined` when the registry does
 * not know it. A model whose output shares the context window gets its cap
 * clamped to the room left after the estimated request input.
 */
export function resolveMaxOutputTokens(
  model: string,
  providerId: string | undefined,
  messages: RequestMessages,
  ctx?: MaxOutputTokensContext,
): number | undefined {
  const entry = lookupModelEntry(model, providerId)
  if (!entry) return undefined
  const modelMax = entry.capabilities.maxOutputTokens
  const contextWindow = entry.capabilities.contextWindow
  if (!entry.capabilities.outputTokensShareContextWindow) return modelMax
  // The resolved entry's estimator when its provider set one. With none, the
  // input estimate is the UTF-8 byte upper bound (no ratio in core): it can
  // only make the cap smaller, never overflow the window. It is passed
  // explicitly, so a same-id entry of another provider cannot give its
  // estimator.
  const inputTokens = estimateRequestInputTokens({
    modelId: normalizeModelForAPI(model),
    ...(providerId ? { providerId } : {}),
    estimateTokens: entry.estimateTokens ?? utf8ByteLength,
    messages,
    ...(ctx?.system ? { system: ctx.system } : {}),
    ...(ctx?.tools ? { tools: ctx.tools } : {}),
  })
  return clampMaxOutputTokens({ modelMax, contextWindow, inputTokens })
}

/** Inputs to {@link resolveRunTemperature}. */
export interface ResolveRunTemperatureInput {
  /** Registry entry of the current model, or `undefined` when unknown. */
  entry: ModelEntry | undefined
  /** The run temperature, or `undefined` when the run has none. */
  temperature: number | undefined
}

/** Result of {@link resolveRunTemperature}. */
export interface ResolvedRunTemperature {
  /** The value to send on the request. Absent when nothing is sent. */
  send?: number
  /** True when a run temperature was set but the model does not accept it. */
  ignored: boolean
}

/**
 * Decides whether the run temperature goes on a request. No value: nothing
 * is sent. A model with no registry entry gets the value (the provider
 * gates it again). A model with `acceptsTemperature: false` gets nothing,
 * and the result is marked `ignored`.
 */
export function resolveRunTemperature(input: ResolveRunTemperatureInput): ResolvedRunTemperature {
  const { entry, temperature } = input
  if (temperature === undefined) return { ignored: false }
  if (!entry || entry.capabilities.acceptsTemperature) return { send: temperature, ignored: false }
  return { ignored: true }
}

/**
 * The run temperature to send on this request, as a spread-ready object.
 * Checked per request: a `setModel` can change the model inside the run.
 * When the value is dropped, reports it ONCE per run (it sets
 * `state.reported`) as a `warn` diagnostic with code
 * `agent.temperature-ignored`. The run never fails for this.
 */
export function runTemperatureOption(
  state: RunTemperatureState,
  model: string,
  providerId: string | undefined,
  diagnostics: WarnPort,
): { temperature?: number } {
  const temperature = state.value
  if (temperature === undefined) return {}
  const entry = lookupModelEntry(model, providerId)
  const resolved = resolveRunTemperature({ entry, temperature })
  if (resolved.send !== undefined) return { temperature: resolved.send }
  if (!state.reported) {
    state.reported = true
    diagnostics.warn(
      "agent.temperature-ignored",
      `model ${model} does not accept temperature; ${temperature} was not sent`,
      { model, temperature },
    )
  }
  return {}
}
