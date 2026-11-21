/**
 * The `turn.willStop` step of the agent loop.
 *
 * When a round ends with no tool calls, the loop asks the lifecycle port
 * ({@link LifecyclePort.beforeTurnStop}) whether the turn may end. A halt
 * (deny) continues the turn: the reason and any listener context become a
 * user-role continuation note, and another round runs. A cap on consecutive
 * halts keeps a hook from holding the turn open for ever. With no codec the
 * note is the reason and context text with no wrapper. A halt whose note
 * is empty (bare core, no reason, no context) ends the turn instead, with a
 * `turn_stop.no_text` warning: a round with no new user message would end on
 * the assistant reply (a prefill, which Claude 4.6+ rejects).
 *
 * @module sdk/turn-stop-hook
 */

import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { textBlockOrNull } from "../agent/synthetic-text.ts"
import type { ContentBlock } from "../llm/messages.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import type { SidebandApi } from "../sideband/types.ts"
import { hookDeniedText } from "../tools/tool-result-text.ts"

import { cleanHookContext, HOOK_CONTEXT_KIND, wrapHookContext } from "./hook-context.ts"
import { identityFacts } from "./host-facts.ts"
import type { LifecyclePort, TurnWillStopPayload } from "./lifecycle.ts"
import type { SessionFacts } from "./ports.ts"

/** Default for `AgentCoreConfig.maxStopHookHalts`. */
export const DEFAULT_MAX_STOP_HOOK_HALTS = 8

/** The `LifecyclePort.beforeTurnStop` method. */
export type BeforeTurnStop = NonNullable<LifecyclePort["beforeTurnStop"]>

/** Identity fields for the payload, read by the caller. */
export type StopHookFacts = Pick<TurnWillStopPayload, "sid" | "agentId" | "leadSid">

/** What the loop does after the `turn.willStop` step. */
export type StopHookStep =
  | { kind: "end"; noText?: true }
  | { kind: "continue"; content: ContentBlock[] }
  | { kind: "capped"; cap: number }

/** The diagnostics handle (structural, so no import edge): its `warn` only. */
export interface NoTextWarnSink {
  warn(source: string, message: string, data: { hook: string; halts: number }): void
}

/** The `end` step, for a caller that skips the hook. */
export const STOP_END: StopHookStep = { kind: "end" }

/**
 * Per-turn `turn.willStop` state: the consecutive halt count and the
 * identity facts (read once, on the first stop). Make one per turn, so the
 * count resets at each new turn.
 */
export class TurnStopGate {
  private halts = 0
  private facts: StopHookFacts | undefined

  constructor(
    private readonly lifecycle: LifecyclePort,
    private readonly cap: number,
    /** The host `AgentCoreConfig.sessionFacts`. Unset gives no identity. */
    private readonly sessionFacts: (() => SessionFacts) | undefined,
    /** The core synthetic text resolver, for the runtime.hook_denied text. */
    private readonly text?: SyntheticTextResolver,
    /** Receives the `turn_stop.no_text` warning. */
    private readonly diagnostics?: NoTextWarnSink,
    /** The sideband API that renders the halt note as `policy` tags. */
    private readonly sideband: Pick<SidebandApi, "render"> = NO_SIDEBAND,
  ) {}

  /**
   * Run the hook for `response`. A `continue` step counts one more halt.
   * An abort of `signal` while the hook runs gives `end` at once (the caller
   * then sees the aborted signal), so a slow hook never delays Esc.
   */
  async check(response: StreamedResponse, signal?: AbortSignal): Promise<StopHookStep> {
    const hook = this.lifecycle.beforeTurnStop?.bind(this.lifecycle)
    if (!hook) return { kind: "end" }
    // Read the facts only when a hook can use them.
    this.facts ??= identityFacts(this.sessionFacts)
    const step = await runTurnStopHook(
      hook,
      response,
      this.halts,
      this.cap,
      this.facts,
      signal,
      this.text,
      this.sideband,
    )
    if (step.kind === "continue") this.halts++
    // A halt with an empty note ends the turn (no round without a user turn).
    if (step.kind === "end" && step.noText) {
      this.diagnostics?.warn("turn_stop.no_text", "", { hook: "turn.willStop", halts: this.halts })
    }
    return step
  }
}

/** Resolve the configured cap: a non-negative integer, else the default. */
export function resolveMaxStopHookHalts(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_MAX_STOP_HOOK_HALTS
}

/** The text blocks of one response, joined with a newline. */
export function lastAssistantText(response: StreamedResponse): string {
  const parts: string[] = []
  for (const b of response.blocks) if (b.type === "text" && b.text) parts.push(b.text)
  return parts.join("\n")
}

/**
 * Run `turn.willStop` once. `halts` is the count of consecutive halts this
 * turn honored so far (0 on the first stop of the turn). A halt past `cap`
 * ends the turn with `capped`. An allow, a throw, or an abort of `signal`
 * ends the turn. With no
 * halt, listener context is ignored. A halt whose note is "" gives
 * `{kind:"end", noText:true}`.
 */
export async function runTurnStopHook(
  beforeTurnStop: BeforeTurnStop,
  response: StreamedResponse,
  halts: number,
  cap: number,
  facts: StopHookFacts,
  signal?: AbortSignal,
  resolver?: SyntheticTextResolver,
  sb: Pick<SidebandApi, "render"> = NO_SIDEBAND,
): Promise<StopHookStep> {
  const payload: TurnWillStopPayload = {
    lastAssistantText: lastAssistantText(response),
    stopHookActive: halts > 0,
    ...facts,
  }
  let decision: Awaited<ReturnType<BeforeTurnStop>>
  try {
    // The hook gets the turn signal too, so it can stop its own work.
    const raced = await raceAbort(beforeTurnStop(payload, signal), signal)
    if (raced === ABORTED) return { kind: "end" }
    decision = raced
  } catch {
    return { kind: "end" }
  }
  if (decision.action === "allow") return { kind: "end" }
  if (halts >= cap) return { kind: "capped", cap }
  // A halt with no reason: the runtime.hook_denied text ("" with no provider).
  const reason = decision.reason.trim() || hookDeniedText(resolver, "turn.willStop")
  const text = wrapHookContext(sb, [reason, ...cleanHookContext(decision.additionalContext)])
  // With no codec, or no `policy` kind, the note is the text with no
  // wrapper. A note that is "" (bare core, no reason, no context) cannot
  // continue: the
  // next round would end on the assistant reply, a prefill that Claude 4.6+
  // rejects with 400 (follow-up 15e.1c #5). The turn ends instead.
  // The note has the `policy` mark (design step 12c), also with no codec.
  const note = textBlockOrNull(text, HOOK_CONTEXT_KIND)
  return note ? { kind: "continue", content: [note] } : { kind: "end", noText: true }
}

const ABORTED: unique symbol = Symbol("aborted")

/**
 * Settle with `work`, or with {@link ABORTED} as soon as `signal` aborts.
 * The listener is removed when `work` settles first.
 */
function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> {
  if (!signal) return work
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED)
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}
