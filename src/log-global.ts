/**
 * Persistent, cross-session global log sink.
 *
 * Complements `FileLogSink` (in `./log-file.ts`) (one file PER
 * session, `~/.minimal-agent/logs/ma-session-<sid>.log`) with a SINGLE durable
 * log that survives across runs: `~/.minimal-agent/ma.log`. This is the
 * long-lived audit trail for subsystems whose history matters beyond one
 * session: binary installs, updates, and removals first, more later.
 *
 * Same RFC 5424 line format as the session sink (via {@link formatRfc5424}),
 * so one parser reads both. Each line carries the session id in
 * STRUCTURED-DATA (`sid="…"`) so a global log line can be traced back to the
 * run that produced it.
 *
 * Design choices mirror the session sink:
 *   - Append-only, synchronous `appendFileSync` (low volume, crash-safe).
 *   - Best-effort: a write error (ENOSPC, EACCES, RO fs) is swallowed, never
 *     thrown into the producer.
 *   - Size-based rotation: when the file would exceed `maxBytes`, it is rotated
 *     to `ma.log.1` (single generation) before the new line is written, so the
 *     durable log can't grow without bound.
 *
 * The sink subscribes to the {@link DiagnosticBus} like any other, so it is
 * filterable by severity. By default it logs at `Notice` and above (the global
 * audit trail wants meaningful events, not Debug spam); the per-session file
 * sink keeps logging everything.
 *
 * @module log-global
 */

import {
  appendFileSync as realAppend,
  mkdirSync as realMkdir,
  renameSync as realRename,
  statSync as realStat,
} from "node:fs"
import { homedir, hostname as osHostname } from "node:os"
import { join } from "node:path"

import { type DiagnosticBus, type LogEvent, Severity } from "./diagnostic-bus.ts"
import { formatRfc5424 } from "./syslog.ts"

const DEFAULT_PATH = join(homedir(), ".minimal-agent", "ma.log")
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 10 MiB durable cap

export interface GlobalLogSinkFs {
  mkdirSync: (path: string, opts?: { recursive?: boolean }) => void
  appendFileSync: (path: string, data: string) => void
  renameSync: (from: string, to: string) => void
  statSync: (path: string) => { size: number }
}

const REAL_FS: GlobalLogSinkFs = {
  mkdirSync: (path, opts) => {
    realMkdir(path, { recursive: opts?.recursive ?? false })
  },
  appendFileSync: (path, data) => realAppend(path, data),
  renameSync: (from, to) => realRename(from, to),
  statSync: (path) => realStat(path),
}

export interface GlobalLogSinkOptions {
  /** Absolute path to the durable log. Default `~/.minimal-agent/ma.log`. */
  path?: string
  /** Session id stamped into every line's STRUCTURED-DATA (`sid="…"`). */
  sessionId?: string
  /**
   * Highest severity number still logged. Default `Severity.Notice` (5):
   * the durable audit log skips Info/Debug. Set to `Severity.Debug` to log
   * everything, or `Severity.Warning` to log only problems.
   */
  level?: Severity
  /** Rotate to `<path>.1` once the file would exceed this many bytes. Default 10 MiB. */
  maxBytes?: number
  /** Injected filesystem. Default: real `node:fs`. */
  fs?: GlobalLogSinkFs
  /** RFC 5424 HOSTNAME. Default `os.hostname()`. */
  hostname?: string
  /** RFC 5424 PROCID. Default `process.pid`. */
  procId?: number | string
}

/**
 * Subscribe-able durable log sink. Construct once at boot, `attach(bus)`.
 */
export class GlobalLogSink {
  readonly path: string
  private readonly opts: {
    sessionId: string | undefined
    level: Severity
    maxBytes: number
    fs: GlobalLogSinkFs
    hostname: string
    procId: number | string
  }
  private preparedDir = false
  private disposeFn: (() => void) | null = null

  constructor(opts: GlobalLogSinkOptions = {}) {
    this.path = opts.path ?? DEFAULT_PATH
    this.opts = {
      sessionId: opts.sessionId,
      level: opts.level ?? Severity.Notice,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      fs: opts.fs ?? REAL_FS,
      hostname: opts.hostname ?? safeHostname(),
      procId: opts.procId ?? process.pid,
    }
  }

  attach(bus: DiagnosticBus): void {
    if (this.disposeFn) return
    this.disposeFn = bus.on("*", (e) => this.write(e))
  }

  detach(): void {
    this.disposeFn?.()
    this.disposeFn = null
  }

  /**
   * Format one event the way it lands in the file. Exposed so a caller can
   * write a line synchronously without going through the bus (e.g. an audit
   * record emitted from a context that has the sink but not the bus).
   */
  format(event: LogEvent): string {
    const sd = this.opts.sessionId
      ? { ...(event.structuredData ?? {}), sid: this.opts.sessionId }
      : event.structuredData
    return `${formatRfc5424(
      { ...event, structuredData: sd },
      { hostname: this.opts.hostname, procId: this.opts.procId },
    )}\n`
  }

  private write(event: LogEvent): void {
    if (event.severity > this.opts.level) return
    try {
      if (!this.preparedDir) {
        this.opts.fs.mkdirSync(dirOf(this.path), { recursive: true })
        this.preparedDir = true
      }
      const line = this.format(event)
      this.maybeRotate(line.length)
      this.opts.fs.appendFileSync(this.path, line)
    } catch {
      // Disk full, perms, RO fs. Never propagate into the producer.
    }
  }

  /** Rotate `path` → `path.1` (single generation) if adding `addLen` bytes would exceed the cap. */
  private maybeRotate(addLen: number): void {
    let size = 0
    try {
      size = this.opts.fs.statSync(this.path).size
    } catch {
      return // file doesn't exist yet → nothing to rotate
    }
    if (size + addLen <= this.opts.maxBytes) return
    try {
      this.opts.fs.renameSync(this.path, `${this.path}.1`)
    } catch {
      // Rotation failed (e.g. cross-device); fall through and keep appending.
    }
  }
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/")
  return i < 0 ? "." : p.slice(0, i) || "/"
}

function safeHostname(): string {
  try {
    return osHostname()
  } catch {
    return "-"
  }
}
