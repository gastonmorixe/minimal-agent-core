import {
  BlinkingNerdSpinner,
  SpinnerManager,
  type BlinkingNerdSpinnerTheme,
  type Spinner,
  type SpinnerNotification,
} from "./spinner.ts"

type StatusListener = (label: string | null) => void

export interface StatusSpinnerTheme extends BlinkingNerdSpinnerTheme {
  accent?: (text: string) => string
}

export interface StatusMetadata {
  notificationId?: string
  category?: string
  spinnerTheme?: StatusSpinnerTheme
}

export interface StatusHandle {
  update(label: string, metadata?: StatusMetadata): void
  clear(): void
}

type StatusEntry = {
  id: number
  label: string
  notificationId?: string
  category?: string
  spinnerTheme?: StatusSpinnerTheme
}

export interface StatusSnapshot {
  label: string
  notificationId?: string
  category?: string
  spinnerTheme?: StatusSpinnerTheme
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`
}

function applyMetadata(entry: StatusEntry, metadata?: StatusMetadata): void {
  if (!metadata) return
  if ("notificationId" in metadata) {
    entry.notificationId = metadata.notificationId
  }
  if ("category" in metadata) {
    entry.category = metadata.category
  }
  if ("spinnerTheme" in metadata) {
    entry.spinnerTheme = metadata.spinnerTheme
  }
}

export class StatusBus {
  private listeners = new Set<StatusListener>()
  private entries: StatusEntry[] = []
  private nextId = 1

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    listener(this.current())
    return () => {
      this.listeners.delete(listener)
    }
  }

  create(label: string, metadata?: StatusMetadata): StatusHandle {
    const id = this.nextId++
    const entry: StatusEntry = { id, label }
    applyMetadata(entry, metadata)
    this.entries.push(entry)
    this.emit()

    return {
      update: (nextLabel: string, nextMetadata?: StatusMetadata) => {
        const currentEntry = this.entries.find((item) => item.id === id)
        if (!currentEntry) return
        currentEntry.label = nextLabel
        applyMetadata(currentEntry, nextMetadata)
        this.emit()
      },
      clear: () => {
        this.entries = this.entries.filter((item) => item.id !== id)
        this.emit()
      },
    }
  }

  current(): string | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1].label : null
  }

  currentStatus(): StatusSnapshot | null {
    const entry = this.entries.length > 0 ? this.entries[this.entries.length - 1] : null
    if (!entry) return null
    return {
      label: entry.label,
      notificationId: entry.notificationId,
      category: entry.category,
      spinnerTheme: entry.spinnerTheme,
    }
  }

  reset(): void {
    this.entries = []
    this.emit()
  }

  private emit(): void {
    const current = this.current()
    for (const listener of this.listeners) {
      listener(current)
    }
  }
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

export class StatusRenderer {
  private readonly bus: StatusBus
  private readonly output: StatusOutput
  private readonly maxFps: number
  private readonly spinnerManager: SpinnerManager<StatusSpinnerTheme>
  private readonly gap = " "
  private baseSpinnerTheme: StatusSpinnerTheme
  private unsubscribe: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private label: string | null = null
  private spinnerGlyph = ""
  private visible = false
  private suspended = false

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
      return
    }

    this.spinnerManager.ensureMounted()
    this.spinnerManager.setNotification(this.toNotification(status))
    this.spinnerManager.setTheme(status.spinnerTheme ?? this.baseSpinnerTheme)
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
    this.output.write(`\r\x1b[2K${prefix}${dim(this.label)}`)
    this.visible = true
  }

  private clearLine(): void {
    if (!this.visible) return
    this.output.write("\r\x1b[2K")
    this.visible = false
  }
}

export const GLOBAL_STATUS_BUS = new StatusBus()
