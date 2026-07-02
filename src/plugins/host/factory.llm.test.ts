/**
 * `llm:complete` capability (Wave G).
 *
 * Verifies the host factory grants `ctx.host.llm` ONLY when declared. The
 * completion path itself (getAuth + canonicalSendFn + drain) is exercised
 * end-to-end by the memory plugin's own summarize tests against injected
 * doubles; here we pin the grant-gating + the method shape, which is the
 * seam's contract.
 */

import { describe, expect, it } from "bun:test"

import { buildPluginHost } from "./factory.ts"

describe("plugin host: llm:complete capability", () => {
  it("is undefined when not granted (deny-by-default)", () => {
    const host = buildPluginHost({ capabilities: [] })
    expect(host.llm).toBeUndefined()
  })

  it("llm:complete populates host.llm with a complete() method", () => {
    const host = buildPluginHost({ capabilities: ["llm:complete"] })
    expect(host.llm).toBeDefined()
    expect(typeof host.llm?.complete).toBe("function")
  })

  it("is independent of the other capability grants", () => {
    const host = buildPluginHost({ capabilities: ["models:read", "session-info:read"] })
    // llm not requested → absent even though sibling capabilities are present.
    expect(host.llm).toBeUndefined()
    expect(host.models).toBeDefined()
    expect(host.sessionInfo).toBeDefined()
  })
})
