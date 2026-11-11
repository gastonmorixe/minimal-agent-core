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
