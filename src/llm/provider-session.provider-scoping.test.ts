/**
 * Test: resolveProviderSessionInfo respects providerId for scoped label.
 *
 * Proves that when both OpenCode and Wafer register deepseek-v4-flash,
 * calling resolveProviderSessionInfo with providerId:"opencode" returns
 * a label from OpenCode's scoped model entry, not from the global
 * last-write-wins entry (which would be Wafer).
 *
 * This is the bug the user hit: footer showed wf-v4-flash despite
 * --provider opencode.
 */

import { describe, expect, it } from "bun:test"

import { waferProviderPlugin } from "../../plugins/llm-wafer/adapter.ts"

import { clearModelRegistry, clearProviderRegistry } from "./model-registry.ts"
import { clearProviderPlugins, registerProviderPlugin } from "./provider-plugin.ts"
import { resolveProviderSessionInfo } from "./provider-session.ts"

async function getOpencodePlugin() {
  const mod = await import("../../plugins/llm-opencode/adapter.ts")
  return mod.opencodeProviderPlugin
}

function setup() {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
}

describe("resolveProviderSessionInfo with providerId scoping", () => {
  it("produces different labels for deepseek-v4-flash under opencode vs wafer", async () => {
    setup()

    // Register both providers fully (adapters + plugins)
    const ocPlugin = await getOpencodePlugin()
    ocPlugin.register()
    registerProviderPlugin(ocPlugin)

    const { bootstrapWafer } = await import("../../plugins/llm-wafer/adapter.ts")
    bootstrapWafer()
    registerProviderPlugin(waferProviderPlugin)

    // Unscoped: resolves via global = last-registered (Wafer alphabetically)
    const unscoped = await resolveProviderSessionInfo("deepseek-v4-flash")
    expect(unscoped.modelLabel).toBeDefined()

    // Scoped to opencode
    const scopedOc = await resolveProviderSessionInfo("deepseek-v4-flash", {
      providerId: "opencode",
    })
    expect(scopedOc.modelLabel).toBeDefined()

    // The two labels must be different because they come from different providers
    // with different shortCodes and modelVersionToken functions.
    expect(scopedOc.modelLabel).not.toBe(unscoped.modelLabel)

    // Scoped to wafer: must match unscoped (since Wafer is last-registered globally)
    const scopedWf = await resolveProviderSessionInfo("deepseek-v4-flash", {
      providerId: "wafer",
    })
    expect(scopedWf.modelLabel).toBe(unscoped.modelLabel)
  })
})
