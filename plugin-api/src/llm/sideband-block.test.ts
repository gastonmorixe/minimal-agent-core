import { describe, expect, it } from "bun:test"

import { buildAnthropicRequestBody } from "./anthropic-request.ts"
import type { CanonicalMessage } from "./canonical-messages.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import { buildOpenAIChatBody } from "./openai-chat.ts"
import type { ModelView } from "../types/host-capabilities.ts"

const model = {
  id: "m",
  providerId: "p",
  surfaceId: "s",
  displayName: "M",
  capabilities: {
    maxOutputTokens: 64_000,
    thinking: { adaptive: false, extended: false, visible: false },
    effort: { levels: [], default: undefined },
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsTopK: true,
    speedFast: false,
  },
  pricing: {},
} as unknown as ModelView

function request(messages: CanonicalMessage[]): CanonicalRequest {
  return { modelId: "m", messages } as CanonicalRequest
}

const tagged: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "hi", sideband: { kind: "note" } }] },
  { role: "assistant", content: [{ type: "text", text: "yo", sideband: { kind: "note" } }] },
]
const plain: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
  { role: "assistant", content: [{ type: "text", text: "yo" }] },
]

describe("sideband block metadata never reaches a core encoder", () => {
  it("anthropic encoder drops the field", () => {
    const body = JSON.stringify(buildAnthropicRequestBody(request(tagged), model))
    expect(body).not.toContain("sideband")
    expect(body).toBe(JSON.stringify(buildAnthropicRequestBody(request(plain), model)))
  })

  it("openai chat encoder drops the field", () => {
    const body = JSON.stringify(buildOpenAIChatBody(request(tagged), model))
    expect(body).not.toContain("sideband")
    expect(body).toBe(JSON.stringify(buildOpenAIChatBody(request(plain), model)))
  })
})
