/**
 * Tests for the DiagnosticsRunner (Facade + Dependency Injection). The runner
 * orchestrates a set of injected {@link DiagnosticProvider}s concurrently,
 * bounds each by a timeout, and degrades (never throws) on failure. We inject
 * FAKE providers so the runner is tested with zero spawning.
 */
import { describe, expect, it } from "bun:test"

import type { DiagnosticProvider } from "./provider.ts"
import { DiagnosticsRunner } from "./runner.ts"
import type { Finding } from "./types.ts"

function fakeProvider(
  id: string,
  kind: "type" | "lint" | "format",
  result: Finding[] | Error | "hang",
  handles = (_p: string) => true,
): DiagnosticProvider {
  return {
    id,
    kind,
    handles,
    async check(_path, _text, signal) {
      if (result === "hang") {
        // never resolves unless aborted
        return new Promise<Finding[]>((_res, rej) => {
          signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
        })
      }
      if (result instanceof Error) throw result
      return result
    },
    dispose() {},
  }
}

const f = (over: Partial<Finding>): Finding => ({
  source: "x",
  severity: "error",
  message: "m",
  ...over,
})

describe("DiagnosticsRunner", () => {
  it("merges findings from all providers that handle the path", async () => {
    const runner = new DiagnosticsRunner([
      fakeProvider("tsgo", "type", [f({ source: "tsgo", code: "TS1" })]),
      fakeProvider("biome", "format", [f({ source: "biome", code: "B1", severity: "warning" })]),
    ])
    const report = await runner.check("/x.ts", "code")
    expect(report.findings).toHaveLength(2)
    expect(report.findings.map((d) => d.source).sort()).toEqual(["biome", "tsgo"])
    expect(report.degraded).toEqual([])
  })

  it("skips providers whose handles() returns false", async () => {
    const runner = new DiagnosticsRunner([
      fakeProvider("tsgo", "type", [f({ source: "tsgo" })], (p) => p.endsWith(".ts")),
      fakeProvider("py", "lint", [f({ source: "py" })], (p) => p.endsWith(".py")),
    ])
    const report = await runner.check("/x.ts", "code")
    expect(report.findings.map((d) => d.source)).toEqual(["tsgo"])
  })

  it("degrades (does not throw) when a provider throws", async () => {
    const runner = new DiagnosticsRunner([
      fakeProvider("good", "type", [f({ source: "good" })]),
      fakeProvider("bad", "lint", new Error("boom")),
    ])
    const report = await runner.check("/x.ts", "code")
    expect(report.findings.map((d) => d.source)).toEqual(["good"])
    expect(report.degraded).toContain("bad")
  })

  it("times out a hanging provider and degrades it", async () => {
    const runner = new DiagnosticsRunner(
      [fakeProvider("fast", "type", [f({ source: "fast" })]), fakeProvider("slow", "lint", "hang")],
      { timeoutMs: 50 },
    )
    const report = await runner.check("/x.ts", "code")
    expect(report.findings.map((d) => d.source)).toEqual(["fast"])
    expect(report.degraded).toContain("slow")
  })

  it("records per-provider timings", async () => {
    const runner = new DiagnosticsRunner([fakeProvider("tsgo", "type", [f({ source: "tsgo" })])])
    const report = await runner.check("/x.ts", "code")
    expect(typeof report.timings.tsgo).toBe("number")
  })

  it("returns an empty report when no providers handle the path", async () => {
    const runner = new DiagnosticsRunner([
      fakeProvider("py", "lint", [f({})], (p) => p.endsWith(".py")),
    ])
    const report = await runner.check("/x.ts", "code")
    expect(report.findings).toEqual([])
    expect(report.degraded).toEqual([])
  })

  it("dispose() disposes every provider once", () => {
    let disposed = 0
    const p: DiagnosticProvider = {
      id: "z",
      kind: "type",
      handles: () => true,
      async check() {
        return []
      },
      dispose() {
        disposed++
      },
    }
    const runner = new DiagnosticsRunner([p, p])
    runner.dispose()
    expect(disposed).toBe(2)
  })
})
