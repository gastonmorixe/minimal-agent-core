/**
 * Auto-ASK controller.
 *
 * Wires the editor's `"input"` event (a coalesced, non-blocking, content-only
 * stream of buffer snapshots) to a {@link ModeManager}, automatically
 * flipping into ASK mode when the user is composing a question and back
 * to default when they switch to an action verb.
 *
 * ## Invariants (please don't break these)
 *
 * 1. **Never override the user.** If the user manually toggles a mode
 *    (Shift+Tab), `didAutoSwitch` clears and we stay out of the way until
 *    the buffer fully empties. We only revert modes WE set.
 *
 * 2. **Empty buffer resets stickiness.** When the buffer becomes empty
 *    (after a submit or Ctrl+U), any stale `didAutoSwitch` flag is
 *    cleared. Next turn starts fresh.
 *
 * 3. **Deadband.** Heuristic scores between {@link REVERT_THRESHOLD} and
 *    {@link ASK_THRESHOLD} produce no mode change. This prevents the
 *    prompt color from flickering during normal typing.
 *
 * 4. **Sequence guard.** We track the last input `seq` we acted on; an
 *    out-of-order or duplicate event is ignored. Cheap insurance against
 *    re-entrant emit paths.
 *
 * The controller exposes its `mode-manager-driving` work as plain method
 * calls so tests can drive it without spinning up a real EditorController.
 *
 * @module auto-ask
 */

import {
  ASK_THRESHOLD,
  isActionConfident,
  isQuestionConfident,
  REVERT_THRESHOLD,
  scoreQuestion,
} from "./ask-mode-heuristic.ts"
import type { ModeManager } from "./modes.ts"
import type { ManifestMode } from "./plugins/types.ts"

/** Subscribe-able shape — the public surface of EditorController we need. */
export interface InputSource {
  on(event: "input", listener: (payload: { text: string; seq: number }) => void): unknown
  off(event: "input", listener: (payload: { text: string; seq: number }) => void): unknown
}

export interface AutoAskOptions {
  /** Mode id to enter on a confident question. Default: `"ask"`. */
  askModeId?: string
  /** Diagnostic logger. Defaults to a no-op (avoid spam in production). */
  logger?: (msg: string) => void
}

/**
 * Wires an {@link InputSource} to a {@link ModeManager}, auto-flipping
 * to ASK on confident questions and reverting on confident actions.
 *
 * The constructor returns a started controller — call {@link dispose}
 * to detach.
 */
export class AutoAskController {
  private readonly source: InputSource
  private readonly modes: ModeManager
  private readonly askModeId: string
  private readonly logger: (msg: string) => void
  /**
   * `true` when the controller's most recent action was to flip into the
   * ASK mode. Cleared by an explicit revert OR by detecting that the
   * user manually changed mode (i.e. the active mode is no longer the
   * one we set last).
   */
  private didAutoSwitch = false
  /**
   * Mode id the controller LAST set, regardless of whether it was the
   * ASK mode or a revert. Used to detect user-driven mode changes —
   * if the active mode id no longer matches this, the user pressed
   * Shift+Tab and we step back to observation-only until the buffer
   * empties.
   */
  private lastSetModeId: string | null = null
  /** True after we detected a user override; resets when buffer empties. */
  private suspended = false
  private lastSeq = -1
  private listener: (e: { text: string; seq: number }) => void
  private modeUnsub: (() => void) | null = null

  constructor(source: InputSource, modes: ModeManager, opts: AutoAskOptions = {}) {
    this.source = source
    this.modes = modes
    this.askModeId = opts.askModeId ?? "ask"
    this.logger = opts.logger ?? (() => {})

    this.listener = (e) => this.onInput(e)
    this.source.on("input", this.listener)

    // Detect user-driven mode changes: if the active id diverges from
    // what we last set, it was a manual Shift+Tab. Clear ownership so we
    // don't revert their choice.
    this.modeUnsub = this.modes.subscribe((active: ManifestMode | null) => {
      const activeId = active?.id ?? null
      if (this.lastSetModeId !== null && activeId !== this.lastSetModeId) {
        this.logger(
          `auto-ask: user changed mode (${this.lastSetModeId} → ${activeId}); suspending until buffer empties`,
        )
        this.didAutoSwitch = false
        this.lastSetModeId = null
        this.suspended = true
      }
    })
  }

  /** Detach all listeners. Idempotent. */
  dispose(): void {
    this.source.off("input", this.listener)
    if (this.modeUnsub) {
      this.modeUnsub()
      this.modeUnsub = null
    }
  }

  /**
   * Public hook for the input listener. Tests call this directly to
   * drive the controller without the editor.
   */
  onInput(e: { text: string; seq: number }): void {
    if (e.seq <= this.lastSeq) return // stale / replay
    this.lastSeq = e.seq

    // Empty buffer = clean slate. Clear suspension AND ownership so the
    // next turn starts fresh.
    if (e.text.trim().length === 0) {
      if (this.didAutoSwitch && this.modes.activeId() === this.askModeId) {
        // Active turn ended in ASK mode that we set; leave it. The mode
        // manager's `consumePendingAttachment` advertises it to the model
        // on the next turn. We just clear the flag so we won't try to
        // "revert" it later.
      }
      this.didAutoSwitch = false
      this.lastSetModeId = null
      this.suspended = false
      return
    }

    if (this.suspended) return

    const score = scoreQuestion(e.text)
    const activeId = this.modes.activeId()

    if (isQuestionConfident(score)) {
      if (activeId !== this.askModeId) {
        if (this.modes.setMode(this.askModeId)) {
          this.didAutoSwitch = true
          this.lastSetModeId = this.askModeId
          this.logger(
            `auto-ask: → ASK (score=${score}, text=${JSON.stringify(e.text.slice(0, 40))})`,
          )
        }
      }
      return
    }

    if (isActionConfident(score) && this.didAutoSwitch && activeId === this.askModeId) {
      if (this.modes.setMode(null)) {
        this.didAutoSwitch = false
        this.lastSetModeId = null
        this.logger(
          `auto-ask: ← default (score=${score}, text=${JSON.stringify(e.text.slice(0, 40))})`,
        )
      }
    }
    // Deadband: between REVERT_THRESHOLD and ASK_THRESHOLD, do nothing.
    void ASK_THRESHOLD
    void REVERT_THRESHOLD
  }

  // -- inspection helpers (tests) -------------------------------------------
  /** @internal */
  _didAutoSwitch(): boolean {
    return this.didAutoSwitch
  }
  /** @internal */
  _suspended(): boolean {
    return this.suspended
  }
}
