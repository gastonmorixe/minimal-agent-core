import { describe, expect, it } from "bun:test"

import { _resetSessionId, getSessionId, setSessionId } from "./session-id.ts"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAMPLE_UUID = "9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"
const OTHER_UUID = "00000000-0000-4000-8000-000000000000"

describe("session id", () => {
  /** Run `fn` with a cleared sid cache, restored afterward. */
  function fresh(fn: () => void): void {
    _resetSessionId()
    try {
      fn()
    } finally {
      _resetSessionId()
    }
  }

  it("mints a random UUID by default", () => {
    fresh(() => {
      const id = getSessionId()
      expect(id).toMatch(UUID_RE)
      // Stable for the process lifetime (cached).
      expect(getSessionId()).toBe(id)
    })
  })

  it("does NOT auto-adopt the ambient MINIMAL_AGENT_SESSION_ID env var", () => {
    // That var leaks into every spawned child (plugin subprocesses, bun
    // test, grandchildren). Adopting it would collide session files. The
    // only supported seed is the explicit --session-id flag (setSessionId).
    const prev = process.env.MINIMAL_AGENT_SESSION_ID
    process.env.MINIMAL_AGENT_SESSION_ID = SAMPLE_UUID
    try {
      fresh(() => {
        const id = getSessionId()
        expect(id).toMatch(UUID_RE)
        expect(id).not.toBe(SAMPLE_UUID)
      })
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_SESSION_ID
      else process.env.MINIMAL_AGENT_SESSION_ID = prev
    }
  })

  it("setSessionId pins the id before first resolution (--session-id flag)", () => {
    fresh(() => {
      setSessionId(SAMPLE_UUID)
      expect(getSessionId()).toBe(SAMPLE_UUID)
    })
  })

  it("setSessionId rejects a malformed id", () => {
    fresh(() => {
      expect(() => setSessionId("nope")).toThrow(/not a UUID/)
    })
  })

  it("setSessionId is idempotent on the same id but throws on a different one", () => {
    fresh(() => {
      setSessionId(SAMPLE_UUID)
      expect(() => setSessionId(SAMPLE_UUID)).not.toThrow()
      expect(() => setSessionId(OTHER_UUID)).toThrow(/already resolved/)
    })
  })
})
