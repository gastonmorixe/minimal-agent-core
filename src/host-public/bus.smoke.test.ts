/**
 * Smoke test: the `./host/global-bus` subpath resolves and works through
 * the package name.
 *
 * @module host-public/bus.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { getGlobalEventBus, setGlobalEventBus } from "@minimal-agent/core/host/global-bus"

describe("./host/global-bus (public subpath)", () => {
  it("defaults to null and clears idempotently (the EventBus instance itself is host-kit's)", () => {
    expect(getGlobalEventBus()).toBeNull()
    setGlobalEventBus(null)
    expect(getGlobalEventBus()).toBeNull()
  })
})
