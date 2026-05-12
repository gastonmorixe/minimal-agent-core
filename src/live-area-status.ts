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

import type { StatusBus, StatusSnapshot, StatusSpinnerTheme } from "./status.ts"
import type { StatusController } from "./agent.ts"
import {
  BlinkingNerdSpinner,
  SpinnerManager,
  type Spinner,
  type SpinnerNotification,
} from "./spinner.ts"

interface EditorStatusSink {
  setStatus(text: string | null): void
}

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
  private baseTheme: StatusSpinnerTheme
  private unsubscribe: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private label: string | null = null
  private spinnerGlyph = ""
  private suspended = false

  constructor(bus: StatusBus, editor: EditorStatusSink, opts: LiveAreaStatusOptions = {}) {
    this.bus = bus
    this.editor = editor
    // Default animation cadence: 8 fps (125 ms tick) is plenty to drive
    // the 500 ms blink cycle without missing step transitions. The
    // compositor's `drawnLiveKey` content-dedup absorbs identical-glyph
    // repaints, so the cost when the spinner state hasn't changed is one
    // cheap string compare per tick — no terminal write. Setting maxFps
    // to 0 here disables the timer entirely (useful for tests).
    this.maxFps = opts.maxFps ?? 8
    this.baseTheme = opts.spinnerTheme ?? {}
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
      return
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
    // Plain 1-space gap. The label column stays stable because every
    // frame the spinner emits is the SAME glyph (only the SGR escape
    // differs — bright color for on-step, dim for off-step). See the
    // pulse-instead-of-blink comment in BlinkingNerdSpinner.render.
    //
    // No `displayWidth`-based padding here: it tries to compensate for
    // wide PUA glyphs but in practice PUA cell width is unreliable
    // across terminal/font configs (iTerm + non-patched fallback font
    // renders Nerd Font PUA as 1 cell, while patched fonts render
    // them as 2). Padding for one config jiggles in the other. The
    // pulse-instead-of-blink design makes that compensation
    // unnecessary because the byte-width is identical every frame.
    const slot = this.spinnerGlyph || " "
    this.editor.setStatus(`${slot} ${this.label}`)
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

  private nextGlyph(): string {
    return this.spinnerManager.render(this.maxFps)?.glyph ?? ""
  }
}
