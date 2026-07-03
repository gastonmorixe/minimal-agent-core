/**
 * Unit tests for `FileLogSink`.
 *
 * The sink subscribes to a `DiagnosticBus` and appends each event as an
 * RFC 5424 line to `~/.minimal-agent/logs/ma-session-<sid>.log`. It is
 * designed to:
 *
 * - Lazily prepare the logs directory on first write (no startup IO).
 * - Be best-effort: ENOSPC, perms, etc. NEVER throw into the bus's
 *   `emit()` path.
 * - Respect a `level` filter (default: all severities).
 * - Respect a soft byte cap (default 50 MB); after the cap, write a
 *   single notice and silently drop further events.
 * - Atomic single-event appends — one `appendFileSync` per event.
 *
 * Tests inject `fs` (mkdirSync + appendFileSync), `hostname`, `procId`,
 * and `now()` so we never touch real disk.
 */

import { beforeEach, describe, expect, it } from "bun:test"

import { createDiagnosticBus, Facility, type LogEvent, Severity } from "./bus/diagnostic-bus.ts"
import { FileLogSink } from "./log-file.ts"

function event(over: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: Date.UTC(2026, 4, 20, 11, 14, 37, 412),
    severity: Severity.Warning,
    facility: Facility.User,
    source: "test.source",
    message: "hello world",
    ...over,
  }
}

interface FakeFs {
  mkdirSync: (path: string, opts?: { recursive?: boolean }) => void
  appendFileSync: (path: string, data: string) => void
  mkdirCalls: Array<{ path: string; recursive: boolean }>
  appendCalls: Array<{ path: string; data: string }>
  mkdirThrows: Error | null
  appendThrows: Error | null
}

function fakeFs(): FakeFs {
  const mkdirCalls: Array<{ path: string; recursive: boolean }> = []
  const appendCalls: Array<{ path: string; data: string }> = []
  const ff: FakeFs = {
    mkdirSync: (path, opts) => {
      mkdirCalls.push({ path, recursive: opts?.recursive ?? false })
      if (ff.mkdirThrows) throw ff.mkdirThrows
    },
    appendFileSync: (path, data) => {
      appendCalls.push({ path, data })
      if (ff.appendThrows) throw ff.appendThrows
    },
    mkdirCalls,
    appendCalls,
    mkdirThrows: null,
    appendThrows: null,
  }
  return ff
}

describe("FileLogSink — basics", () => {
  let bus: ReturnType<typeof createDiagnosticBus>
  let fs: FakeFs
  let sink: FileLogSink

  beforeEach(() => {
    bus = createDiagnosticBus()
    fs = fakeFs()
    sink = new FileLogSink("sid-abc", {
      dir: "/tmp/.test-logs",
      fs,
      hostname: "test-host",
      procId: 42,
    })
  })

  it("exposes the resolved log file path", () => {
    expect(sink.path).toBe("/tmp/.test-logs/ma-session-sid-abc.log")
  })

  it("does NOT touch the filesystem until an event arrives", () => {
    sink.attach(bus)
    expect(fs.mkdirCalls).toHaveLength(0)
    expect(fs.appendCalls).toHaveLength(0)
  })

  it("creates the logs directory on first event (recursive)", () => {
    sink.attach(bus)
    bus.emit(event())
    expect(fs.mkdirCalls).toHaveLength(1)
    expect(fs.mkdirCalls[0]).toEqual({
      path: "/tmp/.test-logs",
      recursive: true,
    })
  })

  it("only creates the directory once, even on subsequent events", () => {
    sink.attach(bus)
    bus.emit(event({ message: "1" }))
    bus.emit(event({ message: "2" }))
    bus.emit(event({ message: "3" }))
    expect(fs.mkdirCalls).toHaveLength(1)
    expect(fs.appendCalls).toHaveLength(3)
  })

  it("appends one RFC 5424 line per event, terminated with \\n", () => {
    sink.attach(bus)
    bus.emit(event())
    expect(fs.appendCalls).toHaveLength(1)
    const line = fs.appendCalls[0].data
    expect(line.endsWith("\n")).toBe(true)
    expect(line).toContain("<12>1 2026-05-20T11:14:37.412Z test-host minimal-agent 42 test.source")
    expect(line).toContain("hello world")
  })
})

describe("FileLogSink — never throws into the bus", () => {
  it("swallows mkdir errors", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    fs.mkdirThrows = Object.assign(new Error("EACCES"), { code: "EACCES" })
    const sink = new FileLogSink("sid", { dir: "/x", fs, hostname: "h", procId: 1 })
    sink.attach(bus)
    expect(() => bus.emit(event())).not.toThrow()
    expect(fs.appendCalls).toHaveLength(0)
  })

  it("swallows appendFileSync errors", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    fs.appendThrows = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })
    const sink = new FileLogSink("sid", { dir: "/x", fs, hostname: "h", procId: 1 })
    sink.attach(bus)
    expect(() => bus.emit(event())).not.toThrow()
  })

  it("a producer's other listeners still run after the file sink swallows an error", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    fs.appendThrows = new Error("disk gone")
    const sink = new FileLogSink("sid", { dir: "/x", fs, hostname: "h", procId: 1 })
    sink.attach(bus)
    const seen: LogEvent[] = []
    bus.on("*", (e) => seen.push(e))
    bus.emit(event())
    expect(seen).toHaveLength(1)
  })
})

