/**
 * Smoke test: the logging cluster of `./host/*` subpaths resolves and works
 * through the package name.
 *
 * @module host-public/logging.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { createDiagnosticBus } from "@minimal-agent/core/host/diagnostics"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { FileLogSink } from "@minimal-agent/core/host/log-file"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { GlobalLogSink } from "@minimal-agent/core/host/log-global"

describe("./host/* logging cluster (public subpaths)", () => {
  it("./host/log-file and ./host/diagnostics: a FileLogSink attaches to a fresh bus", () => {
    const calls: string[] = []
    const sink = new FileLogSink("smoke-test-sid", {
      fs: {
        mkdirSync: () => {},
        appendFileSync: (path) => calls.push(path),
      },
    })
    const bus = createDiagnosticBus()
    sink.attach(bus)
    bus.emit({ ts: Date.now(), severity: 4, facility: 1, source: "smoke.test", message: "hi" })
    expect(calls.length).toBe(1)
    sink.detach()
  })

  it("./host/log-global: a GlobalLogSink attaches to a fresh bus", () => {
    const calls: string[] = []
    const sink = new GlobalLogSink({
      fs: {
        mkdirSync: () => {},
        appendFileSync: (path) => calls.push(path),
        renameSync: () => {},
        statSync: () => ({ size: 0 }),
      },
    })
    const bus = createDiagnosticBus()
    sink.attach(bus)
    bus.emit({ ts: Date.now(), severity: 4, facility: 1, source: "smoke.test", message: "hi" })
    expect(calls.length).toBe(1)
    sink.detach()
  })
})
