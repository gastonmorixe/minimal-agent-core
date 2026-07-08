import { describe, expect, test } from "bun:test"

import { buildInstructionsBlockText } from "./instructions-block.ts"
import { resolveSystemPromptForModel } from "./system-prompt.ts"
import type { SystemPromptOverrides } from "./system-prompt-overrides.ts"

// Register a fake model so resolveSystemPromptForModel doesn't throw.
// We use a model id that has no registered provider, which triggers the
// neutral fallback path — exactly what we want for testing core overrides.
const NEUTRAL_MODEL = "test-neutral-model"

function resolve(opts?: {
  overrides?: SystemPromptOverrides
  sessionContext?: string
  identity?: string
}): ReturnType<typeof resolveSystemPromptForModel> {
  return resolveSystemPromptForModel(NEUTRAL_MODEL, {
    sessionContext: opts?.sessionContext,
    identity: opts?.identity,
    overrides: opts?.overrides,
    authKind: "api-key",
  })
}

function instructions(opts?: { overrides?: SystemPromptOverrides }): string {
  return buildInstructionsBlockText({ overrides: opts?.overrides })
}

// ---------------------------------------------------------------------------
// Default byte-identity
// ---------------------------------------------------------------------------

describe("default byte-identity", () => {
  test("no overrides produces the same output as today", () => {
    const a = resolve()
    const b = resolve()
    expect(a).toEqual(b)
    // At least identity + instructions blocks
    expect(a.length).toBeGreaterThanOrEqual(2)
  })

  test("empty overrides struct produces the same output as undefined", () => {
    const a = resolve()
    const b = resolve({ overrides: {} })
    expect(a).toEqual(b)
  })

  test("instructions block is non-empty by default", () => {
    const text = instructions()
    expect(text.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Identity override
// ---------------------------------------------------------------------------

describe("identity override", () => {
  test("replace identity", () => {
    const result = resolve({
      overrides: { identity: { kind: "replace", text: "You are TestBot." } },
    })
    expect(result[0].text).toBe("You are TestBot.")
  })

  test("omit identity falls back to neutral default", () => {
    // Omitting identity means the neutral default is used (providers may still replace it)
    const result = resolve({
      overrides: { identity: { kind: "omit" } },
    })
    // The neutral identity is still present because omit means "use default"
    expect(result[0].text).toContain("Minimal Agent")
  })
})

// ---------------------------------------------------------------------------
// Instructions override
// ---------------------------------------------------------------------------

describe("instructions override", () => {
  test("replace instructions", () => {
    const text = instructions({
      overrides: { instructions: { kind: "replace", text: "Be helpful." } },
    })
    expect(text).toContain("Be helpful.")
    expect(text).not.toContain("You are Minimal Agent")
  })

  test("omit instructions", () => {
    const text = instructions({
      overrides: { instructions: { kind: "omit" } },
    })
    // When instructions are omitted, only loop-safety + tool-output-conventions remain
    // (tool-output-conventions is empty when blobStoreEnabled is false)
    expect(text).not.toContain("You are Minimal Agent")
  })
})

// ---------------------------------------------------------------------------
// Loop safety override
// ---------------------------------------------------------------------------

describe("loop safety override", () => {
  test("replace loop safety", () => {
    const text = instructions({
      overrides: { loopSafety: { kind: "replace", text: "No loops here." } },
    })
    expect(text).toContain("No loops here.")
    expect(text).not.toContain("reflection checkpoint")
  })

  test("omit loop safety", () => {
    const text = instructions({
      overrides: { loopSafety: { kind: "omit" } },
    })
    expect(text).not.toContain("reflection checkpoint")
    expect(text).not.toContain("cooldown")
  })
})

// ---------------------------------------------------------------------------
// Tool output conventions override
// ---------------------------------------------------------------------------

describe("tool output conventions override", () => {
  test("replace tool output conventions", () => {
    const text = instructions({
      overrides: {
        toolOutputConventions: { kind: "replace", text: "Custom conventions." },
      },
    })
    expect(text).toContain("Custom conventions.")
  })

  test("omit tool output conventions", () => {
    const text = instructions({
      overrides: { toolOutputConventions: { kind: "omit" } },
    })
    // With blobStoreEnabled=false, conventions are already empty by default,
    // so omit should still produce empty (no regression)
    expect(text).not.toContain("raw-output")
  })
})

// ---------------------------------------------------------------------------
// Session context override
// ---------------------------------------------------------------------------

describe("session context override", () => {
  test("replace session context", () => {
    const result = resolve({
      sessionContext: "original context",
      overrides: { sessionContext: { kind: "replace", text: "custom context" } },
    })
    const texts = result.map((b) => b.text)
    expect(texts).toContain("custom context")
    expect(texts).not.toContain("original context")
  })

  test("omit session context", () => {
    const result = resolve({
      sessionContext: "original context",
      overrides: { sessionContext: { kind: "omit" } },
    })
    const texts = result.map((b) => b.text)
    expect(texts).not.toContain("original context")
  })

  test("no session context with no override stays absent", () => {
    const result = resolve({ overrides: {} })
    // Only identity + instructions blocks
    expect(result.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Full override
// ---------------------------------------------------------------------------

describe("full override", () => {
  test("replace full prompt", () => {
    const result = resolve({
      sessionContext: "should not appear",
      overrides: { full: { kind: "replace", text: "Complete replacement." } },
    })
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe("Complete replacement.")
  })

  test("omit full prompt", () => {
    const result = resolve({
      sessionContext: "should not appear",
      overrides: { full: { kind: "omit" } },
    })
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Multiple overrides together
// ---------------------------------------------------------------------------

describe("multiple overrides", () => {
  test("replace identity and instructions together", () => {
    const result = resolve({
      overrides: {
        identity: { kind: "replace", text: "Bot." },
        instructions: { kind: "replace", text: "Do stuff." },
      },
    })
    expect(result[0].text).toBe("Bot.")
    expect(result[1].text).toContain("Do stuff.")
  })

  test("omit instructions and loop safety together", () => {
    const text = instructions({
      overrides: {
        instructions: { kind: "omit" },
        loopSafety: { kind: "omit" },
      },
    })
    // Only tool-output-conventions remains (empty when blobStoreEnabled=false)
    expect(text).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Provider preamble threading
// ---------------------------------------------------------------------------

describe("provider preamble threading", () => {
  test("providerPreamble override is threaded to SystemPromptContext", () => {
    // This test verifies the override is accepted without error.
    // The actual provider-side application is tested in the provider plugin's suite.
    const result = resolve({
      overrides: {
        providerPreamble: { kind: "replace", text: "Custom preamble." },
      },
    })
    // The neutral fallback ignores providerPreamble, so output is unchanged
    expect(result.length).toBeGreaterThanOrEqual(2)
  })
})
