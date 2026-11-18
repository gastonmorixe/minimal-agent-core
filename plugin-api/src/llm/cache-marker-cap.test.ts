import { describe, expect, it } from "bun:test"

import type { ModelView } from "../types/host-capabilities.ts"
import {
  type AnthropicContentBlock,
  type AnthropicRequestBody,
  buildAnthropicRequestBody,
} from "./anthropic-request.ts"
import type { CanonicalBlock, CanonicalMessage } from "./canonical-messages.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import { capCacheMarkers, countCacheMarkers, MAX_CACHE_MARKERS } from "./cache-marker-cap.ts"

const model = {
  id: "claude-test",
  providerId: "anthropic",
  surfaceId: "anthropic-messages",
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

const eph = { kind: "ephemeral", ttl: "5m" } as const
const sys = (t: string, cached: boolean): CanonicalBlock =>
  (cached ? { type: "text", text: t, cache: eph } : { type: "text", text: t }) as CanonicalBlock
const msg = (role: "user" | "assistant", t: string, cached: boolean): CanonicalMessage =>
  ({ role, content: [sys(t, cached)] }) as CanonicalMessage

function req(systemMarks: number, anchor: boolean): CanonicalRequest {
  return {
    modelId: "claude-test",
    system: [sys("billing", false), ...Array.from({ length: 3 }, (_, i) => sys(`s${i}`, i < systemMarks))],
    messages: [
      msg("user", "go", false),
      msg("assistant", "a1", false),
      msg("user", "r1", anchor),
      msg("assistant", "a2", false),
      msg("user", "r2", true),
    ],
  } as CanonicalRequest
}

describe("capCacheMarkers (F3)", () => {
  it("3 system markers + anchor + tail: at most 4 on the wire, anchor dropped first", () => {
    const body = buildAnthropicRequestBody(req(3, true), model)
    expect(countCacheMarkers(body)).toBe(MAX_CACHE_MARKERS)
    expect(body.system?.filter((b) => b.cache_control).length).toBe(3)
    const anchorBlock = (body.messages[2].content as Array<{ cache_control?: unknown }>)[0]
    expect(anchorBlock.cache_control).toBeUndefined()
    const tailBlock = (body.messages[4].content as Array<{ cache_control?: unknown }>)[0]
    expect(tailBlock.cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
  })

  it("2 system markers + anchor + tail = 4: nothing dropped", () => {
    const body = buildAnthropicRequestBody(req(2, true), model)
    expect(countCacheMarkers(body)).toBe(4)
    const anchorBlock = (body.messages[2].content as Array<{ cache_control?: unknown }>)[0]
    expect(anchorBlock.cache_control).toBeDefined()
  })

  it("in budget: the body is byte-identical to the uncapped build", () => {
    const body = buildAnthropicRequestBody(req(3, false), model)
    const before = JSON.stringify(body)
    expect(capCacheMarkers(body)).toBe(0)
    expect(JSON.stringify(body)).toBe(before)
  })

  it("after the anchor, drops system markers from the end, never the tail", () => {
    const body: AnthropicRequestBody = {
      model: "m",
      max_tokens: 1,
      system: [1, 2, 3, 4].map((i) => ({
        type: "text" as const,
        text: `s${i}`,
        cache_control: { type: "ephemeral" as const },
      })),
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "a", cache_control: { type: "ephemeral" as const } }] },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "x",
              content: [{ type: "text" as const, text: "t", cache_control: { type: "ephemeral" as const } }],
            },
          ],
        },
      ],
    }
    expect(countCacheMarkers(body)).toBe(6)
    expect(capCacheMarkers(body)).toBe(2)
    expect(countCacheMarkers(body)).toBe(4)
    // Anchor (first message marker) dropped, then the LAST system marker.
    const blocks = (i: number) => body.messages[i].content as AnthropicContentBlock[]
    expect(blocks(0)[0].cache_control).toBeUndefined()
    expect(body.system?.map((b) => b.cache_control !== undefined)).toEqual([true, true, true, false])
    // The tail (nested in a tool_result) is kept.
    const result = blocks(1)[0] as { content: AnthropicContentBlock[] }
    const nested = result.content[0]
    expect(nested.cache_control).toBeDefined()
  })
})
