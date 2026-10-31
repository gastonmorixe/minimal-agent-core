/**
 * Session event log (S48): one ordered log per session that carries
 * everything a frontend needs.
 *
 * Each entry is a {@link SessionEntry}:
 *
 *   `{ v: 1, seq, ts, sessionId, ch: "event" | "diag", data }`
 *
 *   - `ch: "event"`: `data` is an {@link AgentEvent} from the agent loop.
 *   - `ch: "diag"`: `data` is a {@link DiagnosticEvent}. It reuses the
 *     `Severity` and `Facility` enums of the diagnostic bus.
 *
 * Rules:
 *   - `seq` starts at 0 and grows by one per entry. It is monotonic per
 *     session. With a durable file, a log opened again after a restart
 *     continues after the last `seq` in the file.
 *   - Memory is a bounded ring buffer (`capacity` entries). The oldest entry
 *     is dropped when it is full.
 *   - {@link SessionEventLog.subscribe} with `fromSeq` replays from that `seq`,
 *     then streams live entries. Without `fromSeq` it streams live entries
 *     only. When `fromSeq` has fallen out of the buffer, older entries come
 *     from the durable file if there is one. Whatever is still missing is
 *     reported once through `onGap`, and the replay starts at the oldest
 *     entry that still exists.
 *   - Durable mode appends one JSON line per entry to a file, by default
 *     `<sessions>/<sid>.events.jsonl` ({@link eventLogFilePath}). Writes are
 *     synchronous, like `SessionStore`, so a crash loses no committed entry.
 *     A torn last line is dropped on load. One process writes a file at a
 *     time. The first write failure emits one `events.persist-error` entry.
 *   - Listeners are isolated (S22). A listener that throws never affects the
 *     producer or other listeners. Its first throw emits exactly one
 *     `events.sink-error` diag entry. Later throws are counted
 *     ({@link SessionEventLog.stats}).
 *   - Every listener sees entries in `seq` order, exactly once. An entry
 *     appended from inside a listener is delivered after the current entry
 *     reaches every listener.
 *   - The wire format is the entry itself: one JSON line
 *     ({@link serializeEntry}) or one SSE event with `id: seq`
 *     ({@link serializeEntrySse}).
 *
 * No module state: every log is an instance, created per session.
 *
 * @module session/event-log
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { Facility, type LogEvent, Severity, type StructuredData } from "../bus/diagnostic-bus.ts"
import type { AgentEvent } from "../sdk/events.ts"
import {
  createSinkGuard,
  SINK_ERROR_CODE,
  type SinkGuard,
  sinkErrorMessage,
} from "../sdk/sink-guard.ts"

import { defaultSessionsDir } from "./session-store.ts"

// ---------------------------------------------------------------------------
// Entry shape
// ---------------------------------------------------------------------------

/** Version of the {@link SessionEntry} shape. Bumped only on a breaking change. */
export const SESSION_ENTRY_VERSION = 1

/** Ring buffer size when the caller does not set `capacity`. */
export const DEFAULT_EVENT_LOG_CAPACITY = 10_000

/** Diagnostic code for the first failed write of the durable file. */
export const PERSIST_ERROR_CODE = "events.persist-error"

/** The two channels of a session log. */
export type SessionChannel = "event" | "diag"

/** One diagnostic in the session log (`ch: "diag"`). */
export interface DiagnosticEvent {
  /** RFC 5424 severity. Lower number = more severe. */
  readonly severity: Severity
  /** RFC 5424 facility. */
  readonly facility: Facility
  /** Dotted-kebab id, e.g. `events.sink-error`. Same role as `LogEvent.source`. */
  readonly code: string
  /** Single-line message. */
  readonly message: string
  /** Optional key/value details. */
  readonly data?: StructuredData
}

/** Fields every {@link SessionEntry} has. */
interface SessionEntryBase {
  readonly v: typeof SESSION_ENTRY_VERSION
  /** Position in the session log. Starts at 0, grows by one. */
  readonly seq: number
  /** Append time, epoch ms. */
  readonly ts: number
  readonly sessionId: string
}

