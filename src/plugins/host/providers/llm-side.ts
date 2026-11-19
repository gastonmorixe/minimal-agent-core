/**
 * `llm.request()` — one bounded side call for plugins (capability `llm:complete`).
 *
 * Rules (SPEC §3a M1, M2, M6, m2; §10):
 * - One attempt only: the call sends with `canonicalAttemptFn`, not the
 *   retrying `canonicalSendFn`. A transient error (429/529) ends the call with
 *   `stopReason: "error"`. Retries are the plugin policy.
 * - One abort signal: `AbortSignal.any([caller, shutdown, AbortSignal.timeout])`.
 *   The transport gets it as `SendOptions.signal`. No `setTimeout` here.
 * - `model` is required for every purpose (no default-model fallback).
 * - Price ceilings, for every purpose: `ModelEntry.pricing.inputUSD` at or
 *   below `maxUsdPerMTokIn` (default {@link DEFAULT_TITLE_MAX_USD_PER_MTOK_IN})
 *   and `outputUSD` at or below `maxUsdPerMTokOut` (default
 *   {@link DEFAULT_SIDE_MAX_USD_PER_MTOK_OUT}). A model with no known price is
 *   rejected.
 * - Same provider as the session, unless the caller sets `allowOtherProvider`.
 * - R10 minimal request: `system` = the provider preamble (the session
 *   provider plugin `resolveSystemPrompt` with an empty identity and the
 *   caller text as the only body block) or the caller text alone; exactly one
 *   user message; no tools, no prompt fragments, no `message.*` hooks.
 * - R11 stream: `stream: false` only when the provider recommendation for
 *   this model says `stream: "off"`; else `stream: true` and the core drains
 *   the stream.
 * - The call runs in an aux usage frame (`runAsAuxUsage`), so its usage never
 *   changes `turns` or `contextSize`.
 * - Never throws: a rejection, a timeout, an abort or a transport error is a
 *   result with `stopReason` and a `reason`.
 *
 * @module plugins/host/providers/llm-side
 */

import { authResultToProviderAuth } from "../../../auth/auth.ts"
import { resolveStartupAuth } from "../../../auth/provider-auth.ts"
import { currentSessionScope } from "../../../infra/session-scope.ts"
import {
  type UsageRecord,
  usageCountersOf,
  usageRecordToCanonical,
} from "../../../llm/codec/usage-record.ts"
import {
  findModel,
  findModelForProvider,
  findProvider,
  getDefaultModelId,
  type ModelEntry,
} from "../../../llm/model-registry.ts"
import { calculateUsageCost } from "../../../llm/pricing.ts"
import { findProviderPlugin } from "../../../llm/provider-plugin.ts"
import { canonicalAttemptFn } from "../../../llm/transport/canonical-send.ts"
import type { SendOptions, TransportFn } from "../../../llm/transport/types.ts"
import { runAsAuxUsage } from "../../../session/session-tokens.ts"
import type { LlmSideRequest, LlmSideResult, LlmSideUsage } from "../capabilities.ts"

/** Default price ceiling for `purpose: "title"`, in USD per 1M input tokens (SPEC §4.2). */
export const DEFAULT_TITLE_MAX_USD_PER_MTOK_IN = 1.0

/**
 * Default output price ceiling of every side call, in USD per 1M output
 * tokens (B6). The SPEC names only the input ceiling; a cheap-input model can
 * have costly (or reasoning) output, so core also checks the output price.
 * $5 keeps the haiku-class $1 / $5 tier.
 */
export const DEFAULT_SIDE_MAX_USD_PER_MTOK_OUT = 5.0

/** Default timeout of one side call, in ms (SPEC §10). */
export const DEFAULT_SIDE_TIMEOUT_MS = 10_000

/** Timeout range of one side call, in ms (SPEC §9: 1000-30000, clamp). */
export const MIN_SIDE_TIMEOUT_MS = 1_000
export const MAX_SIDE_TIMEOUT_MS = 30_000

/**
 * A2: a safe timeout for `AbortSignal.timeout` (it throws on a negative or
 * non-finite value). Absent, non-finite or `<= 0` ⇒ the default; else clamp
 * to {@link MIN_SIDE_TIMEOUT_MS}..{@link MAX_SIDE_TIMEOUT_MS}.
 */
export function clampSideTimeoutMs(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return DEFAULT_SIDE_TIMEOUT_MS
  return Math.min(MAX_SIDE_TIMEOUT_MS, Math.max(MIN_SIDE_TIMEOUT_MS, Math.round(ms)))
}

