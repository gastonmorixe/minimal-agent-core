import { describe, expect, test } from "bun:test"

import { resolveSystemPromptForModel } from "../../llm/system-prompt.ts"
import type { SystemPromptOverrides } from "../../llm/system-prompt-overrides.ts"
import { shortHash } from "../../session/session-store.ts"

function hashForOverrides(overrides?: SystemPromptOverrides): string {
  const blocks = resolveSystemPromptForModel("does-not-exist", {
    sessionContext: "test-session-context",
    overrides,
  })
  return shortHash(JSON.stringify(blocks))
}

describe("startup hash drift with system-prompt overrides", () => {
  test("default (no overrides) produces a stable hash", () => {
    const h1 = hashForOverrides()
    const h2 = hashForOverrides()
    expect(h1).toBe(h2)
  })

  test("empty overrides object produces same hash as no overrides", () => {
    const h1 = hashForOverrides()
    const h2 = hashForOverrides({})
    expect(h1).toBe(h2)
  })

  test("identity replace changes the hash", () => {
    const h1 = hashForOverrides()
    const h2 = hashForOverrides({ identity: { kind: "replace", text: "Custom identity" } })
    expect(h1).not.toBe(h2)
  })

  test("identity omit does not change the hash (falls back to NEUTRAL_IDENTITY)", () => {
    const h1 = hashForOverrides()
    const h2 = hashForOverrides({ identity: { kind: "omit" } })
    // omit on identity falls back to NEUTRAL_IDENTITY, same as default
    expect(h1).toBe(h2)
  })

  test("instructions replace changes the hash", () => {
    const h1 = hashForOverrides()
    const h2 = hashForOverrides({ instructions: { kind: "replace", text: "Custom instructions" } })
    expect(h1).not.toBe(h2)
  })

  test("instructions omit changes the hash", () => {
    const h1 = hashForOverrides()
    const h2 = hashForOverrides({ instructions: { kind: "omit" } })
    expect(h1).not.toBe(h2)
  })

  test("sessionContext replace changes the hash", () => {
    const h1 = hashForOverrides()
    const h2 = hashForOverrides({ sessionContext: { kind: "replace", text: "Custom context" } })
    expect(h1).not.toBe(h2)
  })

  test("sessionContext omit changes the hash", () => {
    const h1 = hashForOverrides()
    const h2 = hashForOverrides({ sessionContext: { kind: "omit" } })
    expect(h1).not.toBe(h2)
  })

  test("full replace changes the hash", () => {
    const h1 = hashForOverrides()
    const h2 = hashForOverrides({ full: { kind: "replace", text: "Full custom prompt" } })
    expect(h1).not.toBe(h2)
  })

  test("full omit changes the hash", () => {
    const h1 = hashForOverrides()
    const h2 = hashForOverrides({ full: { kind: "omit" } })
    expect(h1).not.toBe(h2)
  })

  test("different replacement texts produce different hashes", () => {
    const h1 = hashForOverrides({ instructions: { kind: "replace", text: "A" } })
    const h2 = hashForOverrides({ instructions: { kind: "replace", text: "B" } })
    expect(h1).not.toBe(h2)
  })

  test("same replacement text produces same hash", () => {
    const h1 = hashForOverrides({ instructions: { kind: "replace", text: "Same" } })
    const h2 = hashForOverrides({ instructions: { kind: "replace", text: "Same" } })
    expect(h1).toBe(h2)
  })
})
