import { describe, expect, test } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"

import { denyDecision, NOOP_LIFECYCLE } from "./lifecycle.ts"
import { compactWithLifecycle } from "./lifecycle-compact.ts"

describe("compactWithLifecycle compact.willRun payload", () => {
  test("carries sid when the caller supplies it", async () => {
    const seen: unknown[] = []
    const run = compactWithLifecycle({
      messages: [],
      model: "m",
      auth: {} as AuthResult,
      sid: "sid-1",
      lifecycle: {
        ...NOOP_LIFECYCLE,
        async beforeCompact(p) {
          seen.push(p)
          return denyDecision("stop here")
        },
      },
    })
    await expect(run).rejects.toThrow("stop here")
    expect(seen).toEqual([expect.objectContaining({ sid: "sid-1", messagesBefore: 0 })])
  })

  test("leaves sid out when the caller does not supply it", async () => {
    const seen: Record<string, unknown>[] = []
    const run = compactWithLifecycle({
      messages: [],
      model: "m",
      auth: {} as AuthResult,
      lifecycle: {
        ...NOOP_LIFECYCLE,
        async beforeCompact(p) {
          seen.push(p as unknown as Record<string, unknown>)
          return denyDecision("stop here")
        },
      },
    })
    await expect(run).rejects.toThrow("stop here")
    expect("sid" in (seen[0] ?? {})).toBe(false)
    expect("agentMode" in (seen[0] ?? {})).toBe(false)
  })

  test("carries agentMode apart from the compact engine mode", async () => {
    const seen: Record<string, unknown>[] = []
    const run = compactWithLifecycle({
      messages: [],
      model: "m",
      auth: {} as AuthResult,
      mode: "local",
      agentMode: "ask",
      lifecycle: {
        ...NOOP_LIFECYCLE,
        async beforeCompact(p) {
          seen.push(p as unknown as Record<string, unknown>)
          return denyDecision("stop here")
        },
      },
    })
    await expect(run).rejects.toThrow("stop here")
    expect(seen[0]?.agentMode).toBe("ask")
    expect(seen[0]?.mode).toBe("local")
  })
})
