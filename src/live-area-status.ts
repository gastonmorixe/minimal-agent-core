/**
 * Bridges the {@link StatusBus} to an {@link EditorController}'s status row.
 *
 * Acts as a {@link StatusController} so it can be plugged into `runRepl`'s
 * existing `statusRenderer` slot. Instead of writing escape sequences to a
 * stream like {@link StatusRenderer}, it animates the spinner via a timer
 * and pushes the rendered "<glyph> <label>" string into
 * {@link EditorController.setStatus}, which paints it as the top row of the
 * compositor's live area.
 *
 * @module live-area-status
 */

import {
  formatActivityInfix,
  formatElapsedSuffix,
  type StatusBus,
  type StatusSnapshot,
  type StatusSpinnerTheme,
} from "./status.ts"
import type { StatusController } from "./agent.ts"
import {
  BlinkingNerdSpinner,
  SpinnerManager,
  type Spinner,
  type SpinnerNotification,
} from "./spinner.ts"
import { visualCellsForGlyph } from "./nerd-glyph-width.ts"

interface EditorStatusSink {
  setStatus(text: string | null): void
}

/**
 * Trailing-parens byte-count detector. Matches `(10 B)`, `(2.0 KB)`,
 * `(1.5 MB)`. Used to decide whether the label already shows the byte
 * counter (in which case the activity infix suppresses its own bytes
 * segment to avoid duplication). See `formatActivityInfix.hideBytes`.
 */
const LABEL_BYTES_RE = /\(\d+(?:\.\d+)?\s?(?:B|KB|MB)\)\s*$/

export interface LiveAreaStatusOptions {
  maxFps?: number
  spinner?: Spinner<StatusSpinnerTheme>
  spinnerTheme?: StatusSpinnerTheme
  spinnerSwitchGraceMs?: number
  now?: () => number
}

export class LiveAreaStatusController implements StatusController {
  private readonly bus: StatusBus
  private readonly editor: EditorStatusSink
  private readonly maxFps: number
  private readonly spinnerManager: SpinnerManager<StatusSpinnerTheme>
  private readonly now: () => number
  private baseTheme: StatusSpinnerTheme
  private unsubscribe: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private label: string | null = null
  private spinnerGlyph = ""
  private suspended = false
  /**
   * Identity of the entry whose elapsed timer is currently running.
   * Reset triggers: bus.create() (new id), cleared status (null), or
   * controller stop. `update()` on the same handle keeps the same id
   * so phase transitions on one network request keep ticking from the
   * original start (e.g. `Sending` -> `Receiving stream` -> `Thinking`
   * all share an elapsed counter).
   */
  private statusId: number | null = null
  private statusStartedAt = 0
  /**
   * Visual cell width of the canonical icon for the current spinner
   * frame. Stays the same across on-frame (colorized glyph) and
   * off-frame (whitespace pad) of one icon, so the gap-after-glyph
   * the paint emits doesn't jiggle on blink. Sourced from the spinner
   * frame's `iconCells` hint when present; falls back to
   * `visualCellsForGlyph(glyph)` for spinners that predate the field.
   */
  private spinnerIconCells: 1 | 2 = 1

  constructor(bus: StatusBus, editor: EditorStatusSink, opts: LiveAreaStatusOptions = {}) {
    this.bus = bus
    this.editor = editor
    // Default animation cadence: 8 fps (125 ms tick) is plenty to drive
    // the 500 ms blink cycle without missing step transitions. The
    // compositor's `drawnLiveKey` content-dedup absorbs identical-glyph
    // repaints, so the cost when the spinner state hasn't changed is one
    // cheap string compare per tick — no terminal write. Setting maxFps
    // to 0 here disables the timer entirely (useful for tests).
    //
    // The same timer also drives the per-status elapsed suffix
    // (`Thinking (2s)`). At 125 ms tick the second-boundary is crossed
    // within one tick of wall-clock truth, so the suffix advances
    // smoothly.
    this.maxFps = opts.maxFps ?? 8
    this.baseTheme = opts.spinnerTheme ?? {}
    this.now = opts.now ?? (() => Date.now())
    this.spinnerManager = new SpinnerManager<StatusSpinnerTheme>({
      spinner: opts.spinner ?? new BlinkingNerdSpinner(),
      theme: this.baseTheme,
      notification: {},
      maxSwitchGraceMs: opts.spinnerSwitchGraceMs,
      now: opts.now,
    })
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.bus.subscribe(() => this.onBusUpdate())
    this.onBusUpdate()
  }

  stop(): void {
    this.stopTimer()
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.spinnerManager.unmount()
    this.editor.setStatus(null)
    this.label = null
    this.statusId = null
    this.statusStartedAt = 0
  }

  /**
   * No-op for the live-area path: the compositor already redraws the status
   * row atomically alongside every stream chunk, so there's nothing to
   * "suspend" the way the line-mode StatusRenderer needs to.
   */
  suspend(): void {
    this.suspended = true
  }

  resume(): void {
    if (!this.suspended) return
    this.suspended = false
    if (this.label) this.paint()
  }

