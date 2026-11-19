import { describe, expect, it } from "bun:test"

import { buildAnthropicRequestBody, classifyRequest } from "./anthropic-request.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import type { ModelView } from "../types/host-capabilities.ts"

/** Minimal model fixture: only the capability fields the builder reads. */
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

const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] }

function req(extra: Partial<CanonicalRequest>): CanonicalRequest {
  return {
    modelId: "claude-test",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...extra,
  } as CanonicalRequest
}

describe("buildAnthropicRequestBody output_config.format (SPEC-ONESHOT R4/R5, D-5)", () => {
  it("sends exactly {type, schema}: drops canonical name and strict", () => {
    const body = buildAnthropicRequestBody(
      req({ outputFormat: { type: "json_schema", schema, strict: true, name: "x" } }),
      model,
    )
    expect(body.output_config?.format).toEqual({ type: "json_schema", schema })
    expect(Object.keys(body.output_config?.format ?? {}).sort()).toEqual(["schema", "type"])
  })

  it("passes canonical tool strict through to tools[].strict", () => {
    const body = buildAnthropicRequestBody(
      req({
        tools: [
          { name: "a", description: "A", inputSchema: schema, strict: true },
          { name: "b", description: "B", inputSchema: schema },
        ],
      }),
      model,
    )
    expect(body.tools?.[0]).toEqual({
      name: "a",
      description: "A",
      input_schema: schema,
      strict: true,
    })
    expect(body.tools?.[1]).toEqual({ name: "b", description: "B", input_schema: schema })
    expect("strict" in (body.tools?.[1] ?? {})).toBe(false)
  })
})

/** Model with effort levels, so the default-effort rule is observable. */
const effortModel = {
  ...model,
  capabilities: { ...model.capabilities, effort: { levels: ["low", "high"], default: "high" } },
} as unknown as ModelView

describe("classifyRequest title path (P1-1: explicit marker only)", () => {
  it("json_schema without tools and no marker is NOT title (user one-shot schema run)", () => {
    expect(classifyRequest(req({ outputFormat: { type: "json_schema", schema } }))).toBe("subtask")
  })

  it("schema run without marker gets the model default effort", () => {
    const body = buildAnthropicRequestBody(
      req({ outputFormat: { type: "json_schema", schema } }),
      effortModel,
    )
    expect(body.output_config?.effort).toBe("high")
  })

  it("purpose:'title' is title, with or without a schema", () => {
    expect(
      classifyRequest(req({ purpose: "title", outputFormat: { type: "json_schema", schema } })),
    ).toBe("title")
    expect(classifyRequest(req({ purpose: "title" }))).toBe("title")
  })

  it("title probe gets no default effort", () => {
    const body = buildAnthropicRequestBody(
      req({ purpose: "title", outputFormat: { type: "json_schema", schema } }),
      effortModel,
    )
    expect(body.output_config?.effort).toBeUndefined()
  })

  it("quota probe still wins over everything", () => {
    expect(
      classifyRequest(req({ purpose: "title", generation: { maxOutputTokens: 1 } })),
    ).toBe("quota")
  })

  it("json_schema with tools is not title", () => {
    const kind = classifyRequest(
      req({
        outputFormat: { type: "json_schema", schema },
        tools: [{ name: "a", description: "A", inputSchema: schema }],
      }),
    )
    expect(kind).not.toBe("title")
  })
})

