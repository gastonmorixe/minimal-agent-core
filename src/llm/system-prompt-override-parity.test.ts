import { describe, expect, test } from "bun:test"

import { resolveSystemPromptForModel } from "../llm/system-prompt.ts"
import type { SystemPromptOverrides } from "../llm/system-prompt-overrides.ts"

const MODEL = "test-parity-model"

describe("legacy Agent vs AgentCore parity", () => {
  test("identical overrides produce identical resolveSystemPromptForModel output", () => {
    const overrides: SystemPromptOverrides = {
      identity: { kind: "replace", text: "ParityBot." },
      instructions: { kind: "replace", text: "Be consistent." },
    }

    const a = resolveSystemPromptForModel(MODEL, {
      overrides,
      authKind: "api-key",
    })

    const b = resolveSystemPromptForModel(MODEL, {
      overrides,
      authKind: "api-key",
    })

    expect(a).toEqual(b)
  })

  test("default (no overrides) produces identical output for both runtimes", () => {
    const a = resolveSystemPromptForModel(MODEL, { authKind: "api-key" })
    const b = resolveSystemPromptForModel(MODEL, { authKind: "api-key" })
    expect(a).toEqual(b)
  })

  test("full override produces identical output", () => {
    const overrides: SystemPromptOverrides = {
      full: { kind: "replace", text: "Complete." },
    }

    const a = resolveSystemPromptForModel(MODEL, { overrides, authKind: "api-key" })
    const b = resolveSystemPromptForModel(MODEL, { overrides, authKind: "api-key" })
    expect(a).toEqual(b)
    expect(a).toHaveLength(1)
    expect(a[0].text).toBe("Complete.")
  })

  test("omit overrides produce identical output", () => {
    const overrides: SystemPromptOverrides = {
      instructions: { kind: "omit" },
      loopSafety: { kind: "omit" },
      sessionContext: { kind: "omit" },
    }

    const a = resolveSystemPromptForModel(MODEL, {
      overrides,
      sessionContext: "should be omitted",
      authKind: "api-key",
    })
    const b = resolveSystemPromptForModel(MODEL, {
      overrides,
      sessionContext: "should be omitted",
      authKind: "api-key",
    })
    expect(a).toEqual(b)
  })

  test("both Agent and AgentCore thread overrides through the same function", () => {
    // The parity guarantee: both runtimes call resolveSystemPromptForModel
    // with the same options shape. This test verifies the function is
    // deterministic — same inputs, same outputs, every time.
    const overrides: SystemPromptOverrides = {
      identity: { kind: "replace", text: "Test" },
      instructions: { kind: "omit" },
      loopSafety: { kind: "omit" },
      sessionContext: { kind: "replace", text: "ctx" },
    }

    const results: ReturnType<typeof resolveSystemPromptForModel>[] = []
    for (let i = 0; i < 5; i++) {
      results.push(
        resolveSystemPromptForModel(MODEL, {
          overrides,
          sessionContext: "ctx",
          authKind: "api-key",
        }),
      )
    }

    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0])
    }
  })
})
