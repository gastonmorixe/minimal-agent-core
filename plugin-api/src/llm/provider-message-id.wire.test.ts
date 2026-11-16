/**
 * `CanonicalMessage.providerMessageId` is metadata only. The request
 * builders map messages field by field, so the id must never appear on a
 * wire message.
 */
import { describe, expect, it } from "bun:test"

import type { ModelView } from "../types/host-capabilities.ts"
import { buildAnthropicRequestBody } from "./anthropic-request.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import { buildOpenAIChatBody } from "./openai-chat.ts"

const model = {
  id: "claude-test",
  providerId: "anthropic",
  surfaceId: "anthropic",
  displayName: "Claude Test",
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

const req = {
  modelId: "claude-test",
  messages: [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "text", text: "a" }], providerMessageId: "msg_01abc" },
    { role: "user", content: [{ type: "text", text: "q2" }] },
  ],
} as CanonicalRequest

describe("providerMessageId never reaches the wire", () => {
  it("Anthropic Messages body", () => {
    const body = JSON.stringify(buildAnthropicRequestBody(req, model))
    expect(body).not.toContain("msg_01abc")
    expect(body).not.toContain("providerMessageId")
  })

  it("OpenAI Chat body", () => {
    const body = JSON.stringify(buildOpenAIChatBody(req, model))
    expect(body).not.toContain("msg_01abc")
    expect(body).not.toContain("providerMessageId")
  })
})
