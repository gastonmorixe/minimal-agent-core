/**
 * HuggingFace capability tests.
 *
 * Covers the permissive default (the fix for the hard-reject bug) and the
 * per-model derivation from live `/v1/models` data. Shapes here mirror REAL
 * router responses captured 2026-07-01 (DeepSeek-V4-Flash, Qwen3.6-35B-A3B).
 *
 * @module llm/providers/huggingface/capabilities.test
 */

import { describe, expect, it } from "bun:test"

import { CAPS_HUGGINGFACE_CHAT, deriveHuggingFaceCapabilities } from "./capabilities.ts"

describe("CAPS_HUGGINGFACE_CHAT (permissive gateway default)", () => {
  it("enables reasoning so --effort is NOT hard-rejected", () => {
    // Regression guard for the bug: effort.levels was [] and thinking.adaptive
    // false, which rejected `--effort high` + `--thinking` on every HF model.
    expect(CAPS_HUGGINGFACE_CHAT.effort.levels).toContain("high")
    expect(CAPS_HUGGINGFACE_CHAT.effort.levels).toEqual(["low", "medium", "high", "xhigh"])
    expect(CAPS_HUGGINGFACE_CHAT.thinking.adaptive).toBe(true)
    expect(CAPS_HUGGINGFACE_CHAT.thinking.visible).toBe(true)
  })

  it("keeps tools + structured outputs on and image modality available", () => {
    expect(CAPS_HUGGINGFACE_CHAT.tools.userDefined).toBe(true)
    expect(CAPS_HUGGINGFACE_CHAT.structuredOutputs).toBe(true)
    expect(CAPS_HUGGINGFACE_CHAT.modalities.image).toBe(true)
  })
})

describe("deriveHuggingFaceCapabilities (per-model from live data)", () => {
  it("ORs booleans across backends and takes the max context window", () => {
    // Real DeepSeek-V4-Flash shape: tools on 3 backends, structured only on
    // deepinfra, a stub featherless entry, text-only.
    const caps = deriveHuggingFaceCapabilities({
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      providers: [
        {
          provider: "novita",
          status: "live",
          context_length: 1_048_576,
          supports_tools: true,
          supports_structured_output: false,
        },
        {
          provider: "fireworks-ai",
          status: "live",
          context_length: 1_048_576,
          supports_tools: true,
          supports_structured_output: false,
        },
        { provider: "featherless-ai", status: "live" }, // stub, no cap keys
        {
          provider: "deepinfra",
          status: "live",
          context_length: 1_048_576,
          supports_tools: true,
          supports_structured_output: true,
        },
      ],
    })
    expect(caps.contextWindow).toBe(1_048_576)
    expect(caps.tools.userDefined).toBe(true) // true on >=1 backend
    expect(caps.structuredOutputs).toBe(true) // only deepinfra, but reachable via pinning
    expect(caps.modalities.image).toBe(false) // text-only
    // Reasoning stays permissive (HF exposes no reasoning field).
    expect(caps.effort.levels).toContain("high")
  })

  it("detects image input from architecture.input_modalities", () => {
    const caps = deriveHuggingFaceCapabilities({
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      providers: [
        {
          provider: "novita",
          status: "live",
          context_length: 262_144,
          supports_tools: true,
          supports_structured_output: true,
        },
      ],
    })
    expect(caps.modalities.image).toBe(true)
    expect(caps.contextWindow).toBe(262_144)
  })

  it("reports tools=false when no backend supports them", () => {
    const caps = deriveHuggingFaceCapabilities({
      architecture: { input_modalities: ["text"] },
      providers: [{ provider: "x", status: "live", context_length: 8_192, supports_tools: false }],
    })
    expect(caps.tools.userDefined).toBe(false)
    expect(caps.contextWindow).toBe(8_192)
  })

  it("falls back to the permissive default context window when no data", () => {
    const caps = deriveHuggingFaceCapabilities({})
    expect(caps.contextWindow).toBe(CAPS_HUGGINGFACE_CHAT.contextWindow)
    expect(caps.effort.levels).toEqual(CAPS_HUGGINGFACE_CHAT.effort.levels)
  })

  it("ignores non-live providers when a live one exists", () => {
    const caps = deriveHuggingFaceCapabilities({
      architecture: { input_modalities: ["text"] },
      providers: [
        { provider: "dead", status: "error", context_length: 999_999, supports_tools: true },
        { provider: "live1", status: "live", context_length: 64_000, supports_tools: false },
      ],
    })
    // The dead provider's big window + tools must NOT count.
    expect(caps.contextWindow).toBe(64_000)
    expect(caps.tools.userDefined).toBe(false)
  })
})
