/**
 * Wave D-2: the `models:read` / `models:register` capability on the v2
 * capability host. Backed by the live model registry
 * (`src/llm/model-registry.ts`), exposed through `ctx.host` so a plugin can
 * read the catalog (or register into it) without importing `registerModel` /
 * `resolveModel` from `src/`.
 *
 * Deny-by-default: an undeclared token leaves its namespace `undefined`.
 *
 * @module plugins/v2/host.models.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { defaultCapabilities } from "../../llm/capabilities.ts"
import {
  clearModelRegistry,
  type ModelEntry,
  registerModel,
  setDefaultModelId,
} from "../../llm/model-registry.ts"
import { ANTHROPIC_OPUS_4X_STANDARD } from "../../llm/pricing.ts"

import { buildPluginHostV2 } from "./host.ts"

// The model registry is a module-level singleton shared across the bun-test
// process; clear it BOTH before and after each case so a sibling file that
// registered models (and the exact-equality `list()` assertion below) can't
// be polluted by run order.
beforeEach(() => clearModelRegistry())
afterEach(() => clearModelRegistry())

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "test-model-1",
    providerId: "test-provider",
    surfaceId: "custom",
    displayName: "Test Model 1",
    tags: ["cheap", "production"],
    capabilities: defaultCapabilities(),
    pricing: ANTHROPIC_OPUS_4X_STANDARD,
    ...overrides,
  }
}

describe("v2 host: models capability", () => {
  it("models:read populates host.models and reads the live registry", () => {
    registerModel(entry({ id: "test-model-1", aliases: ["tm1"] }))
    const host = buildPluginHostV2({ capabilities: ["models:read"] })
    expect(host.models).toBeDefined()
    expect(host.modelsRegistry).toBeUndefined()
    expect(host.models?.find("test-model-1")?.displayName).toBe("Test Model 1")
    expect(host.models?.find("tm1")?.id).toBe("test-model-1") // alias resolves
    expect(host.models?.find("nope")).toBeUndefined()
    expect(host.models?.resolve("test-model-1").id).toBe("test-model-1")
    expect(() => host.models?.resolve("nope")).toThrow()
    expect(host.models?.list().map((m) => m.id)).toEqual(["test-model-1"])
  })

  it("models:read exposes findByTags and defaultModelId", () => {
    registerModel(entry({ id: "cheap-1", tags: ["cheap", "production"] }))
    registerModel(entry({ id: "flagship-1", tags: ["flagship"] }))
    setDefaultModelId("flagship-1")
    const host = buildPluginHostV2({ capabilities: ["models:read"] })
    expect(host.models?.findByTags("test-provider", ["cheap"])?.id).toBe("cheap-1")
    expect(host.models?.findByTags("test-provider", ["nope"])).toBeUndefined()
    expect(host.models?.defaultModelId()).toBe("flagship-1")
  })

  it("models:register populates host.modelsRegistry and mutates the live registry", () => {
    const host = buildPluginHostV2({ capabilities: ["models:register"] })
    expect(host.modelsRegistry).toBeDefined()
    expect(host.models).toBeUndefined()
    host.modelsRegistry?.register(entry({ id: "registered-via-cap" }))
    // Read it back through a separate read-granted host.
    const reader = buildPluginHostV2({ capabilities: ["models:read"] })
    expect(reader.models?.find("registered-via-cap")?.id).toBe("registered-via-cap")
    host.modelsRegistry?.setDefault("registered-via-cap")
    expect(reader.models?.defaultModelId()).toBe("registered-via-cap")
  })

  it("grants both namespaces when both tokens are present", () => {
    const host = buildPluginHostV2({ capabilities: ["models:read", "models:register"] })
    expect(host.models).toBeDefined()
    expect(host.modelsRegistry).toBeDefined()
  })

  it("deny-by-default: neither namespace without a token", () => {
    const host = buildPluginHostV2({ capabilities: ["sessions:read"], sessionsDir: "/tmp" })
    expect(host.models).toBeUndefined()
    expect(host.modelsRegistry).toBeUndefined()
  })

  it("the models sub-APIs are frozen", () => {
    registerModel(entry())
    const host = buildPluginHostV2({ capabilities: ["models:read", "models:register"] })
    expect(Object.isFrozen(host.models)).toBe(true)
    expect(Object.isFrozen(host.modelsRegistry)).toBe(true)
  })
})
