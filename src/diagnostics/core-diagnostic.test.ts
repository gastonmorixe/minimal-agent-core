/**
 * S14.1: the typed CoreDiagnostic on LogEvent (R-API-15). Additive: `message` stays.
 */

import { describe, expect, it } from "bun:test"

import {
  type CoreDiagnosticLevel,
  createDiagnosticBus,
  diag,
  type LogEvent,
  levelOfSeverity,
  Severity,
} from "../bus/diagnostic-bus.ts"
import type { CoreErrorJson } from "../errors/types.ts"

import { createDiagnostics, createDiagnosticsHub } from "./hub.ts"

describe("LogEvent.diagnostic", () => {
  it("hub events carry source, level and attrs, and keep message", () => {
    const events: LogEvent[] = []
    const d = createDiagnostics({ emit: (e) => events.push(e) })
    d.warn("x.y", "text", { n: 1, ok: true, s: "v" })
    d.info("x.i", "i")
    d.debug("x.d", "d")
    d.critical("x.c", "c")
    expect(events[0]?.message).toBe("text")
    expect(events[0]?.diagnostic).toEqual({
      source: "x.y",
      level: "warn",
      attrs: { n: 1, ok: true, s: "v" },
    })
    expect(events.map((e) => e.diagnostic?.level)).toEqual(["warn", "info", "debug", "error"])
    expect(events[1]?.diagnostic?.attrs).toEqual({})
  })

  it("a producer error lands in diagnostic.error", () => {
    const events: LogEvent[] = []
    const d = createDiagnostics({ emit: (e) => events.push(e) })
    const err: CoreErrorJson = { kind: "Boom", fields: { code: 7 } }
    d.error("x.e", "failed", undefined, err)
    expect(events[0]?.diagnostic?.error).toEqual(err)
    expect(events[0]?.message).toBe("failed")
  })

  it("session scope and global diag helpers fill diagnostic too", () => {
    const bus = createDiagnosticBus()
    const hub = createDiagnosticsHub({ bus })
    const seen: LogEvent[] = []
    hub.on("*", (e) => seen.push(e))
    hub.session("s1").notice("a.b", "m", { k: "v" })
    expect(seen[0]?.sessionId).toBe("s1")
    expect(seen[0]?.diagnostic?.source).toBe("a.b")
    expect(seen[0]?.diagnostic?.level).toBe("info")
    const g: LogEvent[] = []
    const off = createDiagnosticsHub().on("*", (e) => g.push(e))
    diag.error("g.e", "gm")
    off()
    expect(g[0]?.diagnostic).toEqual({ source: "g.e", level: "error", attrs: {} })
    expect(g[0]?.severity).toBe(Severity.Error)
  })

  it("a raw emit without diagnostic gets one from the handle", () => {
    const events: LogEvent[] = []
    const d = createDiagnostics({ emit: (e) => events.push(e) })
    d.emit({ ts: 1, severity: Severity.Warning, facility: 1, source: "r.s", message: "m" })
    expect(events[0]?.diagnostic?.source).toBe("r.s")
  })
})

describe("levelOfSeverity", () => {
  const table: ReadonlyArray<readonly [string, Severity, CoreDiagnosticLevel]> = [
    ["Emergency", Severity.Emergency, "error"],
    ["Alert", Severity.Alert, "error"],
    ["Critical", Severity.Critical, "error"],
    ["Error", Severity.Error, "error"],
    ["Warning", Severity.Warning, "warn"],
    ["Notice", Severity.Notice, "info"],
    ["Info", Severity.Info, "info"],
    ["Debug", Severity.Debug, "debug"],
  ]
  it.each(table)("%s maps to its level", (_name, severity, level) => {
    expect(levelOfSeverity(severity)).toBe(level)
  })
})
