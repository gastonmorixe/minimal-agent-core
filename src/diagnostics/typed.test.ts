import { describe, expect, test } from "bun:test"

import { createDiagnosticBus, type LogEvent, Severity } from "../bus/diagnostic-bus.ts"
import { loadUserConfig } from "../config/config.ts"
import { _resetLoggerErrorReportedForTest, warnLoggerErrorOnce } from "../logging/net-dbg.ts"

import { createDiagnosticsHub } from "./hub.ts"

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
      expect(e?.message).toBe(`${path}: ${String(e?.diagnostic?.attrs.detail)}`)
      expect(e?.severity).toBe(Severity.Debug)
      expect(Object.keys(e?.diagnostic?.attrs ?? {}).sort()).toEqual(["detail", "path"])
      expect(e?.diagnostic?.attrs.path).toBe(path)
      expect(typeof e?.diagnostic?.attrs.detail).toBe("string")
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_CONFIG
      else process.env.MINIMAL_AGENT_CONFIG = prev
    }
  })
})
