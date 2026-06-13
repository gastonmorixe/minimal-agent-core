import type { StatusBus, StatusSnapshot } from "../../status.ts"
import { displayWidth, truncateDisplayWidth } from "../../term-width.ts"
import {
  BlinkingNerdSpinner,
  type BlinkingNerdSpinnerTheme,
  type Spinner,
  SpinnerManager,
  type SpinnerNotification,
} from "../spinner/index.ts"

import { formatActivityInfix, formatElapsedSuffix, LABEL_BYTES_RE } from "./format.ts"

export interface StatusSpinnerTheme extends BlinkingNerdSpinnerTheme {
  accent?: (text: string) => string
}

type StatusOutput = Pick<NodeJS.WriteStream, "write"> & {
  isTTY?: boolean
}

export interface StatusRendererOptions {
  maxFps?: number
  spinner?: Spinner<StatusSpinnerTheme>
  spinnerTheme?: StatusSpinnerTheme
  spinnerSwitchGraceMs?: number
  now?: () => number
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`
}

/** Line-mode status renderer for non-live-area TTY output. */
export class StatusRenderer {
  private readonly bus: StatusBus
  private readonly output: StatusOutput
  private readonly maxFps: number
  private readonly spinnerManager: SpinnerManager<StatusSpinnerTheme>
  private readonly now: () => number
  private readonly gap = " "
  private baseSpinnerTheme: StatusSpinnerTheme
  private unsubscribe: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private label: string | null = null
  private spinnerGlyph = ""
  private visible = false
  private suspended = false
  private statusId: number | null = null
  private statusStartedAt = 0

  constructor(
    bus: StatusBus,
    output: StatusOutput = process.stdout,
    intervalMsOrOptions: number | StatusRendererOptions = 80,
  ) {
    this.bus = bus
    this.output = output
    const normalized =
      typeof intervalMsOrOptions === "number"
        ? {
            maxFps: intervalMsOrOptions <= 0 ? 0 : 1000 / intervalMsOrOptions,
          }
        : intervalMsOrOptions

    this.maxFps = normalized.maxFps ?? 12.5
    this.baseSpinnerTheme = normalized.spinnerTheme ?? {}
    this.now = normalized.now ?? (() => Date.now())
    this.spinnerManager = new SpinnerManager<StatusSpinnerTheme>({
      spinner: normalized.spinner ?? new BlinkingNerdSpinner(),
      theme: this.baseSpinnerTheme,
      notification: {},
      maxSwitchGraceMs: normalized.spinnerSwitchGraceMs,
      now: normalized.now,
    })
  }

  start(): void {
    if (this.unsubscribe || this.output.isTTY === false) return
    this.unsubscribe = this.bus.subscribe(() => {
      this.onBusUpdate()
    })
  }

  stop(): void {
    this.stopTimer()
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.spinnerManager.unmount()
    this.clearLine()
    this.statusId = null
    this.statusStartedAt = 0
  }

  suspend(): void {
    if (this.suspended) return
    this.suspended = true
    this.clearLine()
  }

  resume(): void {
    if (!this.suspended) return
    this.suspended = false
    if (this.label) {
      this.spinnerGlyph = this.nextSpinnerGlyph()
      this.renderLine()
    }
  }

  setSpinner(spinner: Spinner<StatusSpinnerTheme>, maxGraceMs?: number): void {
    this.spinnerManager.setSpinner(spinner, maxGraceMs)
    if (this.label) {
      this.spinnerGlyph = this.nextSpinnerGlyph()
      if (!this.suspended) this.renderLine()
      this.scheduleNextTick()
    }
  }

  setSpinnerTheme(theme: StatusSpinnerTheme): void {
    this.baseSpinnerTheme = theme
    const active = this.bus.currentStatus()
    if (active?.spinnerTheme) return
    this.spinnerManager.setTheme(theme)
    if (this.label) {
      this.spinnerGlyph = this.nextSpinnerGlyph()
      if (!this.suspended) this.renderLine()
    }
  }

  private onBusUpdate(): void {
    const status = this.bus.currentStatus()
    this.label = status?.label ?? null
    if (!status) {
      this.spinnerManager.unmount()
      this.stopTimer()
      if (!this.suspended) this.clearLine()
      this.statusId = null
      this.statusStartedAt = 0
      return
    }

    if (status.id !== this.statusId) {
      this.statusId = status.id
      this.statusStartedAt = this.now()
    }

    this.spinnerManager.ensureMounted()
    this.spinnerManager.setNotification(this.toNotification(status))
    this.spinnerManager.setTheme(
      (status.spinnerTheme as StatusSpinnerTheme | undefined) ?? this.baseSpinnerTheme,
    )
    this.spinnerGlyph = this.nextSpinnerGlyph()
    if (!this.suspended) this.renderLine()
    this.scheduleNextTick()
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
      this.spinnerGlyph = this.nextSpinnerGlyph()
      if (!this.suspended) this.renderLine()
      this.scheduleNextTick()
    }, delayMs)
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private nextSpinnerGlyph(): string {
    return this.spinnerManager.render(this.maxFps)?.glyph ?? ""
  }

  private renderLine(): void {
    if (!this.label) return
    const prefix = this.spinnerGlyph ? `${this.spinnerGlyph}${this.gap}` : ""
    const now = this.now()
    const elapsedMs = this.statusStartedAt > 0 ? now - this.statusStartedAt : 0
    const suffix = formatElapsedSuffix(elapsedMs)
    const status = this.bus.currentStatus()
    const labelHasBytes = LABEL_BYTES_RE.test(this.label)
    const cols = (this.output as { columns?: number }).columns
    const maxWidth = typeof cols === "number" && cols > 0 ? cols : Number.POSITIVE_INFINITY
    const fixedWidth = displayWidth(prefix) + displayWidth(this.label) + displayWidth(suffix)
    const infixBudget = Number.isFinite(maxWidth) ? Math.max(0, maxWidth - fixedWidth) : undefined
    const infix = formatActivityInfix(status?.activity, {
      now,
      entryStartedAt: this.statusStartedAt,
      hideBytes: labelHasBytes,
      maxWidth: infixBudget,
    })
    const composed = `${prefix}${dim(this.label)}${infix}${suffix}`
    const clamped = Number.isFinite(maxWidth)
      ? truncateDisplayWidth(composed, maxWidth, "")
      : composed
    this.output.write(`\r\x1b[2K${clamped}`)
    this.visible = true
  }

  private clearLine(): void {
    if (!this.visible) return
    this.output.write("\r\x1b[2K")
    this.visible = false
  }
}
