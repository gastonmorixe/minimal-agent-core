import { describe, expect, it } from "bun:test"

import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"

import { canonicalMessageToLegacy, legacyMessageToCanonical } from "./adapter-legacy.ts"
import type { Message } from "./messages.ts"

describe("sideband block metadata in the legacy bridge", () => {
  it("legacy to canonical to legacy keeps the field", () => {
    const legacy: Message = {
      role: "user",
      content: [{ type: "text", text: "x", sideband: { kind: "note" } }],
    }
    const canon = legacyMessageToCanonical(legacy)
    expect(canon.content[0]).toMatchObject({ type: "text", sideband: { kind: "note" } })
    expect(canonicalMessageToLegacy(canon)).toEqual(legacy)
  })

  it("canonical to legacy keeps the field", () => {
    const canon: CanonicalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "x", sideband: { kind: "note" } }],
    }
    expect(JSON.stringify(canonicalMessageToLegacy(canon))).toContain("sideband")
  })

  it("a block without the field stays byte identical", () => {
    const legacy: Message = { role: "user", content: [{ type: "text", text: "x" }] }
    const canon = legacyMessageToCanonical(legacy)
    expect(JSON.stringify(canon)).not.toContain("sideband")
    expect(JSON.stringify(canonicalMessageToLegacy(canon))).toBe(JSON.stringify(legacy))
  })
})
