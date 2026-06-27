/**
 * Tests for the AgentContext factory and env-var adapter.
 *
 * These pin the value-object contract (immutability + validation) and
 * the bijection between the typed shape and the `MINIMAL_AGENT_*` env
 * vars consumed by subprocess plugins. Breaking any of these means a
 * downstream plugin will silently drop a field.
 */

import { describe, expect, test } from "bun:test"

import {
  AGENT_ENV_KEYS,
  agentContextFromEnv,
  agentContextToEnv,
  createAgentContext,
  createAgentContextForTest,
} from "./agent-context.ts"

const SID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"

describe("createAgentContext", () => {
  test("returns a frozen object with the supplied fields", () => {
    const a = createAgentContext({
      sessionId: SID,
      pid: 12345,
      model: "test-model-1[1m]",
      version: "0.1.0",
    })
    expect(a.sessionId).toBe(SID)
    expect(a.pid).toBe(12345)
    expect(a.model).toBe("test-model-1[1m]")
    expect(a.version).toBe("0.1.0")
    expect(Object.isFrozen(a)).toBe(true)
  })

  test("trims sessionId whitespace", () => {
    const a = createAgentContext({
      sessionId: `   ${SID}   `,
      pid: 1,
      model: "",
      version: "",
    })
    expect(a.sessionId).toBe(SID)
  })

  test("mutation of a frozen field throws in strict mode", () => {
    const a = createAgentContext({ sessionId: SID, pid: 1, model: "m", version: "v" })
    // The TS readonly prevents this at compile time; the freeze enforces
    // it at runtime. We bypass TS with a cast to verify the freeze.
    expect(() => {
      ;(a as unknown as { sessionId: string }).sessionId = "x"
    }).toThrow()
  })

  test("rejects empty sessionId", () => {
    expect(() => createAgentContext({ sessionId: "", pid: 1, model: "", version: "" })).toThrow(
      /sessionId/,
    )
    expect(() => createAgentContext({ sessionId: "   ", pid: 1, model: "", version: "" })).toThrow(
      /sessionId/,
    )
  })

  test("rejects non-positive or non-integer pid", () => {
    expect(() => createAgentContext({ sessionId: SID, pid: 0, model: "", version: "" })).toThrow(
      /pid/,
    )
    expect(() => createAgentContext({ sessionId: SID, pid: -1, model: "", version: "" })).toThrow(
      /pid/,
    )
    expect(() => createAgentContext({ sessionId: SID, pid: 1.5, model: "", version: "" })).toThrow(
      /pid/,
    )
    expect(() =>
      createAgentContext({ sessionId: SID, pid: Number.NaN, model: "", version: "" }),
    ).toThrow(/pid/)
  })

  test("rejects non-string model / version", () => {
    expect(() =>
      createAgentContext({
        sessionId: SID,
        pid: 1,
        model: 42 as unknown as string,
        version: "",
      }),
    ).toThrow(/model/)
    expect(() =>
      createAgentContext({
        sessionId: SID,
        pid: 1,
        model: "",
        version: null as unknown as string,
      }),
    ).toThrow(/version/)
  })

  test("accepts empty strings for model and version (unknown at construction time)", () => {
    const a = createAgentContext({ sessionId: SID, pid: 1, model: "", version: "" })
    expect(a.model).toBe("")
    expect(a.version).toBe("")
  })
})

describe("createAgentContextForTest", () => {
  test("fills sensible defaults for pid/model/version", () => {
    const a = createAgentContextForTest({ sessionId: SID })
    expect(a.sessionId).toBe(SID)
    expect(a.pid).toBe(process.pid)
    expect(a.model).toBe("")
    expect(a.version).toBe("0.0.0")
    expect(Object.isFrozen(a)).toBe(true)
  })

  test("allows overriding any default", () => {
    const a = createAgentContextForTest({
      sessionId: SID,
      pid: 999,
      model: "m",
      version: "9.9.9",
    })
    expect(a.pid).toBe(999)
    expect(a.model).toBe("m")
    expect(a.version).toBe("9.9.9")
  })
})