  private onBusUpdate(): void {
    const status = this.bus.currentStatus()
    this.label = status?.label ?? null
    if (!status) {
      this.spinnerManager.unmount()
      this.stopTimer()
      this.editor.setStatus(null)
      this.statusId = null
      this.statusStartedAt = 0
      return
    }
    // Reset the elapsed timer on entry-identity change (new
    // `bus.create()`) but NOT on label updates to the same entry -- so
    // two consecutive `Running Bash` tool dispatches each restart from
    // 0, while client.ts phase transitions on one network request
    // (`Sending` -> `Receiving stream` -> ...) keep ticking from the
    // original handle's birth.
    if (status.id !== this.statusId) {
      this.statusId = status.id
      this.statusStartedAt = this.now()
    }
    this.spinnerManager.ensureMounted()
    this.spinnerManager.setNotification(this.toNotification(status))
    this.spinnerManager.setTheme(status.spinnerTheme ?? this.baseTheme)
    this.spinnerGlyph = this.nextGlyph()
    this.paint()
    this.scheduleNextTick()
  }

  private paint(): void {
    if (!this.label) {
      this.editor.setStatus(null)
      return
    }
    // Gap mirrors the *canonical icon's* visual cell width — sourced
    // from `spinnerIconCells` (the `SpinnerRenderFrame.iconCells` hint,
    // stable across on-frame and off-frame), NOT from inspecting the
    // current slot. Inspecting the slot would mis-measure the off-frame
    // (whose glyph is whitespace and reads as 1 cell even when the
    // on-frame icon is 2-cell PUA), causing the label column to jiggle
    // by 1 cell on every blink. With the hint, the gap stays put:
    //   - 1-cell icon (●, rotor frame): 1 ASCII space → 2 cells before label
    //   - 2-cell icon (PUA Nerd glyph with probed cells=2): 2 ASCII spaces
    //     → 4 cells before label (icon spans cells 0-1, gap is cells 2-3)
    // In both cases there's exactly one cell of breathing room between
    // the icon's right edge and the label's left edge.
    const slot = this.spinnerGlyph || " "
    const iconCells = this.spinnerIconCells
    const gap = iconCells === 2 ? "  " : " "
    // Append the faint elapsed suffix (e.g. " \x1b[2m(2s)\x1b[22m").
    // Empty string under 1s, then ticks per second. The compositor's
    // `drawnLiveKey` content-dedup absorbs paints where neither glyph
    // nor seconds-bucket changed, so cost is one string compare.
    const now = this.now()
    const elapsedMs = this.statusStartedAt > 0 ? now - this.statusStartedAt : 0
    const suffix = formatElapsedSuffix(elapsedMs)
    // Compose the activity infix from the current bus snapshot. The 8 fps
    // spinner timer drives `paint()` already, so the byte/token/rate
    // segments tick smoothly without any new timer. The infix is empty
    // when no activity is attached (back-compat with code paths that
    // never publish bytes — e.g. local tool execution without streaming).
    // `hideBytes` is set when the label already ends with `(N B)` /
    // `(N KB)` / `(N MB)` so we don't double-render the byte counter
    // (today's `Calling Write: streaming input (10 B)` pattern from
    // client.ts uses this).
    const status = this.bus.currentStatus()
    const labelHasBytes = LABEL_BYTES_RE.test(this.label)
    const infix = formatActivityInfix(status?.activity, {
      now,
      entryStartedAt: this.statusStartedAt,
      hideBytes: labelHasBytes,
    })
    this.editor.setStatus(`${slot}${gap}${this.label}${infix}${suffix}`)
  }

  private toNotification(status: StatusSnapshot): SpinnerNotification {
    return {
      notificationId: status.notificationId,
      category: status.category,
    }
  }

  private scheduleNextTick(): void {
    if (this.timer || !this.label || this.maxFps <= 0) return
    const effectiveFps = this.spinnerManager.effectiveFps(this.maxFps) ?? this.maxFps
    const delayMs = Math.max(16, Math.round(1000 / effectiveFps))
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.label) return
      this.spinnerGlyph = this.nextGlyph()
      this.paint()
      this.scheduleNextTick()
    }, delayMs)
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Pull the next frame from the spinner manager and stash both the
   * glyph and the icon's visual cell width for the next `paint()`.
   * Returns the glyph string for caller-readability.
   */
  private nextGlyph(): string {
    const frame = this.spinnerManager.render(this.maxFps)
    if (!frame) {
      this.spinnerIconCells = 1
      return ""
    }
    // Prefer the spinner-supplied hint (stable across on/off frames).
    // Fall back to inspecting the glyph for spinners that predate the
    // field. Off-frame glyphs are whitespace pads -- their codepoint
    // is " " which `visualCellsForGlyph` reports as 1 cell, so without
    // the hint the off-frame disagrees with the on-frame on a wide
    // icon. The hint fixes that.
    this.spinnerIconCells =
      frame.iconCells != null ? frame.iconCells : visualCellsForGlyph(frame.glyph)
    return frame.glyph
  }
}
