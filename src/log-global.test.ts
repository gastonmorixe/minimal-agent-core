import { describe, expect, it } from "bun:test"

import { createDiagnosticBus, Facility, type LogEvent, Severity } from "./diagnostic-bus.ts"
import { GlobalLogSink, type GlobalLogSinkFs } from "./log-global.ts"

function memFs(): { fs: GlobalLogSinkFs; files: Map<string, string>; renames: string[] } {
  const files = new Map<string, string>()
  const renames: string[] = []
  const fs: GlobalLogSinkFs = {
    mkdirSync: () => {},
    appendFileSync: (path, data) => {
      files.set(path, (files.get(path) ?? "") + data)
    },
    renameSync: (from, to) => {
      renames.push(`${from}->${to}`)
      const v = files.get(from)
      if (v !== undefined) {
        files.set(to, v)
        files.delete(from)
      }
    },
    statSync: (path) => ({ size: Buffer.byteLength(files.get(path) ?? "") }),
  }
  return { fs, files, renames }
}

function ev(
  partial: Partial<LogEvent> & Pick<LogEvent, "severity" | "source" | "message">,
): LogEvent {
  return { ts: Date.UTC(2026, 0, 1), facility: Facility.User, ...partial }
}

describe("GlobalLogSink", () => {
  it("appends RFC 5424 lines at Notice+ and stamps the session id", () => {
    const { fs, files } = memFs()
    const bus = createDiagnosticBus()
    const sink = new GlobalLogSink({
      path: "/x/ma.log",
      sessionId: "sid-123",
      fs,
      hostname: "host",
      procId: 42,
    })
    sink.attach(bus)

    bus.emit(ev({ severity: Severity.Info, source: "x.info", message: "skipped" }))
    bus.emit(
      ev({
        severity: Severity.Notice,
        source: "binaries.installed",
        message: "installed obscura 0.1.6",
      }),
    )

    const out = files.get("/x/ma.log") ?? ""
    expect(out).not.toContain("skipped") // Info below default Notice level
    expect(out).toContain("installed obscura 0.1.6")
    expect(out).toContain('sid="sid-123"')
    expect(out).toMatch(/^<\d+>1 /) // RFC 5424 PRI + version
  })

  it("honors a custom level", () => {
    const { fs, files } = memFs()
    const bus = createDiagnosticBus()
    const sink = new GlobalLogSink({ path: "/x/ma.log", fs, level: Severity.Warning })
    sink.attach(bus)
    bus.emit(ev({ severity: Severity.Notice, source: "x", message: "notice-line" }))
    bus.emit(ev({ severity: Severity.Error, source: "x", message: "error-line" }))
    const out = files.get("/x/ma.log") ?? ""
    expect(out).not.toContain("notice-line")
    expect(out).toContain("error-line")
  })

  it("rotates to .1 when the cap is exceeded", () => {
    const { fs, files, renames } = memFs()
    const bus = createDiagnosticBus()
    const sink = new GlobalLogSink({ path: "/x/ma.log", fs, maxBytes: 200 })
    sink.attach(bus)
    // Each line is well over 60 bytes; a few emits crosses 200.
    for (let i = 0; i < 10; i++) {
      bus.emit(
        ev({
          severity: Severity.Notice,
          source: "binaries.x",
          message: `line-${i}-padding-padding`,
        }),
      )
    }
    expect(renames.some((r) => r === "/x/ma.log->/x/ma.log.1")).toBe(true)
    // Current file holds only the post-rotation tail.
    expect((files.get("/x/ma.log") ?? "").length).toBeLessThanOrEqual(200)
  })

  it("never throws when the fs errors", () => {
    const throwingFs: GlobalLogSinkFs = {
      mkdirSync: () => {
        throw new Error("EACCES")
      },
      appendFileSync: () => {
        throw new Error("ENOSPC")
      },
      renameSync: () => {},
      statSync: () => {
        throw new Error("ENOENT")
      },
    }
    const bus = createDiagnosticBus()
    const sink = new GlobalLogSink({ path: "/x/ma.log", fs: throwingFs })
    sink.attach(bus)
    expect(() =>
      bus.emit(ev({ severity: Severity.Error, source: "x", message: "boom" })),
    ).not.toThrow()
  })

  it("detach stops receiving events", () => {
    const { fs, files } = memFs()
    const bus = createDiagnosticBus()
    const sink = new GlobalLogSink({ path: "/x/ma.log", fs })
    sink.attach(bus)
    sink.detach()
    bus.emit(ev({ severity: Severity.Error, source: "x", message: "after-detach" }))
    expect(files.get("/x/ma.log")).toBeUndefined()
  })
})