/**
 * B4: the default transport of `request()`: ONE attempt (`canonicalAttemptFn`),
 * never the retrying `canonicalSendFn` (SPEC M1). Exported for the wiring test.
 */
export const DEFAULT_SIDE_ATTEMPT_FN: TransportFn = canonicalAttemptFn

/** Default max output tokens of one side call. */
export const DEFAULT_SIDE_MAX_TOKENS = 1024

/** Why a side call stopped before or after the send. Machine-readable. */
export type LlmSideReason =
  | "no-model"
  | "unknown-model"
  | "over-ceiling"
  | "unknown-price"
  | "other-provider"
  | "no-session-provider"
  | "auth"
  | "timeout"
  | "aborted"
  | "transport"
  | "invalid-json"

/** Core request: the C2 request plus the cross-provider opt-in (SPEC M6). */
export interface LlmSideRequestCore extends LlmSideRequest {
  /** Allow a model of another provider than the session (`plugins.title.allowOtherProvider`). */
  allowOtherProvider?: boolean
}

/** Core result: the C2 result plus a reason when the call failed or the JSON did not parse. */
export interface LlmSideResultCore extends LlmSideResult {
  /** Set on a rejection, an error, a timeout, an abort, or a JSON parse failure. */
  reason?: LlmSideReason
  /** Short error text (no secrets), for the plugin debug log. */
  detail?: string
}

/** Injectable dependencies of {@link createLlmSideRequest}. */
export interface LlmSideDeps {
  /** One-attempt transport. Default: `canonicalAttemptFn`. */
  attemptFn?: TransportFn
  /** Credential resolver. Default: `resolveStartupAuth`. */
  resolveAuth?: (providerId: string, modelId: string) => Promise<SendOptions["auth"]>
  /**
   * The live provider of the session. Default: the provider of the current
   * session scope target, else the provider of the default model.
   */
  sessionProviderId?: () => string | undefined
  /** Host shutdown signal. When it aborts, each call in flight aborts. */
  shutdownSignal?: AbortSignal
  /** Clock for `latencyMs`. Default `Date.now`. */
  now?: () => number
}

const ZERO_USAGE: LlmSideUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 })

function defaultSessionProviderId(): string | undefined {
  try {
    const target = currentSessionScope()?.queryTarget()
    if (target?.providerId) return target.providerId
  } catch {
    // A scope with no live target: use the default model below.
  }
  try {
    return findModel(getDefaultModelId())?.providerId
  } catch {
    return undefined
  }
}

function toSideUsage(rec: UsageRecord | undefined): LlmSideUsage {
  if (!rec) return { ...ZERO_USAGE }
  const c = usageCountersOf(rec)
  return {
    inputTokens: c.input,
    outputTokens: c.output,
    ...(c.cacheRead > 0 ? { cacheReadTokens: c.cacheRead } : {}),
    ...(c.cacheCreate > 0 ? { cacheWriteTokens: c.cacheCreate } : {}),
  }
}

function costOf(rec: UsageRecord | undefined, entry: ModelEntry): number | undefined {
  if (!rec) return undefined
  try {
    const usd = calculateUsageCost(usageRecordToCanonical(rec), entry.pricing).totalUSD
    return Number.isFinite(usd) ? usd : undefined
  } catch {
    return undefined
  }
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.slice(0, 200)
}

/** Model lookup: scoped to the session provider first, then the global table. */
function lookupModel(id: string, sessionProvider: string | undefined): ModelEntry | undefined {
  if (sessionProvider) {
    const scoped = findModelForProvider(id, sessionProvider)
    if (scoped) return scoped
  }
  return findModel(id)
}

/** A known input price: a finite number at or above zero. `0` = subscription or local. */
export function knownInputPrice(entry: ModelEntry): number | undefined {
  const p = (entry.pricing as { inputUSD?: unknown } | undefined)?.inputUSD
  return typeof p === "number" && Number.isFinite(p) && p >= 0 ? p : undefined
}

/** A known output price: a finite number at or above zero. `0` = subscription or local. */
export function knownOutputPrice(entry: ModelEntry): number | undefined {
  const p = (entry.pricing as { outputUSD?: unknown } | undefined)?.outputUSD
  return typeof p === "number" && Number.isFinite(p) && p >= 0 ? p : undefined
}

/**
 * True when the model has a known input and output price at or below the two
 * ceilings (SPEC §4.2 M2; B6 adds the output ceiling).
 */
