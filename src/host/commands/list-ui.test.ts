import { afterEach, describe, expect, it } from "bun:test"

import { defaultAuthStore, resetDefaultAuthStoreForTests } from "../../auth-store.ts"
import { clearModelRegistry, clearProviderRegistry } from "../../llm/model-registry.ts"
import { clearProviderPlugins, registerProviderPlugin } from "../../llm/provider-plugin.ts"
import { registerTestProvider } from "../../llm/test-fixtures.ts"
import { stripAnsi } from "../../term-width.ts"
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
    expect(out).toContain("(1 models)")
    expect(out).toContain("1 providers")
  })

  it("renders models through injected output", async () => {
    registerTestProvider({
      id: "live",
      displayName: "Live",
      shortCode: "li",
      models: [{ id: "live-model" }],
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
      output: { write: (s) => (out += s) },
    })

    const stripped = stripAnsi(out)
    expect(stripped).toContain("live")
    expect(stripped).toContain("live-model")
    expect(stripped).toContain("Live Model")
    expect(stripped).toContain("custom")
    expect(stripped).toContain("2026-01-01")
    expect(stripped).toContain("1 models available")
    delete process.env.TEST_LIVE_KEY
  })
})
