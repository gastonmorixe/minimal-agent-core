/**
 * File-backed log sink: subscribes to a {@link DiagnosticBus} and
 * appends each event as an RFC 5424 line to
 * `~/.minimal-agent/logs/ma-session-<sid>.log`.
 *
 * # Why a file (not stderr / scrollback)?
 *
 * The agent's `StdioInterceptor` (src/ui/stdio-interceptor.ts) patches
 * `process.stderr.write` to forward through the compositor, which
 * routes everything to scrollback above the prompt. A naive scheduler
 * log on a flaky network sleeps overnight and paints 100+ identical
 * lines above the prompt — exactly the bug that motivated this
 * subsystem.
 *
 * The file sink keeps full detail off-screen and parseable. The TUI
 * surface (src/log-tui.ts) is a separate, deduped, summary view.
 *
 * # Best-effort I/O
 *
 * Logging MUST NEVER throw into the producer. mkdir/append errors
 * (ENOSPC, EACCES, RO filesystem) are swallowed; the sink silently
 * drops the event. We rely on stderr-mirror or the TUI surface as
 * backstops when the file path is unwritable.
 *
 * # Sync writes
 *
 * `appendFileSync` is a deliberate choice over async/batched:
 *
 * - Volume is low (<1000 events/session typical, often <50).
 * - Each write completes in <0.1ms on a local SSD.
 * - Crash-safety: every event lands on disk before the producer
 *   returns. We don't lose the last few events on a SIGKILL.
 *
 * If we ever need async batching, swap the implementation behind this
 * file; the bus contract doesn't change.
 *
 * # Configuration
 *
 * - `dir`: default `~/.minimal-agent/logs/`. Override for tests.
 * - `level`: highest severity number still logged. Default
 *   `Severity.Debug` (= all). Set to `Warning` to skip Notice/Info/Debug.
 * - `maxBytes`: soft cap. After this many bytes, one cap notice is
 *   appended and further events are silently dropped. Default 50 MB.
 * - `fs`: dependency-injected for tests.
 *
 * @module log-file
 */

import { appendFileSync as realAppend, mkdirSync as realMkdir } from "node:fs"
import { homedir, hostname as osHostname } from "node:os"
import { join } from "node:path"

import { type DiagnosticBus, Facility, type LogEvent, Severity } from "./diagnostic-bus.ts"
import { formatRfc5424 } from "./syslog.ts"

const DEFAULT_DIR = join(homedir(), ".minimal-agent", "logs")
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 // 50 MiB

export interface FileLogSinkFs {
  mkdirSync: (path: string, opts?: { recursive?: boolean }) => void
  appendFileSync: (path: string, data: string) => void
}

const REAL_FS: FileLogSinkFs = {
  mkdirSync: (path, opts) => {
    realMkdir(path, { recursive: opts?.recursive ?? false })
  },
  appendFileSync: (path, data) => realAppend(path, data),
}

export interface FileLogSinkOptions {
  /** Directory for the log file. Default: `~/.minimal-agent/logs/`. */
  dir?: string
  /**
   * Highest severity number still logged. Default `Severity.Debug` (7),
   * which is "log everything". Set to `Severity.Warning` (4) to skip
   * Notice/Info/Debug.
   */
  level?: Severity
  /**
   * Soft cap on bytes written. After this is exceeded, one cap notice
   * is appended and further events are dropped. Default 50 MiB.
   */
  maxBytes?: number
  /** Injected filesystem operations. Default: real `node:fs`. */
  fs?: FileLogSinkFs
  /** RFC 5424 HOSTNAME field. Default: `os.hostname()`. */
  hostname?: string
  /** RFC 5424 PROCID field. Default: `process.pid`. */
  procId?: number | string
  /** Custom SD-ID for STRUCTURED-DATA. Default: `ma@local`. */
  sdId?: string
  /** Clock injection for tests (used in cap-notice ts). */
  now?: () => number
}

export class FileLogSink {
  readonly path: string

  private readonly opts: {
    fs: FileLogSinkFs
    level: Severity
    maxBytes: number
    hostname: string
    procId: number | string
    sdId: string | undefined
    now: () => number
  }

  private bytesWritten = 0
  private dropped = false
  private prepared = false
  private disposeFn: (() => void) | null = null

  constructor(sid: string, opts: FileLogSinkOptions = {}) {
    const dir = opts.dir ?? DEFAULT_DIR
    this.path = join(dir, `ma-session-${sid}.log`)
    this.opts = {
      fs: opts.fs ?? REAL_FS,
      level: opts.level ?? Severity.Debug,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      hostname: opts.hostname ?? safeHostname(),
      procId: opts.procId ?? process.pid,
      sdId: opts.sdId,
      now: opts.now ?? (() => Date.now()),
    }
  }

  attach(bus: DiagnosticBus): void {
    if (this.disposeFn) return // idempotent
    this.disposeFn = bus.on("*", (e) => this.write(e))
  }

  detach(): void {
    this.disposeFn?.()
    this.disposeFn = null
  }

  private write(event: LogEvent): void {
    if (event.severity > this.opts.level) return
    if (this.dropped) return
    try {
      if (!this.prepared) {
        // Use the dir component of `this.path`, NOT the file path itself
        // — mkdirSync(file) on a non-existing intermediate parent fails.
        this.opts.fs.mkdirSync(dirOf(this.path), { recursive: true })
        this.prepared = true
      }
      const line =
        formatRfc5424(event, {
          hostname: this.opts.hostname,
          procId: this.opts.procId,
          sdId: this.opts.sdId,
        }) + "\n"

      if (this.bytesWritten + line.length > this.opts.maxBytes) {
        // Emit a single cap notice. After this, `this.dropped` is set,
        // so subsequent events fall through the early return above.
        const cap =
          formatRfc5424(
            {
              ts: this.opts.now(),
              severity: Severity.Notice,
              facility: Facility.User,
              source: "log-file.cap",
              message: "file size cap reached; dropping further events",
              structuredData: {
                "max-bytes": this.opts.maxBytes,
                "bytes-written": this.bytesWritten,
              },
            },
            {
              hostname: this.opts.hostname,
              procId: this.opts.procId,
              sdId: this.opts.sdId,
            },
          ) + "\n"
        this.opts.fs.appendFileSync(this.path, cap)
        this.bytesWritten += cap.length
        this.dropped = true
        return
      }

      this.opts.fs.appendFileSync(this.path, line)
      this.bytesWritten += line.length
    } catch {
      // Disk full, perms, RO filesystem, etc. Never propagate.
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