export function passesPriceCeilings(
  entry: ModelEntry,
  ceilingIn: number,
  ceilingOut: number,
): boolean {
  const pin = knownInputPrice(entry)
  const pout = knownOutputPrice(entry)
  return pin !== undefined && pout !== undefined && pin <= ceilingIn && pout <= ceilingOut
}

/**
 * G1 (R10): the system blocks of one side call. The provider plugin of the
 * model adds its preamble through `resolveSystemPrompt` (identity `""`, body =
 * the caller text). Empty blocks are dropped. No provider hook (or a hook that
 * throws): the caller text is the only block. No prompt fragments.
 */
export function buildSideSystem(
  providerId: string,
  modelId: string,
  auth: SendOptions["auth"],
  text: string,
): NonNullable<SendOptions["system"]> {
  const body = text === "" ? [] : [{ type: "text" as const, text }]
  try {
    const plugin = findProviderPlugin(providerId)
    if (plugin?.resolveSystemPrompt) {
      const blocks = plugin
        .resolveSystemPrompt({
          identity: "",
          body,
          authKind: authResultToProviderAuth(auth).kind,
          modelId,
        })
        .filter((b) => typeof b.text !== "string" || b.text.length > 0)
      if (blocks.length > 0) return blocks
    }
  } catch {
    // A broken provider hook: send the caller text only.
  }
  return body
}

/**
 * G2 (R11): the stream flag of one side call. `false` only when the provider
 * recommendation names this model with `stream: "off"`. Absent or
 * `"required"` ⇒ `true` (the core drains the stream).
 */
export function sideStreamFlag(providerId: string, modelId: string): boolean {
  try {
    const rec = findProvider(providerId)?.recommendUtilityModel?.()
    if (rec && rec.modelId === modelId && rec.stream === "off") return false
  } catch {
    // A broken recommendation: stream (the safe default).
  }
  return true
}

/**
 * Build the `llm.request()` function of the plugin host.
 *
 * @param deps - Injected transport, auth and clock (tests).
 * @returns `request(req)`: one bounded side call that never throws.
 */
