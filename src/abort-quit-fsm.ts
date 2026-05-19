/**
 * Abort / Quit-confirm FSM — pure transducer.
 *
 * Encodes the user-mandated UX (see project memory #abort-quit-ux-spec):
 *
 *   1. ESC or single Ctrl+C while working = ABORT current work, no confirm.
 *   2. Single Ctrl+C while idle (or 2nd Ctrl+C within 10s after an abort)
 *      = QUIT-CONFIRM window: "press Ctrl+C again within 10s to quit".
 *   3. Confirmation required in BOTH idle-quit and post-abort-quit paths.
 *   4. Work-abort (rule 1) is unconfirmed — confirm only gates the quit.
 *   5. Goal: keep users in-session unless they really mean to quit.
 *   6. HARD GUARANTEE: rapid double-or-more Ctrl+C ALWAYS quits (escape
 *      hatch, handled OUTSIDE this FSM — see {@link EscapeHatch}).
 *   7. On quit, the host prints a goodbye banner with the session id.
 *
 * Design notes
 * ------------
 * The FSM is a pure function `(state, input) → (state, effects[])`. No
 * timers, no IO. The host (EditorController) is responsible for:
 *
 *   - feeding `{kind: "ctrl-c"}` / `{kind: "esc"}` / `{kind: "printable"}`
 *     on keypress,
 *   - feeding `{kind: "turn-start"}` / `{kind: "turn-end"}` around each
 *     agent turn,
 *   - feeding `{kind: "tick", at}` from a recurring timer so the FSM can
 *     expire the armed window,
 *   - applying the emitted {@link FsmEffect}s (rendering, aborting,
 *     quitting).
 *
 * This shape makes every transition cheap to unit-test (no clocks, no IO)
 * and makes the escape-hatch live in a separate `EscapeHatch` so a wedged
 * FSM cannot prevent quit.
 *
 * Transition table
 * ----------------
 *
 * | State    | Input               | Next                  | Effects                              |
 * |----------|---------------------|-----------------------|--------------------------------------|
 * | idle     | ctrl-c              | armed:idle-confirm    | [show-armed]                         |
 * | idle     | esc                 | idle                  | []                                   |
 * | idle     | printable           | idle                  | []                                   |
 * | idle     | turn-start          | working               | []                                   |
 * | idle     | turn-end            | idle                  | []   (defensive; should not happen)  |
 * | idle     | tick                | idle                  | []                                   |
 * | working  | ctrl-c              | armed:post-abort      | [abort-turn, show-armed]             |
 * | working  | esc                 | working               | [abort-turn]                         |
 * | working  | printable           | working               | []                                   |
 * | working  | turn-start          | working               | []   (idempotent re-fire)            |
 * | working  | turn-end            | idle                  | []                                   |
 * | working  | tick                | working               | []                                   |
 * | armed    | ctrl-c              | quitting              | [quit:confirmed]                     |
 * | armed    | esc                 | idle                  | [hide-armed]                         |
 * | armed    | printable           | idle                  | [hide-armed]                         |
 * | armed    | turn-start          | working               | [hide-armed]                         |
 * | armed    | turn-end            | armed                 | []                                   |
 * | armed    | tick (at>=expires)  | idle                  | [hide-armed]                         |
 * | armed    | tick (at<expires)   | armed                 | []                                   |
 * | quitting | *                   | quitting              | []                                   |
 *
 * @module abort-quit-fsm
 */

/** How long the armed window stays open after a Ctrl+C. */
export const ARMED_DURATION_MS = 10_000

/** Why the FSM transitioned into `armed`. Drives the footer copy. */
export type ArmedSource = "idle-confirm" | "post-abort"

/** Why the FSM transitioned into `quitting`. */
export type QuitReason = "confirmed" | "escape-hatch"

/**
 * Discriminated union of FSM states.
 *
 * - `idle`     — no turn in flight, no quit window open.
 * - `working`  — a turn is in flight.
 * - `armed`    — quit-confirm window open; next Ctrl+C quits.
 * - `quitting` — terminal; host should drain and exit.
 */
export type FsmState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "armed"; expiresAt: number; source: ArmedSource }
  | { kind: "quitting"; reason: QuitReason }

/** Inputs the host feeds into the FSM. */
export type FsmInput =
  | { kind: "ctrl-c"; at: number }
  | { kind: "esc"; at: number }
  | { kind: "printable"; at: number }
  | { kind: "turn-start"; at: number }
  | { kind: "turn-end"; at: number }
  | { kind: "tick"; at: number }

/** Effects the host must apply after a transition. */
export type FsmEffect =
  | { kind: "abort-turn" }
  | { kind: "show-armed"; expiresAt: number; source: ArmedSource }
  | { kind: "hide-armed" }
  | { kind: "quit"; reason: QuitReason }

export interface StepResult {
  state: FsmState
  effects: FsmEffect[]
}

