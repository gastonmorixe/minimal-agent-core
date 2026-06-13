type StatusListener = (label: string | null) => void

export type StatusDirection = "up" | "down" | "idle"

export type StatusPhase =
  | "connect"
  | "upload"
  | "wait-headers"
  | "stream"
  | "thinking"
  | "writing"
  | "tool-input"
  | "tool-dispatch"
  | "tool-run"
  | "auth-refresh"
  | "error"
  | "aborted"
  | "done"

export interface StatusActivityTarget {
  host?: string
  protocol?: string
  model?: string
}

export interface StatusActivity {
  direction?: StatusDirection
  phase?: StatusPhase
  sentBytes?: number
  recvBytes?: number
  sentTokens?: number
  recvTokens?: number
  target?: StatusActivityTarget
  startedAt?: number
  lastChunkAt?: number
  toolName?: string
  hint?: string
}

export interface StatusMetadata {
  notificationId?: string
  category?: string
  /**
   * Opaque renderer-owned theme payload. The status bus stores and forwards it
   * without importing UI/spinner types.
   */
  spinnerTheme?: unknown
  activity?: StatusActivity
}

export interface StatusHandle {
  update(label: string, metadata?: StatusMetadata): void
  updateActivity(partial: StatusActivity): void
  clear(): void
}

type StatusEntry = {
  id: number
  label: string
  notificationId?: string
  category?: string
  spinnerTheme?: unknown
  activity?: StatusActivity
}

export interface StatusSnapshot {
  id: number
  label: string
  notificationId?: string
  category?: string
  spinnerTheme?: unknown
  activity?: StatusActivity
}

function applyActivity(entry: StatusEntry, partial: StatusActivity): void {
  const a = entry.activity ?? (entry.activity = {})
  if (partial.direction !== undefined) a.direction = partial.direction
  if (partial.phase !== undefined) a.phase = partial.phase
  if (partial.sentBytes !== undefined) a.sentBytes = partial.sentBytes
  if (partial.recvBytes !== undefined) a.recvBytes = partial.recvBytes
  if (partial.sentTokens !== undefined) a.sentTokens = partial.sentTokens
  if (partial.recvTokens !== undefined) a.recvTokens = partial.recvTokens
  if (partial.startedAt !== undefined) a.startedAt = partial.startedAt
  if (partial.lastChunkAt !== undefined) a.lastChunkAt = partial.lastChunkAt
  if (partial.toolName !== undefined) a.toolName = partial.toolName
  if (partial.hint !== undefined) a.hint = partial.hint
  if (partial.target) {
    a.target = { ...(a.target ?? {}), ...partial.target }
  }
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
  if (metadata.activity) {
    applyActivity(entry, metadata.activity)
  }
}

/**
 * Ordered registry of active status entries with a tiny pub/sub layer.
 *
 * The bus owns status state only. UI rendering lives under `src/ui/status`.
 */
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
      updateActivity: (partial: StatusActivity) => {
        const currentEntry = this.entries.find((item) => item.id === id)
        if (!currentEntry) return
        applyActivity(currentEntry, partial)
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
      id: entry.id,
      label: entry.label,
      notificationId: entry.notificationId,
      category: entry.category,
      spinnerTheme: entry.spinnerTheme,
      activity: entry.activity ? { ...entry.activity } : undefined,
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

export const GLOBAL_STATUS_BUS = new StatusBus()