export function createLlmSideRequest(
  deps: LlmSideDeps = {},
): (req: LlmSideRequestCore) => Promise<LlmSideResultCore> {
  const attemptFn = deps.attemptFn ?? DEFAULT_SIDE_ATTEMPT_FN
  const resolveAuth =
    deps.resolveAuth ??
    ((providerId: string, modelId: string) => resolveStartupAuth(providerId, modelId))
  const sessionProviderId = deps.sessionProviderId ?? defaultSessionProviderId
  const now = deps.now ?? Date.now

  return async (req: LlmSideRequestCore): Promise<LlmSideResultCore> => {
    const started = now()
    const purpose = req.purpose ?? "aux"
    const sessionProvider = sessionProviderId()

    const reject = (
      reason: LlmSideReason,
      model: string,
      provider: string,
      detail?: string,
    ): LlmSideResultCore => ({
      text: "",
      stopReason: "error",
      model,
      provider,
      usage: { ...ZERO_USAGE },
      latencyMs: Math.max(0, now() - started),
      reason,
      ...(detail ? { detail } : {}),
    })

    // M2 + B7: every side call names its model. No default-model fallback
    // (the default model can be an Opus-class model), for every purpose.
    const modelId = req.model
    if (!modelId) return reject("no-model", "", sessionProvider ?? "")
    const entry = lookupModel(modelId, sessionProvider)
    if (!entry) return reject("unknown-model", modelId, sessionProvider ?? "")

    // M6: same provider as the session, unless the caller opts in.
    if (!req.allowOtherProvider) {
      if (!sessionProvider) return reject("no-session-provider", entry.id, entry.providerId)
      if (entry.providerId !== sessionProvider) {
        return reject("other-provider", entry.id, entry.providerId)
      }
    }

    // M2 + B6 + B7: input and output price ceilings, for every purpose.
    const ceilingIn = req.maxUsdPerMTokIn ?? DEFAULT_TITLE_MAX_USD_PER_MTOK_IN
    const ceilingOut = req.maxUsdPerMTokOut ?? DEFAULT_SIDE_MAX_USD_PER_MTOK_OUT
    const priceIn = knownInputPrice(entry)
    const priceOut = knownOutputPrice(entry)
    if (priceIn === undefined || priceOut === undefined) {
      return reject("unknown-price", entry.id, entry.providerId)
    }
    if (priceIn > ceilingIn) {
      return reject("over-ceiling", entry.id, entry.providerId, `input ${priceIn} > ${ceilingIn}`)
    }
    if (priceOut > ceilingOut) {
      return reject(
        "over-ceiling",
        entry.id,
        entry.providerId,
        `output ${priceOut} > ${ceilingOut}`,
      )
    }

    // M1: one controller-equivalent signal from caller + shutdown + timeout.
    const timeoutSignal = AbortSignal.timeout(clampSideTimeoutMs(req.timeoutMs))
    const signals: AbortSignal[] = [timeoutSignal]
    if (req.abortSignal) signals.push(req.abortSignal)
    if (deps.shutdownSignal) signals.push(deps.shutdownSignal)
    const signal = AbortSignal.any(signals)

    const abortResult = (): LlmSideResultCore => {
      const timedOut = timeoutSignal.aborted && !req.abortSignal?.aborted
      const reason: LlmSideReason = timedOut ? "timeout" : "aborted"
      return {
        text: "",
        stopReason: reason,
        model: entry.id,
        provider: entry.providerId,
        usage: { ...ZERO_USAGE },
        latencyMs: Math.max(0, now() - started),
        reason,
      }
    }
    if (signal.aborted) return abortResult()

    // Abort race: the call returns when the signal aborts, also if the auth
    // step or a transport does not honor the signal. No timer: an abort listener.
    let onAbort: (() => void) | undefined
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted")
      signal.addEventListener("abort", onAbort, { once: true })
    })

    try {
      // A1: the auth step (it can refresh OAuth over the network) is bounded too.
      let auth: SendOptions["auth"] | "aborted"
      try {
        auth = await Promise.race([resolveAuth(entry.providerId, entry.id), aborted])
      } catch (err) {
        if (signal.aborted) return abortResult()
        return reject("auth", entry.id, entry.providerId, errorText(err))
      }
      if (auth === "aborted" || signal.aborted) return abortResult()

      const opts: SendOptions = {
        auth,
        model: entry.id,
        selectedProviderId: entry.providerId,
        system: buildSideSystem(entry.providerId, entry.id, auth, req.system),
        messages: [{ role: "user", content: [{ type: "text", text: req.userText }] }],
        maxTokens: req.maxTokens ?? DEFAULT_SIDE_MAX_TOKENS,
        stream: sideStreamFlag(entry.providerId, entry.id),
        // Fact 2: every side purpose uses the auxiliary transport class.
        requestType: "title",
        signal,
        ...(req.thinking === "off" ? { thinking: false as const } : {}),
      }
      const outputConfig: NonNullable<SendOptions["outputConfig"]> = {}
      if (req.effort) outputConfig.effort = req.effort
      if (req.outputSchema) {
        // `strict` rides the format structurally (request-codec reads it).
        outputConfig.format = {
          type: "json_schema",
          schema: req.outputSchema.schema,
          ...(req.outputSchema.strict === false ? {} : { strict: true }),
        } as NonNullable<SendOptions["outputConfig"]>["format"]
      }
      if (Object.keys(outputConfig).length > 0) opts.outputConfig = outputConfig

      return await runAsAuxUsage({ purpose, model: entry.id }, async () => {
        const gen = attemptFn(opts)
        let streamed = ""
        const drain = (async () => {
          while (true) {
            const step = await gen.next()
            if (step.done) return step.value
            streamed += step.value
          }
        })()
        let outcome: Awaited<typeof drain> | "aborted"
        try {
          outcome = await Promise.race([drain, aborted])
        } catch (err) {
          if (signal.aborted) return abortResult()
          return {
            ...reject("transport", entry.id, entry.providerId, errorText(err)),
            latencyMs: Math.max(0, now() - started),
          }
        }
        if (outcome === "aborted") {
          drain.catch(() => {})
          void gen.return(undefined as never).catch(() => {})
          return abortResult()
        }

        const resp = outcome
        const text = resp.text || streamed
        const result: LlmSideResultCore = {
          text,
          stopReason: resp.stopReason ?? "end_turn",
          model: entry.id,
          provider: entry.providerId,
          usage: toSideUsage(resp.usage),
          latencyMs: Math.max(0, now() - started),
        }
        const cost = costOf(resp.usage, entry)
        if (cost !== undefined) result.costUsd = cost
        if (req.outputSchema) {
          try {
            result.json = JSON.parse(text)
          } catch (err) {
            result.reason = "invalid-json"
            result.detail = errorText(err)
          }
        }
        return result
      })
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort)
    }
  }
}