export interface FsmOptions {
  /** Override armed window duration (default {@link ARMED_DURATION_MS}). */
  armedDurationMs?: number
}

/**
 * Apply a single input to a state. Pure — no IO, no timers, no closures.
 *
 * @returns the next state and the effects the host should apply, in order.
 */
export function step(state: FsmState, input: FsmInput, opts: FsmOptions = {}): StepResult {
  const armedMs = opts.armedDurationMs ?? ARMED_DURATION_MS

  // Terminal state absorbs everything.
  if (state.kind === "quitting") {
    return { state, effects: [] }
  }

  switch (input.kind) {
    case "ctrl-c": {
      if (state.kind === "idle") {
        const next: FsmState = {
          kind: "armed",
          expiresAt: input.at + armedMs,
          source: "idle-confirm",
        }
        return {
          state: next,
          effects: [{ kind: "show-armed", expiresAt: next.expiresAt, source: "idle-confirm" }],
        }
      }
      if (state.kind === "working") {
        const next: FsmState = {
          kind: "armed",
          expiresAt: input.at + armedMs,
          source: "post-abort",
        }
        return {
          state: next,
          effects: [
            { kind: "abort-turn" },
            { kind: "show-armed", expiresAt: next.expiresAt, source: "post-abort" },
          ],
        }
      }
      // armed → quit (confirmed)
      return {
        state: { kind: "quitting", reason: "confirmed" },
        effects: [{ kind: "quit", reason: "confirmed" }],
      }
    }

    case "esc": {
      if (state.kind === "idle") return { state, effects: [] }
      if (state.kind === "working") {
        return { state, effects: [{ kind: "abort-turn" }] }
      }
      // armed → cancel the modal, back to idle (ESC is NOT a quit signal).
      return { state: { kind: "idle" }, effects: [{ kind: "hide-armed" }] }
    }

    case "printable": {
      if (state.kind === "idle" || state.kind === "working") {
        return { state, effects: [] }
      }
      // armed → user is typing again, dismiss the modal.
      return { state: { kind: "idle" }, effects: [{ kind: "hide-armed" }] }
    }

    case "turn-start": {
      if (state.kind === "working") return { state, effects: [] }
      if (state.kind === "idle") {
        return { state: { kind: "working" }, effects: [] }
      }
      // armed → a new turn starts (user resubmitted) → drop the modal.
      return { state: { kind: "working" }, effects: [{ kind: "hide-armed" }] }
    }

    case "turn-end": {
      if (state.kind === "working") {
        return { state: { kind: "idle" }, effects: [] }
      }
      // turn-end while armed: a turn that was aborted by ctrl-c naturally
      // settles after we already transitioned to armed. Stay armed; the
      // timer / next input will resolve it.
      return { state, effects: [] }
    }

    case "tick": {
      if (state.kind !== "armed") return { state, effects: [] }
      if (input.at >= state.expiresAt) {
        return { state: { kind: "idle" }, effects: [{ kind: "hide-armed" }] }
      }
      return { state, effects: [] }
    }
  }
  // TS proves the switch above is exhaustive over the FsmInput union;
  // this line is unreachable. Kept for `consistent-return` linters and
  // as a safety net if FsmInput grows a variant without updating step().
  return { state, effects: [] }
}

/** Initial state for a fresh REPL. */
export function initialState(): FsmState {
  return { kind: "idle" }
}

// ---------------------------------------------------------------------------
// Escape hatch — independent backstop for rule 6.
// ---------------------------------------------------------------------------

/** Default escape-hatch window: rapid Ctrl+Cs within this fire force-quit. */
export const ESCAPE_HATCH_MS = 500

/**
 * Tracks consecutive Ctrl+C presses. When two land within
 * {@link ESCAPE_HATCH_MS} of each other, the next call returns
 * `"force-quit"`. The host applies this BEFORE feeding the input to the
 * FSM, so a wedged FSM cannot block the user from leaving.
 *
 * Note: the FSM's own (armed, ctrl-c) → quit:confirmed transition handles
 * the "happy path" two-tap quit. The escape hatch only adds value when the
 * FSM is somehow stuck in `working` or `idle` despite the input.
 */
export class EscapeHatch {
  private lastAt = -Infinity
  constructor(private readonly windowMs: number = ESCAPE_HATCH_MS) {}

  /**
   * Observe a Ctrl+C at time `at`.
   *
   * @returns `"force-quit"` if the previous Ctrl+C was within
   *   `windowMs`, otherwise `"continue"` (caller should feed to FSM).
   */
  observe(at: number): "force-quit" | "continue" {
    const delta = at - this.lastAt
    this.lastAt = at
    return delta < this.windowMs ? "force-quit" : "continue"
  }

  /** Reset the counter (e.g. after a non-Ctrl+C input). */
  reset(): void {
    this.lastAt = -Infinity
  }
}
