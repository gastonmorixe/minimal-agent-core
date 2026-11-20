/**
 * Provider-resolved system-prompt tests.
 *
 * Covers the seam introduced so the agent never hardcodes a provider's
 * preamble: `resolveSystemPromptForModel` builds a neutral skeleton and
 * delegates to the model's provider plugin via the registry.
 *
 * @module llm/system-prompt.test
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import {
  fixtureIdentity,
  installFixtureSystemPromptBase,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import type { Capabilities } from "./capabilities.ts"
import { clearModelRegistry, registerModel } from "./model-registry.ts"
import {
  clearProviderPlugins,
  type ProviderPlugin,
  registerProviderPlugin,
  type SystemPromptContext,
} from "./provider-plugin.ts"
import { describeSystemBlock } from "./system-block-origins.ts"
import { buildAgentSystemBody, resolveSystemPromptForModel } from "./system-prompt.ts"
import type { SystemPromptOverrides } from "./system-prompt-overrides.ts"

// The identity and the base slots come from the real base prompt plugin
// (process-wide slot, as the loader sets it), not from a core fallback.
let releaseBase = (): void => {}
beforeAll(() => {
  releaseBase = installFixtureSystemPromptBase()
})
afterAll(() => releaseBase())

const CAPS: Capabilities = {
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
} as Capabilities

function registerFakeModel(id: string, providerId: string): void {
  registerModel({
    id,
    providerId,
    surfaceId: "custom",
    displayName: id,
    capabilities: CAPS,
    pricing: {
      inputUSD: 1,
      outputUSD: 1,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  })
}

afterEach(() => {
  clearProviderPlugins()
  clearModelRegistry()
})

// resolveAnthropicSystemPrompt's billing-header / Claude-Code-identity pins
// moved to plugins/llm-anthropic/system-prompt.test.ts (A-5): that preamble
// is provider wire knowledge and is pinned in the provider's own suite.

describe.skipIf(!textFixturesPresent())("resolveSystemPromptForModel", () => {
  it("delegates to the registered provider plugin's resolveSystemPrompt", () => {
    registerFakeModel("fake-1", "fakeprov")
    const seen: SystemPromptContext[] = []
    const plugin: ProviderPlugin = {
      id: "fakeprov",
      displayName: "Fake",
      shortCode: "fk",
      register() {},
      resolveSystemPrompt(ctx) {
        seen.push(ctx)
        return [{ type: "text", text: "FAKE-PREAMBLE" }, ...ctx.body]
      },
    }
    registerProviderPlugin(plugin)

    const out = resolveSystemPromptForModel("fake-1", {
      sessionContext: "ENV",
      authKind: "api-key",
    })
    expect(out[0].text).toBe("FAKE-PREAMBLE")
    // body = instructions block + session-context block
    expect(out.at(-1)?.text).toBe("ENV")
    expect(seen[0].authKind).toBe("api-key")
    expect(seen[0].modelId).toBe("fake-1")
  })

  it("falls back to the neutral identity when the provider declares no hook", () => {
    registerFakeModel("fake-2", "nohook")
    registerProviderPlugin({
      id: "nohook",
      displayName: "NoHook",
      shortCode: "nh",
      register() {},
    })
    const out = resolveSystemPromptForModel("fake-2", {})
    expect(out[0].text).toBe(fixtureIdentity())
  })

  it("falls back to neutral identity for an unknown model id (no throw)", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {})
    expect(out[0].text).toBe(fixtureIdentity())
    // instructions block always present after the identity
    expect(out).toHaveLength(2)
    expect(out[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
      scope: "global",
    })
  })

  it("uses the provider-scoped entry when a bare id is claimed by two providers", () => {
    registerFakeModel("shared-model", "rightprov")
    registerFakeModel("shared-model", "wrongprov")
    const seen: SystemPromptContext[] = []
    registerProviderPlugin({
      id: "rightprov",
      displayName: "Right",
      shortCode: "rp",
      register() {},
      resolveSystemPrompt(ctx) {
        seen.push(ctx)
        return [{ type: "text", text: "RIGHT-PREAMBLE" }, ...ctx.body]
      },
    })
    registerProviderPlugin({
      id: "wrongprov",
      displayName: "Wrong",
      shortCode: "wp",
      register() {},
      resolveSystemPrompt(ctx) {
        return [{ type: "text", text: "WRONG-PREAMBLE" }, ...ctx.body]
      },
    })
    const out = resolveSystemPromptForModel("shared-model", {
      authKind: "oauth",
      providerId: "rightprov",
    })
    expect(out[0].text).toBe("RIGHT-PREAMBLE")
    expect(seen[0].modelId).toBe("shared-model")
  })
})

describe.skipIf(!textFixturesPresent())("buildAgentSystemBody cache TTL", () => {
  it("defaults both breakpoints to 1h (instructions scoped global, session per-session)", () => {
    const body = buildAgentSystemBody({ sessionContext: "ENV" })
    expect(body).toHaveLength(2)
    expect(body[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
      scope: "global",
    })
    expect(body[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("applies an explicit cacheTtl (1h) to both breakpoints", () => {
    const body = buildAgentSystemBody({
      sessionContext: "ENV",
      cacheTtl: "1h",
    })
    expect(body[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
      scope: "global",
    })
    expect(body[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("threads cacheTtl through resolveSystemPromptForModel to the instructions block", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      cacheTtl: "1h",
    })
    expect(out[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
      scope: "global",
    })
  })
})

describe.skipIf(!textFixturesPresent())("buildAgentSystemBody afterInstructions", () => {
  it("inserts plain afterInstructions between instructions and sessionContext", () => {
    const body = buildAgentSystemBody({
      afterInstructions: "PLAIN GUIDANCE",
      sessionContext: "ENV",
    })
    expect(body).toHaveLength(3)
    expect(body[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
      scope: "global",
    })
    expect(body[1].text).toBe("PLAIN GUIDANCE")
    expect(body[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(body[2].text).toBe("ENV")
    expect(body[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("omits empty or whitespace-only afterInstructions", () => {
    const empty = buildAgentSystemBody({
      afterInstructions: "   ",
      sessionContext: "ENV",
    })
    expect(empty).toHaveLength(2)
    expect(empty[1].text).toBe("ENV")

    const missing = buildAgentSystemBody({ sessionContext: "ENV" })
    expect(missing).toHaveLength(2)
  })

  it("emits afterInstructions alone when sessionContext is absent", () => {
    const body = buildAgentSystemBody({ afterInstructions: "ONLY PLAIN" })
    expect(body).toHaveLength(2)
    expect(body[1].text).toBe("ONLY PLAIN")
    // per-session cache — no global scope
    expect(body[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("threads afterInstructions through resolveSystemPromptForModel", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      afterInstructions: "PLAIN",
      sessionContext: "CTX",
    })
    // identity + instructions + afterInstructions + sessionContext
    expect(out).toHaveLength(4)
    expect(out[2].text).toBe("PLAIN")
    expect(out[3].text).toBe("CTX")
  })
})

describe.skipIf(!textFixturesPresent())("system-prompt overrides", () => {
  const NO_OVERRIDES: SystemPromptOverrides = {}

  it("produces byte-identical output with no overrides (default identity + instructions)", () => {
    const baseline = resolveSystemPromptForModel("does-not-exist", {})
    const withEmpty = resolveSystemPromptForModel("does-not-exist", {
      overrides: NO_OVERRIDES,
    })
    expect(withEmpty).toEqual(baseline)
  })

  it("replaces the neutral identity", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      overrides: { identity: { kind: "replace", text: "Custom identity" } },
    })
    expect(out[0].text).toBe("Custom identity")
  })

  it("omits the neutral identity (falls back to the base identity)", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      overrides: { identity: { kind: "omit" } },
    })
    // omit on identity falls back to the base identity via applyPromptPartOverride
    expect(out[0].text).toBe(fixtureIdentity())
  })

  it("replaces instructions text", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      overrides: {
        instructions: { kind: "replace", text: "Custom instructions" },
      },
    })
    // instructions block starts with the replacement text
    expect(out[1].text.startsWith("Custom instructions")).toBe(true)
  })

  it("omits instructions text (loop-safety still present)", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      overrides: { instructions: { kind: "omit" } },
    })
    // identity + loop-safety block (instructions omitted but loop-safety remains)
    expect(out).toHaveLength(2)
    expect(out[0].text).toBe(fixtureIdentity())
    expect(out[1].text).toContain("# Tool loop safety")
  })

  it("replaces session context", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      sessionContext: "original context",
      overrides: {
        sessionContext: { kind: "replace", text: "custom context" },
      },
    })
    expect(out.at(-1)?.text).toBe("custom context")
  })

  it("omits session context", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      sessionContext: "original context",
      overrides: { sessionContext: { kind: "omit" } },
    })
    // identity + instructions only, no session context
    expect(out).toHaveLength(2)
  })

  it("full override replaces the entire core-controllable body", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      sessionContext: "ENV",
      overrides: { full: { kind: "replace", text: "Complete custom prompt" } },
    })
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe("Complete custom prompt")
  })

  it("full override replace records the identity origin", () => {
    resolveSystemPromptForModel("does-not-exist", {
      sessionContext: "ENV",
      overrides: { full: { kind: "replace", text: "FULL_OVERRIDE_ORIGIN" } },
    })
    expect(describeSystemBlock("FULL_OVERRIDE_ORIGIN")).toEqual([
      { slot: "identity", start: 0, end: 20, overridden: true },
    ])
  })

  it("full override omit returns empty blocks", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      sessionContext: "ENV",
      overrides: { full: { kind: "omit" } },
    })
    expect(out).toHaveLength(0)
  })

  it("threads providerPreambleOverride to the provider context", () => {
    registerFakeModel("fake-pp", "pprov")
    const seen: SystemPromptContext[] = []
    registerProviderPlugin({
      id: "pprov",
      displayName: "PP",
      shortCode: "pp",
      register() {},
      resolveSystemPrompt(ctx) {
        seen.push(ctx)
        return [{ type: "text", text: "PREAMBLE" }, ...ctx.body]
      },
    })
    resolveSystemPromptForModel("fake-pp", {
      overrides: {
        providerPreamble: { kind: "replace", text: "custom preamble" },
      },
    })
    expect(seen[0].providerPreambleOverride).toEqual({
      kind: "replace",
      text: "custom preamble",
    })
  })

  it("records hook-added blocks as providerPreamble with the provider id", () => {
    registerFakeModel("fake-origin", "oprov")
    registerProviderPlugin({
      id: "oprov",
      displayName: "OP",
      shortCode: "op",
      register() {},
      resolveSystemPrompt(ctx) {
        return [
          { type: "text", text: "HOOK_BILLING_ORIGIN" },
          { type: "text", text: "HOOK_IDENTITY_ORIGIN" },
          ...ctx.body,
        ]
      },
    })
    const out = resolveSystemPromptForModel("fake-origin", {
      sessionContext: "SESSION_CTX_ORIGIN_PASSTHROUGH",
    })
    expect(out.map((b) => b.text)).toContain("SESSION_CTX_ORIGIN_PASSTHROUGH")
    expect(describeSystemBlock("HOOK_BILLING_ORIGIN")).toEqual([
      { slot: "providerPreamble", start: 0, end: 19, overridden: false, providerId: "oprov" },
    ])
    expect(describeSystemBlock("HOOK_IDENTITY_ORIGIN")).toEqual([
      { slot: "providerPreamble", start: 0, end: 20, overridden: false, providerId: "oprov" },
    ])
    // A body block passed through by the hook keeps its core slot.
    expect(describeSystemBlock("SESSION_CTX_ORIGIN_PASSTHROUGH")).toEqual([
      { slot: "sessionContext", start: 0, end: 30, overridden: false },
    ])
  })

  it("marks the providerPreamble replace text as overridden", () => {
    registerFakeModel("fake-origin-r", "rprov")
    registerProviderPlugin({
      id: "rprov",
      displayName: "RP",
      shortCode: "rp",
      register() {},
      resolveSystemPrompt(ctx) {
        const o = ctx.providerPreambleOverride
        return [{ type: "text", text: o?.kind === "replace" ? o.text : "X" }, ...ctx.body]
      },
    })
    resolveSystemPromptForModel("fake-origin-r", {
      overrides: { providerPreamble: { kind: "replace", text: "REPLACED_PREAMBLE_ORIGIN" } },
    })
    expect(describeSystemBlock("REPLACED_PREAMBLE_ORIGIN")).toEqual([
      { slot: "providerPreamble", start: 0, end: 24, overridden: true, providerId: "rprov" },
    ])
  })

  it("records nothing extra when the model has no provider hook", () => {
    resolveSystemPromptForModel("does-not-exist", { identity: "NO_HOOK_IDENTITY_ORIGIN" })
    expect(describeSystemBlock("NO_HOOK_IDENTITY_ORIGIN")).toEqual([
      { slot: "identity", start: 0, end: 23, overridden: false },
    ])
  })
})