/** An agent event in the session log. */
export interface SessionEventEntry extends SessionEntryBase {
  readonly ch: "event"
  readonly data: AgentEvent
}

/** A diagnostic in the session log. */
export interface SessionDiagEntry extends SessionEntryBase {
  readonly ch: "diag"
  readonly data: DiagnosticEvent
}

/** One entry of the session log. This is also the wire format. */
export type SessionEntry = SessionEventEntry | SessionDiagEntry

/** Receives entries from {@link SessionEventLog.subscribe}. */
export type SessionEntryListener = (entry: SessionEntry) => void

/** Stops a subscription. Calling it again does nothing. */
export type Unsubscribe = () => void

/** Map a diagnostic-bus {@link LogEvent} to a {@link DiagnosticEvent}. */
export function diagnosticFromLogEvent(event: LogEvent): DiagnosticEvent {
  return {
    severity: event.severity,
    facility: event.facility,
    code: event.source,
    message: event.message,
    ...(event.structuredData ? { data: event.structuredData } : {}),
  }
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** Serialize one entry as one JSONL line (compact JSON plus `\n`). */
export function serializeEntry(entry: SessionEntry): string {
  return `${JSON.stringify(entry)}\n`
}

/**
 * Serialize one entry as one SSE event: `id: <seq>`, then one `data:` line
 * with the entry JSON. `JSON.stringify` escapes newlines, so one `data:`
 * line is always enough. A browser sends the last `id` back as
 * `Last-Event-ID`; resume with `fromSeq: lastEventId + 1`.
 */
export function serializeEntrySse(entry: SessionEntry): string {
  return `id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`
}

/** Parse one JSONL line into an entry. Returns `null` for anything that is not one. */
export function parseEntryLine(line: string): SessionEntry | null {
  const text = line.trim()
  if (text.length === 0) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  return isSessionEntry(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isIntIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

function isStructuredData(value: unknown): value is StructuredData {
  if (!isRecord(value)) return false
  for (const v of Object.values(value)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return false
  }
  return true
}

function isDiagnosticEvent(value: unknown): value is DiagnosticEvent {
  return (
    isRecord(value) &&
    isIntIn(value.severity, Severity.Emergency, Severity.Debug) &&
    isIntIn(value.facility, Facility.Kern, Facility.Local7) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.data === undefined || isStructuredData(value.data))
  )
}

function isAgentEventShape(value: unknown): value is AgentEvent {
  // Event kinds are additive, so any object with a string `type` passes.
  return isRecord(value) && typeof value.type === "string"
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value)) return false
  if (value.v !== SESSION_ENTRY_VERSION) return false
  if (!isSeq(value.seq) || typeof value.ts !== "number" || typeof value.sessionId !== "string") {
    return false
  }
  if (value.ch === "event") return isAgentEventShape(value.data)
  if (value.ch === "diag") return isDiagnosticEvent(value.data)
  return false
}

// ---------------------------------------------------------------------------
// Durable file
// ---------------------------------------------------------------------------

/**
 * Default path of a session's durable event log: `<dir>/<sid>.events.jsonl`,
 * a sidecar of the `<sid>.jsonl` transcript.
 *
 * @param sid - Session id
 * @param dir - Sessions directory (defaults to `~/.minimal-agent/sessions/`)
 */
export function eventLogFilePath(sid: string, dir: string = defaultSessionsDir()): string {
  return join(dir, `${sid}.events.jsonl`)
}

/** Result of {@link readEventLogFile}. */
export interface EventLogFileContents {
  /** Valid entries, in ascending `seq` order. */
  readonly entries: SessionEntry[]
  /** Lines skipped: torn, malformed, another session, or out of order. */
  readonly dropped: number
}

/**
 * Read a whole durable event log. A missing or unreadable file reads as
 * empty. Use it to replay a session that no process has open.
 *
 * @param path - File path, see {@link eventLogFilePath}
 * @param sessionId - When set, entries of other sessions are dropped
 */