describe("agentContextToEnv", () => {
  test("emits the four MINIMAL_AGENT_* keys", () => {
    const a = createAgentContext({
      sessionId: SID,
      pid: 12345,
      model: "m",
      version: "0.1.0",
    })
    expect(agentContextToEnv(a)).toEqual({
      MINIMAL_AGENT_SESSION_ID: SID,
      MINIMAL_AGENT_PID: "12345",
      MINIMAL_AGENT_MODEL: "m",
      MINIMAL_AGENT_VERSION: "0.1.0",
    })
  })

  test("uses AGENT_ENV_KEYS as the single source of truth for key names", () => {
    const a = createAgentContextForTest({ sessionId: SID })
    const env = agentContextToEnv(a)
    expect(Object.keys(env).sort()).toEqual(
      [
        AGENT_ENV_KEYS.sessionId,
        AGENT_ENV_KEYS.pid,
        AGENT_ENV_KEYS.model,
        AGENT_ENV_KEYS.version,
      ].sort(),
    )
  })
})

describe("agentContextFromEnv", () => {
  test("returns null when sessionId is absent", () => {
    expect(agentContextFromEnv({})).toBeNull()
    expect(agentContextFromEnv({ MINIMAL_AGENT_SESSION_ID: "" })).toBeNull()
    expect(agentContextFromEnv({ MINIMAL_AGENT_SESSION_ID: "   " })).toBeNull()
  })

  test("rehydrates a typed AgentContext from env", () => {
    const a = agentContextFromEnv({
      MINIMAL_AGENT_SESSION_ID: SID,
      MINIMAL_AGENT_PID: "12345",
      MINIMAL_AGENT_MODEL: "m",
      MINIMAL_AGENT_VERSION: "0.1.0",
    })
    expect(a).not.toBeNull()
    expect(a?.sessionId).toBe(SID)
    expect(a?.pid).toBe(12345)
    expect(a?.model).toBe("m")
    expect(a?.version).toBe("0.1.0")
    expect(Object.isFrozen(a)).toBe(true)
  })

  test("defaults pid to 0 for garbage input", () => {
    const a = agentContextFromEnv({ MINIMAL_AGENT_SESSION_ID: SID, MINIMAL_AGENT_PID: "abc" })
    expect(a?.pid).toBe(0)
  })

  test("defaults pid to 0 when absent", () => {
    const a = agentContextFromEnv({ MINIMAL_AGENT_SESSION_ID: SID })
    expect(a?.pid).toBe(0)
  })

  test("rejects non-positive pid (defaults to 0)", () => {
    const negative = agentContextFromEnv({ MINIMAL_AGENT_SESSION_ID: SID, MINIMAL_AGENT_PID: "-7" })
    expect(negative?.pid).toBe(0)
    const zero = agentContextFromEnv({ MINIMAL_AGENT_SESSION_ID: SID, MINIMAL_AGENT_PID: "0" })
    expect(zero?.pid).toBe(0)
  })

  test("model and version default to empty strings", () => {
    const a = agentContextFromEnv({ MINIMAL_AGENT_SESSION_ID: SID })
    expect(a?.model).toBe("")
    expect(a?.version).toBe("")
  })

  test("trims sessionId on read", () => {
    const a = agentContextFromEnv({ MINIMAL_AGENT_SESSION_ID: `  ${SID}  ` })
    expect(a?.sessionId).toBe(SID)
  })
})

describe("env adapter round-trip", () => {
  test("fromEnv(toEnv(a)) returns a structurally equal value object", () => {
    const a = createAgentContext({
      sessionId: SID,
      pid: 7777,
      model: "test-model-1[1m]",
      version: "0.1.0",
    })
    const round = agentContextFromEnv(agentContextToEnv(a))
    expect(round).not.toBeNull()
    expect(round?.sessionId).toBe(a.sessionId)
    expect(round?.pid).toBe(a.pid)
    expect(round?.model).toBe(a.model)
    expect(round?.version).toBe(a.version)
  })

  test("round-trip preserves frozen-ness", () => {
    const a = createAgentContextForTest({ sessionId: SID, pid: 42 })
    const round = agentContextFromEnv(agentContextToEnv(a))
    expect(Object.isFrozen(round)).toBe(true)
  })
})
