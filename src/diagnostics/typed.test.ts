import { describe, expect, test } from "bun:test"

import { createDiagnosticBus, type LogEvent, Severity } from "../bus/diagnostic-bus.ts"
import { loadUserConfig } from "../config/config.ts"
import { _resetLoggerErrorReportedForTest, warnLoggerErrorOnce } from "../logging/net-dbg.ts"

import { createDiagnosticsHub } from "./hub.ts"
import { emitTyped } from "./typed.ts"

describe("A1 typed diagnostics: old message and attrs", () => {
  test("net-dbg.logger-failure", () => {
    _resetLoggerErrorReportedForTest()
    const bus = createDiagnosticBus()
    const seen: LogEvent[] = []
    bus.on("*", (e) => seen.push(e))
    warnLoggerErrorOnce(new Error("disk full"), createDiagnosticsHub({ bus }).diagnostics)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.source).toBe("net-dbg.logger-failure")
    expect(seen[0]?.severity).toBe(Severity.Warning)
    expect(seen[0]?.message).toBe("logger failure (further errors suppressed): disk full")
    expect(seen[0]?.diagnostic?.attrs).toEqual({ detail: "disk full" })
  })

  test("config.parse-error", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const dir = mkdtempSync(join(tmpdir(), "a1-cfg-"))
    const path = join(dir, "config.jsonc")
    writeFileSync(path, "{ not json")
    const prev = process.env.MINIMAL_AGENT_CONFIG
    process.env.MINIMAL_AGENT_CONFIG = path
    try {
      const bus = createDiagnosticBus()
      const seen: LogEvent[] = []
      bus.on("*", (e) => seen.push(e))
      loadUserConfig(createDiagnosticsHub({ bus }).diagnostics)
      const e = seen.find((x) => x.source === "config.parse-error")
      let expected = ""
      try {
        JSON.parse("{ not json")
      } catch (err) {
        expected = (err as Error).message
      }
      expect(expected).not.toBe("")
      const detail = e?.diagnostic?.attrs.detail
      expect(typeof detail).toBe("string")
      expect((detail as string).length).toBeGreaterThan(0)
      expect(detail).toBe(expected)
      expect(e?.message).toBe(`${path}: ${detail as string}`)
      expect(e?.severity).toBe(Severity.Debug)
      expect(Object.keys(e?.diagnostic?.attrs ?? {}).sort()).toEqual(["detail", "path"])
      expect(e?.diagnostic?.attrs.path).toBe(path)
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_CONFIG
      else process.env.MINIMAL_AGENT_CONFIG = prev
    }
  })
})

describe("emitTyped clock", () => {
  test("stamps ts from the hub clock (runtime and session handles)", () => {
    const bus = createDiagnosticBus()
    const seen: LogEvent[] = []
    bus.on("*", (e) => seen.push(e))
    const hub = createDiagnosticsHub({ bus, now: () => 424242 })
    emitTyped(hub.diagnostics, Severity.Info, "x.runtime", "m", { a: 1 })
    emitTyped(hub.session("s1"), Severity.Info, "x.session", "m", { a: 1 })
    expect(seen.map((e) => e.ts)).toEqual([424242, 424242])
  })
})