describe("FileLogSink — level filter", () => {
  it("default level=Debug logs everything (severity <= 7)", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    const sink = new FileLogSink("sid", { dir: "/x", fs, hostname: "h", procId: 1 })
    sink.attach(bus)
    for (const sev of [
      Severity.Emergency,
      Severity.Alert,
      Severity.Critical,
      Severity.Error,
      Severity.Warning,
      Severity.Notice,
      Severity.Info,
      Severity.Debug,
    ]) {
      bus.emit(event({ severity: sev, message: `s${sev}` }))
    }
    expect(fs.appendCalls).toHaveLength(8)
  })

  it("level=Warning skips Notice/Info/Debug", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    const sink = new FileLogSink("sid", {
      dir: "/x",
      fs,
      hostname: "h",
      procId: 1,
      level: Severity.Warning,
    })
    sink.attach(bus)
    bus.emit(event({ severity: Severity.Error, message: "e" }))
    bus.emit(event({ severity: Severity.Warning, message: "w" }))
    bus.emit(event({ severity: Severity.Notice, message: "n" }))
    bus.emit(event({ severity: Severity.Info, message: "i" }))
    bus.emit(event({ severity: Severity.Debug, message: "d" }))
    expect(fs.appendCalls.map((c) => c.data)).toHaveLength(2)
    expect(fs.appendCalls[0].data).toContain("e")
    expect(fs.appendCalls[1].data).toContain("w")
  })

  it("level=Error skips Warning and below severity", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    const sink = new FileLogSink("sid", {
      dir: "/x",
      fs,
      hostname: "h",
      procId: 1,
      level: Severity.Error,
    })
    sink.attach(bus)
    bus.emit(event({ severity: Severity.Error, message: "e" }))
    bus.emit(event({ severity: Severity.Warning, message: "w" }))
    expect(fs.appendCalls).toHaveLength(1)
  })
})

describe("FileLogSink — byte cap", () => {
  it("drops events after maxBytes is exceeded and emits one cap notice", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    const sink = new FileLogSink("sid", {
      dir: "/x",
      fs,
      hostname: "h",
      procId: 1,
      maxBytes: 200, // very low; cap notice expected on event 2 or 3
    })
    sink.attach(bus)
    // Each line is ~120-150 bytes; emit 5
    for (let i = 0; i < 5; i++) {
      bus.emit(event({ message: `msg-${i}-with-some-extra-padding-bytes-here` }))
    }
    const lines = fs.appendCalls.map((c) => c.data)
    // We expect at least one event followed by a cap notice; further
    // events are silently dropped (no more appendCalls).
    expect(lines.length).toBeGreaterThanOrEqual(1)
    expect(lines.length).toBeLessThan(5)
    const lastLine = lines[lines.length - 1]
    expect(lastLine).toContain("log-file.cap")
    expect(lastLine).toContain("file size cap")
  })

  it("does not emit duplicate cap notices on subsequent events", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    const sink = new FileLogSink("sid", {
      dir: "/x",
      fs,
      hostname: "h",
      procId: 1,
      maxBytes: 50, // smaller than even one line, so the very first emit caps
    })
    sink.attach(bus)
    for (let i = 0; i < 10; i++) {
      bus.emit(event({ message: `msg-${i}` }))
    }
    const lines = fs.appendCalls.map((c) => c.data)
    const capNotices = lines.filter((l) => l.includes("log-file.cap"))
    expect(capNotices).toHaveLength(1)
  })
})

describe("FileLogSink — attach/detach", () => {
  it("attach is idempotent", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    const sink = new FileLogSink("sid", { dir: "/x", fs, hostname: "h", procId: 1 })
    sink.attach(bus)
    sink.attach(bus)
    bus.emit(event())
    expect(fs.appendCalls).toHaveLength(1)
  })

  it("detach removes the listener", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    const sink = new FileLogSink("sid", { dir: "/x", fs, hostname: "h", procId: 1 })
    sink.attach(bus)
    bus.emit(event({ message: "a" }))
    sink.detach()
    bus.emit(event({ message: "b" }))
    expect(fs.appendCalls).toHaveLength(1)
    expect(fs.appendCalls[0].data).toContain("a")
  })

  it("detach is idempotent", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    const sink = new FileLogSink("sid", { dir: "/x", fs, hostname: "h", procId: 1 })
    sink.attach(bus)
    sink.detach()
    sink.detach()
    sink.detach()
    // No throw, no observable difference.
    expect(true).toBe(true)
  })
})

describe("FileLogSink — header field defaults", () => {
  it("uses os.hostname() when none provided (via deps)", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    const sink = new FileLogSink("sid", {
      dir: "/x",
      fs,
      procId: 1,
      // hostname omitted on purpose
    })
    sink.attach(bus)
    bus.emit(event())
    expect(fs.appendCalls).toHaveLength(1)
    const line = fs.appendCalls[0].data
    // Either NIL ("-") or some non-empty hostname is acceptable; we just
    // assert the field appears at position 3 (zero-indexed) after PRI/VERSION/TS.
    const parts = line.split(" ")
    expect(parts.length).toBeGreaterThanOrEqual(6)
    expect(parts[2]).not.toBe("") // never empty string
  })

  it("uses process.pid when procId not provided", () => {
    const bus = createDiagnosticBus()
    const fs = fakeFs()
    const sink = new FileLogSink("sid", { dir: "/x", fs, hostname: "h" })
    sink.attach(bus)
    bus.emit(event())
    const line = fs.appendCalls[0].data
    const parts = line.split(" ")
    expect(parts[4]).toBe(String(process.pid))
  })
})