/** Haiku 5.5-like model: adaptive thinking, full effort ladder, no sampling knobs. */
const haikuModel = {
  ...model,
  id: "claude-haiku-5-5",
  capabilities: {
    ...model.capabilities,
    maxOutputTokens: 128_000,
    thinking: { adaptive: true, extended: false, visible: true },
    effort: { levels: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
    acceptsTemperature: false,
    acceptsTopP: false,
    acceptsTopK: false,
  },
} as unknown as ModelView

function haikuReq(extra: Partial<CanonicalRequest>): CanonicalRequest {
  return req({ modelId: "claude-haiku-5-5", ...extra })
}

describe("thinking off for the title side call (title SPEC G7, m8, m2)", () => {
  it("title + off + effort low: full wire body (snapshot)", () => {
    const body = buildAnthropicRequestBody(
      haikuReq({
        purpose: "title",
        thinking: { mode: "off" },
        effort: "low",
        outputFormat: { type: "json_schema", schema, strict: true, name: "title" },
        generation: { maxOutputTokens: 128, temperature: 0, topP: 0.9 },
        stream: false,
      }),
      haikuModel,
    )
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        model: "claude-haiku-5-5",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        max_tokens: 128,
        thinking: { type: "disabled" },
        output_config: { effort: "low", format: { type: "json_schema", schema } },
        stream: false,
      }),
    )
    // No temperature / top_p (400 on Haiku 5.5) and no assistant prefill.
    expect("temperature" in body).toBe(false)
    expect("top_p" in body).toBe(false)
    expect(body.messages.at(-1)?.role).toBe("user")
    expect("context_management" in body).toBe(false)
  })

  it("title + off: effort medium and high also disable; omitted effort disables (model default)", () => {
    for (const effort of ["medium", "high", undefined] as const) {
      const body = buildAnthropicRequestBody(
        haikuReq({ purpose: "title", thinking: { mode: "off" }, effort }),
        haikuModel,
      )
      expect(body.thinking).toEqual({ type: "disabled" })
      expect(body.output_config?.effort).toBe(effort)
    }
  })

  it("title + off + effort above high: no thinking field (API rejects disabled there)", () => {
    for (const effort of ["xhigh", "max"] as const) {
      const body = buildAnthropicRequestBody(
        haikuReq({ purpose: "title", thinking: { mode: "off" }, effort }),
        haikuModel,
      )
      expect("thinking" in body).toBe(false)
      expect(body.output_config?.effort).toBe(effort)
    }
  })

  it("title + off on a non-adaptive model: no thinking field (unchanged)", () => {
    const body = buildAnthropicRequestBody(
      req({ purpose: "title", thinking: { mode: "off" }, effort: "low" }),
      model,
    )
    expect("thinking" in body).toBe(false)
  })

  it("effort pass-through: title request keeps the explicit effort on the wire", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const body = buildAnthropicRequestBody(haikuReq({ purpose: "title", effort }), haikuModel)
      expect(body.output_config?.effort).toBe(effort)
    }
  })

  it("regression m8: a main turn with thinking off keeps the same wire body (no thinking field)", () => {
    const tools = [
      { name: "a", description: "A", inputSchema: schema },
      { name: "b", description: "B", inputSchema: schema },
    ]
    const body = buildAnthropicRequestBody(
      haikuReq({ thinking: { mode: "off" }, tools, generation: { maxOutputTokens: 1000 } }),
      haikuModel,
    )
    expect(classifyRequest(haikuReq({ tools }))).toBe("conversation")
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        model: "claude-haiku-5-5",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        max_tokens: 1000,
        tools: [
          { name: "a", description: "A", input_schema: schema },
          { name: "b", description: "B", input_schema: schema },
        ],
        context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
        output_config: { effort: "medium" },
        stream: true,
      }),
    )
  })

  it("regression: subtask / schema run with thinking off and effort low: no thinking field", () => {
    const body = buildAnthropicRequestBody(
      haikuReq({
        thinking: { mode: "off" },
        effort: "low",
        outputFormat: { type: "json_schema", schema },
      }),
      haikuModel,
    )
    expect("thinking" in body).toBe(false)
  })

  it("regression: default path (no thinking config) still sends adaptive, also for title", () => {
    expect(buildAnthropicRequestBody(haikuReq({}), haikuModel).thinking).toEqual({
      type: "adaptive",
    })
    expect(buildAnthropicRequestBody(haikuReq({ purpose: "title" }), haikuModel).thinking).toEqual({
      type: "adaptive",
    })
  })

  it("regression: quota probe with thinking off does not change (no thinking field)", () => {
    const body = buildAnthropicRequestBody(
      haikuReq({ purpose: "title", thinking: { mode: "off" }, generation: { maxOutputTokens: 1 } }),
      haikuModel,
    )
    expect(classifyRequest(haikuReq({ generation: { maxOutputTokens: 1 } }))).toBe("quota")
    expect("thinking" in body).toBe(false)
    expect(body.output_config).toBeUndefined()
  })
})
