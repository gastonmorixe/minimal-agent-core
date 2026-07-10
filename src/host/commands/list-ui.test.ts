import { afterEach, describe, expect, it } from "bun:test"

import { defaultAuthStore, resetDefaultAuthStoreForTests } from "../../auth/auth-store.ts"
import { clearModelRegistry, clearProviderRegistry } from "../../llm/model-registry.ts"
import { clearProviderPlugins, registerProviderPlugin } from "../../llm/provider-plugin.ts"
import { registerTestProvider } from "../../llm/test-fixtures.ts"
import { displayWidth, stripAnsi } from "../../terminal/term-width.ts"
import { SPINNER_PRESETS } from "../ui/spinner/named-presets.ts"

import { runListFlagsCommand } from "./list-flags.ts"
import { runListModelsCommand } from "./list-models.ts"
import { runListProvidersCommand } from "./list-providers.ts"
import { runListSpinnersCommand } from "./list-spinners.ts"

function capture(run: (deps: { output: { write(s: string): unknown } }) => void): string {
  let out = ""
  run({ output: { write: (s) => (out += s) } })
  return stripAnsi(out)
}

describe("list UI commands", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    resetDefaultAuthStoreForTests()
  })

  it("renders spinner presets through injected output", () => {
    const out = capture(runListSpinnersCommand)
    expect(out).toContain("Spinner presets")
    expect(out).toContain(SPINNER_PRESETS[0]!.id)
    expect(out).toContain(`${SPINNER_PRESETS.length} presets total`)
  })

  it("renders beta flags from registered provider plugins", () => {
    // The command iterates each provider plugin's listBetaFlags() hook (OCP);
    // register a fake provider so the test owns the expected rows.
    registerProviderPlugin({
      id: "flag-test-provider",
      displayName: "Flag Test Provider",
      shortCode: "ftp",
      register() {},
      listBetaFlags: () => [
        { id: "demo-flag-2026-01-01", description: "A demo flag", condition: "always" },
      ],
    })
    const out = capture(runListFlagsCommand)
    expect(out).toContain("Beta feature flags")
    expect(out).toContain("demo-flag-2026-01-01")
    expect(out).toContain("1 flags total")
  })

  it("renders providers through injected output", () => {
    registerTestProvider({
      id: "test-provider",
      displayName: "Test Provider",
      models: [{ id: "list-ui-model" }],
    })

    const out = capture(runListProvidersCommand)
    expect(out).toContain("test-provider")
    expect(out).toContain("custom")
    expect(out).toContain("(1 model)")
    expect(out).toContain("1 providers")
  })

  it("renders models through injected output", async () => {
    registerTestProvider({
      id: "live",
      displayName: "Live",
      shortCode: "li",
      models: [
        {
          id: "live-model",
          capabilities: {
            contextWindow: 1_050_000,
            maxOutputTokens: 128_000,
            effort: { levels: ["low", "medium", "xhigh"], default: "medium" },
            thinking: { visible: true, adaptive: true },
            tools: { userDefined: true, strictSchema: true },
            modalities: { image: true, pdf: true },
            structuredOutputs: true,
            serverSideHistory: true,
            serverTools: ["web_search", "code_interpreter"],
          },
        },
      ],
    })
    registerProviderPlugin({
      id: "live",
      displayName: "Live",
      shortCode: "li",
      register() {},
      apiKeyAuth: {
        serviceId: "live",
        displayName: "Live",
        buildCredential: (key) => ({
          serviceId: "live",
          displayName: "Live",
          secrets: { apiKey: key },
        }),
        readApiKey: (secrets) => (typeof secrets.apiKey === "string" ? secrets.apiKey : null),
      },
      async listLiveModels() {
        return [{ id: "live-model", displayName: "Live Model", createdAt: "2026-01-01" }]
      },
    })
    defaultAuthStore().set("live", "Live", { apiKey: "dummy" })

    let out = ""
    await runListModelsCommand(undefined, {
      columns: 220,
      output: { write: (s) => (out += s) },
    })

    const stripped = stripAnsi(out)
    expect(stripped).toContain("live")
    expect(stripped).toContain("live-model")
    expect(stripped).toContain("Live Model")
    expect(stripped).toContain("ctx 1.05M")
    expect(stripped).toContain("out 128k")
    expect(stripped).toContain("eff:low/medium/xhigh")
    expect(stripped).toContain("think:vis")
    expect(stripped).toContain("tools:strict")
    expect(stripped).toContain("in:img,pdf")
    expect(stripped).toContain("host:web,code")
    expect(stripped).toContain("json")
    expect(stripped).toContain("hist")
    expect(stripped).toContain("surface:custom")
    expect(stripped).toContain("cutoff:2026-01-01")
    expect(stripped).toContain("1 models available")
    delete process.env.TEST_LIVE_KEY
  })

  it("renders models within the injected terminal width", async () => {
    registerTestProvider({
      id: "narrow",
      displayName: "Narrow",
      models: [
        {
          id: "very-long-model-id-that-must-be-clipped",
          capabilities: {
            contextWindow: 1_050_000,
            maxOutputTokens: 128_000,
            effort: { levels: ["provider-custom-effort", "max-quality"], default: "max-quality" },
            thinking: { visible: true, adaptive: true },
            tools: { userDefined: true, strictSchema: true },
            modalities: { image: true, audio: true, pdf: true },
            serverTools: ["web_search", "file_search", "code_interpreter"],
            structuredOutputs: true,
            serverSideHistory: true,
            caching: { automatic: true },
          },
        },
      ],
    })

    let out = ""
    await runListModelsCommand("narrow", {
      columns: 72,
      output: { write: (s) => (out += s) },
    })
    const stripped = stripAnsi(out)

    expect(stripped).toContain("ctx 1.05M")
    expect(stripped).toContain("out 128k")
    expect(stripped).toContain("eff:provider")
    expect(stripped).toContain("max-quality")
    expect(stripped).not.toContain("medium")
    for (const line of stripped.split("\n").filter(Boolean)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(72)
    }
  })

  it("lists a publicModelList provider's live catalog WITHOUT a stored credential", async () => {
    // No credential is set for this provider. Because it declares
    // `publicModelList`, the command must still invoke listLiveModels (with an
    // anonymous auth) rather than falling back to the empty registry.
    let sawAuthKind: string | undefined
    registerProviderPlugin({
      id: "pub",
      displayName: "Public Gateway",
      shortCode: "pub",
      register() {},
      publicModelList: true,
      async listLiveModels(auth) {
        sawAuthKind = auth.kind
        return [{ id: "pub-live-model", displayName: "Pub Live", createdAt: "2026-02-02" }]
      },
    })

    let out = ""
    await runListModelsCommand("pub", { output: { write: (s) => (out += s) } })
    const stripped = stripAnsi(out)

    expect(sawAuthKind).toBe("custom") // anonymous auth was synthesized
    expect(stripped).toContain("pub-live-model")
    expect(stripped).toContain("Pub Live")
    expect(stripped).toContain("1 models available")
  })

  it("does NOT list an auth-required provider's live catalog without a credential", async () => {
    // Same setup but WITHOUT publicModelList: no credential means the hook is
    // never called and the provider contributes zero rows.
    let hookCalled = false
    registerProviderPlugin({
      id: "priv",
      displayName: "Private Provider",
      shortCode: "prv",
      register() {},
      async listLiveModels() {
        hookCalled = true
        return [{ id: "priv-live-model" }]
      },
    })

    let out = ""
    await runListModelsCommand("priv", { output: { write: (s) => (out += s) } })
    const stripped = stripAnsi(out)

    expect(hookCalled).toBe(false)
    expect(stripped).not.toContain("priv-live-model")
    expect(stripped).toContain('no models registered for provider "priv"')
  })
})
