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

  it("never truncates or mid-wraps model ids; wraps only caps/metadata", async () => {
    // Neutral long id (no provider-family tokens — arch scan forbids those in core).
    const longId = "narrow-flagship-4.5-thinking-preview"
    registerTestProvider({
      id: "narrow",
      displayName: "Narrow",
      models: [
        {
          id: longId,
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

    // Full model id must appear contiguously (never hard-wrapped mid-token).
    expect(stripped).toContain(longId)
    expect(stripped).not.toMatch(/narrow-flagship-4\.5-think\s*\ning/)
    expect(stripped).toContain("ctx 1.05M")
    expect(stripped).toContain("out 128k")
    // Caps may stack under the primary row when the id is long, but labels
    // must still appear intact (not shredded into mid-token fragments only).
    expect(stripped).toContain("max-quality")
    expect(stripped).toContain("tools:strict")
    expect(stripped).not.toContain("medium")

    // Caps/metadata continuation lines still wrap to the terminal; only the
    // primary id row may exceed width when the model id itself is longer.
    for (const line of stripped.split("\n").filter(Boolean)) {
      if (line.includes(longId)) continue
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

  it("does not probe other providers' live catalogs when filtered (no foreign 401 noise)", async () => {
    // Regression: `provider models <id>` used to call every plugin's
    // listLiveModels. A revoked foreign OAuth token then printed
    // `(live model list unavailable: Models API 401: ...revoked)` under a
    // filtered listing even when the target provider was fine. Filter must
    // skip other hooks entirely.
    let otherHookCalls = 0
    let targetHookCalls = 0
    // Static registry first; plugin registration last so listLiveModels is kept
    // (registerTestProvider also installs a plugin without a live hook).
    registerTestProvider({
      id: "target",
      displayName: "Target",
      models: [{ id: "target-auto", displayName: "Auto" }],
    })
    registerProviderPlugin({
      id: "other",
      displayName: "Other",
      shortCode: "ot",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        otherHookCalls++
        throw new Error(
          'Models API 401: {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}',
        )
      },
    })
    registerProviderPlugin({
      id: "target",
      displayName: "Target",
      shortCode: "tgt",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        targetHookCalls++
        return [{ id: "target-auto", displayName: "Auto" }]
      },
    })

    let out = ""
    let err = ""
    await runListModelsCommand("target", {
      output: { write: (s) => (out += s) },
      error: { write: (s) => (err += s) },
    })
    const stripped = stripAnsi(out + err)

    expect(targetHookCalls).toBe(1)
    expect(otherHookCalls).toBe(0)
    expect(stripped).toContain("target-auto")
    expect(stripped).not.toContain("live model list unavailable")
    expect(stripped).not.toContain("Models API 401")
    expect(stripped).not.toContain("revoked")
  })

  it("keeps same bare model id under EACH provider (no cross-provider theft)", async () => {
    // Regression: Ollama live `kimi-k2.6` used to steal OpenCode's static
    // `kimi-k2.6` (and deepseek/glm/minimax siblings) because merge keyed only
    // on bare id. Both providers must still list the shared slug; OpenCode-only
    // slugs (kimi-k3) must not vanish either.
    registerTestProvider({
      id: "ollama",
      displayName: "Ollama Cloud",
      shortCode: "ol",
      models: [
        { id: "kimi-k2.6", displayName: "Kimi K2.6 (Ollama static)" },
        { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash (Ollama static)" },
      ],
    })
    registerTestProvider({
      id: "opencode",
      displayName: "OpenCode Go",
      shortCode: "oc",
      models: [
        { id: "kimi-k2.6", displayName: "Kimi K2.6 (OpenCode)" },
        { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash (OpenCode)" },
        { id: "kimi-k3", displayName: "Kimi K3 (OpenCode)" },
        { id: "glm-5.2", displayName: "GLM-5.2 (OpenCode)" },
        { id: "minimax-m3", displayName: "MiniMax M3 (OpenCode)" },
      ],
    })

    // Ollama has a live catalog that overlaps bare ids with OpenCode's static set.
    registerProviderPlugin({
      id: "ollama",
      displayName: "Ollama Cloud",
      shortCode: "ol",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        return [
          { id: "kimi-k2.6", displayName: "Kimi K2.6 (Ollama live)", createdAt: "2026-07-01" },
          {
            id: "deepseek-v4-flash",
            displayName: "DeepSeek V4 Flash (Ollama live)",
            createdAt: "2026-07-01",
          },
          { id: "glm-5.2", displayName: "GLM-5.2 (Ollama live)", createdAt: "2026-07-01" },
          { id: "minimax-m3", displayName: "MiniMax M3 (Ollama live)", createdAt: "2026-07-01" },
        ]
      },
    })
    // OpenCode has no listLiveModels (static registry only) — mirrors production.
    registerProviderPlugin({
      id: "opencode",
      displayName: "OpenCode Go",
      shortCode: "oc",
      register() {},
    })

    let out = ""
    await runListModelsCommand(undefined, {
      columns: 220,
      output: { write: (s) => (out += s) },
    })
    const stripped = stripAnsi(out)

    // Provider headers are printed as `  <providerId>` (two leading spaces).
    function section(text: string, provider: string): string {
      const re = new RegExp(
        `(?:^|\\n)  ${provider}\\n([\\s\\S]*?)(?=\\n  [a-z]|\\n  \\d+ models|$)`,
      )
      return text.match(re)?.[1] ?? ""
    }

    const ollamaSection = section(stripped, "ollama")
    const opencodeSection = section(stripped, "opencode")
    expect(ollamaSection.length).toBeGreaterThan(0)
    expect(opencodeSection.length).toBeGreaterThan(0)

    // Shared bare ids appear under BOTH providers (not stolen into ollama only).
    expect(ollamaSection).toContain("kimi-k2.6")
    expect(ollamaSection).toContain("deepseek-v4-flash")
    expect(opencodeSection).toContain("kimi-k2.6")
    expect(opencodeSection).toContain("deepseek-v4-flash")
    expect(opencodeSection).toContain("kimi-k3")
    expect(opencodeSection).toContain("glm-5.2")
    expect(opencodeSection).toContain("minimax-m3")

    // OpenCode still shows OpenCode display names (static), not Ollama live labels.
    expect(opencodeSection).toContain("Kimi K2.6 (OpenCode)")
    expect(opencodeSection).not.toContain("Kimi K2.6 (Ollama live)")

    // ollama: kimi-k2.6, deepseek-v4-flash, glm-5.2, minimax-m3 (4)
    // opencode: kimi-k2.6, deepseek-v4-flash, kimi-k3, glm-5.2, minimax-m3 (5)
    expect(stripped).toMatch(/(\d+) models available/)
    const total = Number(stripped.match(/(\d+) models available/)?.[1] ?? 0)
    expect(total).toBe(9)

    // Provider-filtered view must also keep OpenCode's full static catalog.
    let ocOnly = ""
    await runListModelsCommand("opencode", {
      columns: 220,
      output: { write: (s) => (ocOnly += s) },
    })
    const ocStripped = stripAnsi(ocOnly)
    expect(ocStripped).toContain("kimi-k3")
    expect(ocStripped).toContain("kimi-k2.6")
    expect(ocStripped).toContain("deepseek-v4-flash")
    expect(ocStripped).toContain("5 models available")
    expect(ocStripped).not.toContain("Ollama live")
  })

  it("enriches live row with static caps only when provider matches", async () => {
    // Live ollama row + static opencode row share id; ollama live must NOT pick
    // up opencode's displayName/caps via a bare-id merge.
    registerTestProvider({
      id: "opencode",
      displayName: "OpenCode Go",
      models: [
        {
          id: "shared-slug",
          displayName: "Shared (OpenCode)",
          capabilities: { contextWindow: 999_000, maxOutputTokens: 12_000 },
        },
      ],
    })
    registerProviderPlugin({
      id: "ollama",
      displayName: "Ollama Cloud",
      shortCode: "ol",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        return [{ id: "shared-slug", displayName: "Shared (Ollama live)", createdAt: "2026-03-03" }]
      },
    })
    registerProviderPlugin({
      id: "opencode",
      displayName: "OpenCode Go",
      shortCode: "oc",
      register() {},
    })

    let out = ""
    await runListModelsCommand(undefined, {
      columns: 220,
      output: { write: (s) => (out += s) },
    })
    const stripped = stripAnsi(out)

    function section(text: string, provider: string): string {
      const re = new RegExp(
        `(?:^|\\n)  ${provider}\\n([\\s\\S]*?)(?=\\n  [a-z]|\\n  \\d+ models|$)`,
      )
      return text.match(re)?.[1] ?? ""
    }
    const ollamaSection = section(stripped, "ollama")
    const opencodeSection = section(stripped, "opencode")

    expect(ollamaSection).toContain("Shared (Ollama live)")
    expect(ollamaSection).not.toContain("ctx 999k")
    expect(opencodeSection).toContain("Shared (OpenCode)")
    expect(opencodeSection).toContain("ctx 999k")
  })
})
