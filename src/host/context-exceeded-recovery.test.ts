/**
 * Tests for context_length_exceeded auto-compact recovery.
 */
import { afterEach, describe, expect, it } from "bun:test"

import type { Message } from "../llm/messages.ts"

import { tryRecoverContextExceeded } from "./context-exceeded-recovery.ts"

const EXCEEDED =
  "Responses error: context_length_exceeded — Your input exceeds the context window of this model."

describe("tryRecoverContextExceeded", () => {
  const prev = process.env.MINIMAL_AGENT_AUTO_COMPACT
  afterEach(() => {
    if (prev === undefined) delete process.env.MINIMAL_AGENT_AUTO_COMPACT
    else process.env.MINIMAL_AGENT_AUTO_COMPACT = prev
  })

  it("is a no-op for non-context errors", async () => {
    const r = await tryRecoverContextExceeded(
      { compact: async () => ({ kind: "local", messagesBefore: 1, messagesAfter: 1 }) },
      "network socket closed",
    )
    expect(r.shouldRetry).toBe(false)
    expect(r.notices).toEqual([])
  })

  it("returns advice when auto-compact is disabled", async () => {
    process.env.MINIMAL_AGENT_AUTO_COMPACT = "0"
    let called = false
    const r = await tryRecoverContextExceeded(
      {
        getModel: () => "test-model-1",
        compact: async () => {
          called = true
          return { kind: "local", messagesBefore: 9, messagesAfter: 2 }
        },
      },
      EXCEEDED,
    )
    expect(called).toBe(false)
    expect(r.shouldRetry).toBe(false)
    expect(r.notices.some((n) => n.includes("Context window exceeded"))).toBe(true)
  })

  it("compacts and returns retry text for pending user turns", async () => {
    process.env.MINIMAL_AGENT_AUTO_COMPACT = "1"
    const history: Message[] = [
      { role: "assistant", content: "prior" },
      { role: "user", content: "please continue the refactor" },
    ]
    const r = await tryRecoverContextExceeded(
      {
        getModel: () => "test-model-1",
        history: () => history,
        compact: async () => ({ kind: "remote", messagesBefore: 40, messagesAfter: 3 }),
      },
      EXCEEDED,
    )
    expect(r.shouldRetry).toBe(true)
    expect(r.retryText).toBe("please continue the refactor")
    expect(r.notices[0]).toContain("Auto-compacted")
    expect(r.notices[0]).toContain("remote")
  })

  it("surfaces compact failures without retry", async () => {
    process.env.MINIMAL_AGENT_AUTO_COMPACT = "1"
    const r = await tryRecoverContextExceeded(
      {
        history: () => [{ role: "user", content: "x" }],
        compact: async () => {
          throw new Error("compact endpoint 500")
        },
      },
      EXCEEDED,
    )
    expect(r.shouldRetry).toBe(false)
    expect(r.notices[0]).toContain("Auto-compact failed")
  })
})
