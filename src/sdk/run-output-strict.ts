/**
 * Strict structured output (SPEC-ONESHOT R2, R4): the state `AgentCore`
 * keeps for it.
 *
 * `strict` sits next to `outputSchema`. The session value comes from
 * {@link OutputStrictConfig.outputStrict} (or `setOutputStrict`). A run can
 * override it for that run only, with the `outputStrict` run option or the
 * one-shot pending value from `setNextRunOutputStrict`. Same life as the
 * per-run schema (D1): set at run start, cleared in the run's `finally`.
 * Strict without a schema has no effect. The provider builder decides what
 * goes on the wire (D-5: Anthropic sends no strict field). The core only
 * reports, once per run, a strict request for a model whose registry entry
 * has `structuredOutputs: false` (D-4). The run never fails for this.
 *
 * @module sdk/run-output-strict
 */

import { lookupModelEntry } from "./run-temperature.ts"

/** Diagnostic code of the once-per-run warn. */
export const STRICT_UNSUPPORTED_CODE = "llm.strict-unsupported"

/** The session-level config field. Kept here so `ports.ts` stays unchanged. */
export interface OutputStrictConfig {
  /**
   * Ask for strict structured output on every run (default false). It has
   * an effect only when an `outputSchema` (session or run) is set.
   */
  outputStrict?: boolean
}

/**
 * The part of a diagnostics handle this module uses. Structural on purpose:
 * it keeps the SDK type-only import inventory unchanged.
 */
export interface StrictWarnPort {
  /** Emit a `warn` diagnostic. */
  warn(source: string, message: string, data: { model: string }): void
}

/** Session, per-run, and one-shot strict values, plus the once-per-run warn flag. */
export class RunOutputStrict {
  /** Session-level strict. Never changed by a run. */
  session: boolean
  /** Strict of the current run. Set at run start, cleared at run end. */
  private run: boolean | undefined
  /** One-shot strict for the NEXT run. */
  pending: boolean | undefined
  /** True after this run reported that its model has no structured outputs. */
  private reported = false

  constructor(session: boolean | undefined) {
    this.session = session === true
  }

  /** Run start: the run option wins over the pending value, which is consumed. */
  start(runOption: boolean | undefined): void {
    this.run = runOption ?? this.pending
    this.pending = undefined
    this.reported = false
  }

  /** Run end (success, error, or abort): the session value comes back. */
  end(): void {
    this.run = undefined
  }

  /**
   * The `strict` value for one request: `true` or `undefined` (never sent as
   * false). No schema: `undefined`. Checked per request, because `setModel`
   * can change the model inside a run. When strict is on and the registry
   * entry says `structuredOutputs: false`, reports it ONCE per run as a warn
   * with code {@link STRICT_UNSUPPORTED_CODE} and data `{ model }`. A model
   * with no registry entry gets no warn: the provider decides. The value is
   * passed on in both cases, so the provider builder makes the final choice.
   */
  forRequest(
    schema: object | undefined,
    model: string,
    providerId: string | undefined,
    diagnostics: StrictWarnPort,
  ): true | undefined {
    if (!schema || (this.run ?? this.session) !== true) return undefined
    const entry = lookupModelEntry(model, providerId)
    if (entry && !entry.capabilities.structuredOutputs && !this.reported) {
      this.reported = true
      diagnostics.warn(
        STRICT_UNSUPPORTED_CODE,
        `model ${model} does not support structured outputs; strict has no effect`,
        { model },
      )
    }
    return true
  }
}
