/**
 * Smoke test: the `./host/status-bus` subpath resolves and works through
 * the package name.
 *
 * @module host-public/status-bus.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { GLOBAL_STATUS_BUS, StatusBus } from "@minimal-agent/core/host/status-bus"

describe("./host/status-bus (public subpath)", () => {
  it("resolves StatusBus and GLOBAL_STATUS_BUS, and reports current status through a handle", () => {
    const bus = new StatusBus()
    expect(bus.current()).toBeNull()

    const handle = bus.create("working")
    expect(bus.current()).toBe("working")

    handle.update("done")
    expect(bus.current()).toBe("done")

    handle.clear()
    expect(bus.current()).toBeNull()
  })

  it("exposes the real GLOBAL_STATUS_BUS singleton", () => {
    expect(GLOBAL_STATUS_BUS).toBeInstanceOf(StatusBus)
  })
})