export function readEventLogFile(path: string, sessionId?: string): EventLogFileContents {
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    return { entries: [], dropped: 0 }
  }
  const entries: SessionEntry[] = []
  let dropped = 0
  let lastSeq = -1
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue
    const entry = parseEntryLine(line)
    if (
      entry === null ||
      (sessionId !== undefined && entry.sessionId !== sessionId) ||
      entry.seq <= lastSeq
    ) {
      dropped++
      continue
    }
    lastSeq = entry.seq
    entries.push(entry)
  }
  return { entries, dropped }
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

/** Fixed-capacity FIFO of entries in ascending `seq` order. */
class EntryRing {
  private readonly slots: SessionEntry[] = []
  private start = 0

  constructor(readonly capacity: number) {}

  get size(): number {
    return this.slots.length
  }

  push(entry: SessionEntry): void {
    if (this.slots.length < this.capacity) {
      this.slots.push(entry)
      return
    }
    this.slots[this.start] = entry
    this.start = (this.start + 1) % this.capacity
  }

  at(index: number): SessionEntry {
    return this.slots[(this.start + index) % this.slots.length]
  }

  /** Copy of the entries with `seq >= seq`, oldest first. */
  from(seq: number): SessionEntry[] {
    let lo = 0
    let hi = this.slots.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.at(mid).seq < seq) lo = mid + 1
      else hi = mid
    }
    const out: SessionEntry[] = []
    for (let i = lo; i < this.slots.length; i++) out.push(this.at(i))
    return out
  }
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

/** Options for {@link SessionEventLog}. */
export interface SessionEventLogOptions {
  /** Session id stamped on every entry. */
  readonly sessionId: string
  /** Ring buffer size in entries. Default {@link DEFAULT_EVENT_LOG_CAPACITY}. */
  readonly capacity?: number
  /**
   * Durable JSONL file. When set, existing entries are loaded (the newest
   * `capacity` of them into memory) and new entries are appended. Absent
   * means memory only. See {@link eventLogFilePath}.
   */
  readonly path?: string
  /** Clock for `ts`, epoch ms. Default `Date.now`. */
  readonly now?: () => number
}

/** Reported once by `onGap` when a replay cannot start at `fromSeq`. */
export interface ReplayGap {
  /** The `seq` the subscriber asked for. */
  readonly fromSeq: number
  /** The oldest `seq` the log still has. Entries `fromSeq .. firstSeq - 1` are lost. */
  readonly firstSeq: number
}

/** Options for {@link SessionEventLog.subscribe}. */
export interface SubscribeOptions {
  /**
   * Replay from this `seq`, then stream live entries. Absent means live
   * entries only. A value above the next `seq` also means live only.
   */
  readonly fromSeq?: number
  /** Channels to receive. Default: both. */
  readonly channels?: readonly SessionChannel[]
  /**
   * Least severe diagnostic to receive. RFC 5424 numbers run backwards, so
   * `Severity.Warning` means warning and everything more severe. Event
   * entries are never filtered by severity. Default: every severity.
   */
  readonly minSeverity?: Severity
  /** Called once, before the replay, when the head of the replay is lost. */
  readonly onGap?: (gap: ReplayGap) => void
  /** Name used in the `events.sink-error` diagnostic. Default `listener-<n>`. */
  readonly name?: string
}

/** Counters from {@link SessionEventLog.stats}. */
export interface SessionEventLogStats {
  /** Oldest `seq` in memory. Equals `nextSeq` when memory is empty. */
  readonly firstSeq: number
  /** The `seq` the next entry gets. */
  readonly nextSeq: number
  /** Entries in memory. */
  readonly size: number
  readonly capacity: number
  /** Active subscriptions. */
  readonly listeners: number
  /** Listener throws caught so far, all listeners. */
  readonly sinkErrors: number
  /** Failed durable writes so far. */
  readonly persistErrors: number
}

interface Subscriber {
  readonly listener: SessionEntryListener
  readonly name: string
  readonly channels: ReadonlySet<SessionChannel> | null
  readonly minSeverity: Severity | null
  readonly guard: SinkGuard
  /** Next `seq` this subscriber may get. Lower ones were replayed or skipped. */
  cursor: number
  active: boolean
}

