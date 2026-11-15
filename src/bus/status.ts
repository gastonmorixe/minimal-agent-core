type StatusListener = (label: string | null) => void

export type StatusDirection = "up" | "down" | "idle"

/**
 * What one live activity is doing right now, at a finer grain than the
 * engine's `StatusPhase` from `./status-port.ts` (which only says
 * `sending` / `receiving` / …). A semantic fact, never a label: the host
 * decides what to print for each value.
 *
 * Set by the transport while a model request runs:
 * - `connect`: an attempt started (first try or retry); no response yet.
 * - `stream`: between content blocks (after `message_start`).
 * - `thinking`: a reasoning block is open. With the thinking display omitted
 *   the provider may send no bytes for the whole block, so silence here is
 *   expected, not a stall.
 * - `writing`: a text block is open.
 * - `tool-input`: a tool call's input is streaming. Large inputs may arrive
 *   in one late burst, so silence here is expected too.
 *
 * The other values are reserved for hosts and tests; core does not set them.
 */
export type ActivityPhase =
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

/**
 * Live numbers and facts of one status entry. Every field is data (bytes,
 * epoch-ms timestamps, codes); a host derives labels, rates and "stalled"
 * verdicts from them. Patches merge field by field ({@link StatusHandle.updateActivity});
 * set a field to `null` to clear it where the type allows.
 */
export interface StatusActivity {
  direction?: StatusDirection
  /** Fine-grained phase. See {@link ActivityPhase}. */
  phase?: ActivityPhase
  /** Epoch ms the current {@link phase} began. */
  phaseStartedAt?: number
  sentBytes?: number
  recvBytes?: number
  sentTokens?: number
  recvTokens?: number
  target?: StatusActivityTarget
  startedAt?: number
  /** Epoch ms of the last response body bytes (any bytes, keep-alive pings included). */
  lastChunkAt?: number
  /**
   * Epoch ms of the last content event (anything except a keep-alive ping).
   * Prefer this over {@link lastChunkAt} to judge progress: a ping proves the
   * connection is up, not that the model produced anything.
   */
  lastContentAt?: number
  /**
   * The transport watchdog's idle budget for the current phase, in ms: how
   * long the stream may stay silent before the attempt is aborted and
   * retried. Longer while a thinking or tool-input block is open.
   */
  idleBudgetMs?: number
  /** Tool name. During `tool-input`, the tool whose input streams; `null` clears it. */
  toolName?: string | null
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
  if (partial.phaseStartedAt !== undefined) a.phaseStartedAt = partial.phaseStartedAt
  if (partial.sentBytes !== undefined) a.sentBytes = partial.sentBytes
  if (partial.recvBytes !== undefined) a.recvBytes = partial.recvBytes
  if (partial.sentTokens !== undefined) a.sentTokens = partial.sentTokens
  if (partial.recvTokens !== undefined) a.recvTokens = partial.recvTokens
  if (partial.startedAt !== undefined) a.startedAt = partial.startedAt
  if (partial.lastChunkAt !== undefined) a.lastChunkAt = partial.lastChunkAt
  if (partial.lastContentAt !== undefined) a.lastContentAt = partial.lastContentAt
  if (partial.idleBudgetMs !== undefined) a.idleBudgetMs = partial.idleBudgetMs
  if (partial.toolName === null) delete a.toolName
  else if (partial.toolName !== undefined) a.toolName = partial.toolName
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
 * The bus owns status state only. UI rendering lives under `minimal-agent-cli/src/ui/status`.
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