const CHANNELS: ReadonlySet<string> = new Set<SessionChannel>(["event", "diag"])

/**
 * The ordered event log of one session. See the module doc for the rules.
 *
 * Producers call {@link appendEvent} and {@link appendDiag}. Consumers call
 * {@link subscribe}. Neither ever throws because of the other side.
 */
export class SessionEventLog {
  readonly sessionId: string
  /** Durable file, or `undefined` for a memory-only log. */
  readonly path: string | undefined
  private readonly ring: EntryRing
  private readonly now: () => number
  private readonly subscribers = new Set<Subscriber>()
  /** Entries appended but not yet delivered to every subscriber. */
  private readonly pending: SessionEntry[] = []
  private delivering = false
  private seq = 0
  private listenerCount = 0
  private sinkErrors = 0
  private persistErrors = 0

  /**
   * Create the log. With `path`, load the existing file first.
   *
   * @throws RangeError when `capacity` is not a positive integer
   */
  constructor(options: SessionEventLogOptions) {
    const capacity = options.capacity ?? DEFAULT_EVENT_LOG_CAPACITY
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError(`event log capacity must be a positive integer, got ${capacity}`)
    }
    this.sessionId = options.sessionId
    this.path = options.path
    this.ring = new EntryRing(capacity)
    this.now = options.now ?? Date.now
    if (this.path !== undefined) this.load(this.path)
  }

  /** Append an agent event. Returns the committed entry. Never throws. */
  appendEvent(event: AgentEvent): SessionEventEntry {
    const entry: SessionEventEntry = {
      v: SESSION_ENTRY_VERSION,
      seq: this.seq++,
      ts: this.now(),
      sessionId: this.sessionId,
      ch: "event",
      data: event,
    }
    this.commit(entry)
    return entry
  }

  /** Append a diagnostic. Returns the committed entry. Never throws. */
  appendDiag(diag: DiagnosticEvent): SessionDiagEntry {
    const entry: SessionDiagEntry = {
      v: SESSION_ENTRY_VERSION,
      seq: this.seq++,
      ts: this.now(),
      sessionId: this.sessionId,
      ch: "diag",
      data: diag,
    }
    this.commit(entry)
    return entry
  }

  /**
   * Subscribe to entries. With `fromSeq`, the replay runs synchronously,
   * before this returns. Live entries follow.
   *
   * @throws RangeError when `fromSeq`, `channels`, or `minSeverity` is invalid
   */
  subscribe(listener: SessionEntryListener, options: SubscribeOptions = {}): Unsubscribe {
    const { fromSeq, channels, minSeverity } = options
    if (fromSeq !== undefined && !isSeq(fromSeq)) {
      throw new RangeError(`fromSeq must be a non-negative integer, got ${fromSeq}`)
    }
    if (channels !== undefined && !channels.every((ch) => CHANNELS.has(ch))) {
      throw new RangeError(`unknown channel in ${JSON.stringify(channels)}`)
    }
    if (minSeverity !== undefined && !isIntIn(minSeverity, Severity.Emergency, Severity.Debug)) {
      throw new RangeError(`minSeverity must be a Severity, got ${minSeverity}`)
    }
    this.listenerCount++
    const name = options.name ?? `listener-${this.listenerCount}`
    const sub: Subscriber = {
      listener,
      name,
      channels: channels === undefined ? null : new Set(channels),
      minSeverity: minSeverity ?? null,
      guard: createSinkGuard((failure) => this.reportSinkError(name, failure.message)),
      cursor: Math.min(fromSeq ?? this.seq, this.seq),
      active: true,
    }
    this.subscribers.add(sub)
    if (fromSeq !== undefined) {
      // Entries appended during the replay wait in `pending`, so they reach
      // this subscriber after the replay, in order.
      const outer = this.delivering
      this.delivering = true
      try {
        this.replay(sub, fromSeq, options.onGap)
      } finally {
        this.delivering = outer
      }
      this.drain()
    }
    return () => {
      sub.active = false
      this.subscribers.delete(sub)
    }
  }

  /** Current counters. */
  stats(): SessionEventLogStats {
    return {
      firstSeq: this.ring.size > 0 ? this.ring.at(0).seq : this.seq,
      nextSeq: this.seq,
      size: this.ring.size,
      capacity: this.ring.capacity,
      listeners: this.subscribers.size,
      sinkErrors: this.sinkErrors,
      persistErrors: this.persistErrors,
    }
  }

  private load(path: string): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {
      // The first append reports it as `events.persist-error`.
    }
    const { entries } = readEventLogFile(path, this.sessionId)
    const keep = entries.slice(-this.ring.capacity)
    for (const entry of keep) this.ring.push(entry)
    const last = entries.at(-1)
    if (last !== undefined) this.seq = last.seq + 1
  }

  private commit(entry: SessionEntry): void {
    this.ring.push(entry)
    const writeError = this.persist(entry)
    this.pending.push(entry)
    this.drain()
    // Reported after the entry is queued, so the diagnostic gets a later seq
    // and listeners still see entries in order.
    if (writeError !== null) this.reportPersistError(entry.seq, writeError)
  }

  /** Append one line to the durable file. Returns the error text, or `null`. */
  private persist(entry: SessionEntry): string | null {
    if (this.path === undefined) return null
    try {
      appendFileSync(this.path, serializeEntry(entry))
      return null
    } catch (error) {
      return sinkErrorMessage(error)
    }
  }

  private reportPersistError(seq: number, error: string): void {
    this.persistErrors++
    if (this.persistErrors > 1) return
    this.appendDiag({
      severity: Severity.Error,
      facility: Facility.User,
      code: PERSIST_ERROR_CODE,
      message: `session event log write failed; later failures are counted, not reported: ${error}`,
      data: { path: this.path ?? "", seq, error },
    })
  }

  private reportSinkError(listener: string, error: string): void {
    this.appendDiag({
      severity: Severity.Error,
      facility: Facility.User,
      code: SINK_ERROR_CODE,
      message: `session event listener ${listener} threw; later failures are counted, not reported: ${error}`,
      data: { listener, error },
    })
  }

  /** Deliver pending entries to every subscriber, oldest first. */
  private drain(): void {
    if (this.delivering) return
    this.delivering = true
    try {
      // `pending` can grow while this runs (a listener appends, or a first
      // failure is reported). The index loop picks those up too.
      for (let i = 0; i < this.pending.length; i++) {
        const entry = this.pending[i]
        for (const sub of this.subscribers) this.deliver(sub, entry)
      }
    } finally {
      this.pending.length = 0
      this.delivering = false
    }
  }

  private deliver(sub: Subscriber, entry: SessionEntry): void {
    if (!sub.active || entry.seq < sub.cursor) return
    sub.cursor = entry.seq + 1
    if (sub.channels !== null && !sub.channels.has(entry.ch)) return
    if (entry.ch === "diag" && sub.minSeverity !== null && entry.data.severity > sub.minSeverity) {
      return
    }
    if (!sub.guard.call(() => sub.listener(entry))) this.sinkErrors++
  }

  private replay(sub: Subscriber, fromSeq: number, onGap?: (gap: ReplayGap) => void): void {
    const memoryFirst = this.ring.size > 0 ? this.ring.at(0).seq : this.seq
    // Entries older than memory can only come from the durable file.
    const older: SessionEntry[] = []
    if (fromSeq < memoryFirst && this.path !== undefined) {
      for (const entry of readEventLogFile(this.path, this.sessionId).entries) {
        if (entry.seq >= fromSeq && entry.seq < memoryFirst) older.push(entry)
      }
    }
    // Copy before any callback runs: an append during the replay (a reported
    // failure, or a listener that appends) can overwrite ring slots.
    const recent = this.ring.from(fromSeq)
    const firstSeq = older[0]?.seq ?? memoryFirst
    if (fromSeq < firstSeq && onGap !== undefined) {
      if (!sub.guard.call(() => onGap({ fromSeq, firstSeq }))) this.sinkErrors++
    }
    for (const entry of older) this.deliver(sub, entry)
    for (const entry of recent) this.deliver(sub, entry)
  }
}
