import { describe, expect, it } from "bun:test"

import { resolveBootModel, resolveSingleStoredProviderBootModel } from "./resolve-boot-model.ts"

describe("resolveBootModel", () => {
  it("prefers CLI model and provider over env and config", () => {
    expect(
      resolveBootModel({
        cliModel: "model-cli",
        cliProvider: "provider-cli",
        envModel: "model-env",
        envProvider: "provider-env",
        configModel: "model-config",
        configProvider: "provider-config",
      }),
    ).toEqual({
      kind: "explicit",
      model: "model-cli",
      modelSource: "cli",
      provider: "provider-cli",
      providerSource: "cli",
    })
  })

  it("falls back to env then config for both fields", () => {
    expect(
      resolveBootModel({
        envModel: "model-env",
        envProvider: "provider-env",
        configModel: "model-config",
        configProvider: "provider-config",
      }),
    ).toEqual({
      kind: "explicit",
      model: "model-env",
      modelSource: "env",
      provider: "provider-env",
      providerSource: "env",
    })
    expect(
      resolveBootModel({ configModel: "model-config", configProvider: "provider-config" }),
    ).toEqual({
      kind: "explicit",
      model: "model-config",
      modelSource: "config",
      provider: "provider-config",
      providerSource: "config",
    })
  })

  it("signals invalid when only one of model/provider is configured", () => {
    expect(resolveBootModel({ cliModel: "model-only" })).toEqual({
      kind: "invalid",
      reason: 'model "model-only" requires an explicit provider; pass --provider <id> too',
    })
    expect(resolveBootModel({ cliProvider: "provider-only" })).toEqual({
      kind: "invalid",
      reason: 'provider "provider-only" requires an explicit model; pass --model <id> too',
    })
  })

  it("signals unconfigured when neither model nor provider is configured", () => {
    expect(resolveBootModel({})).toEqual({ kind: "unconfigured" })
    expect(resolveBootModel({ cliModel: "  ", envProvider: "", configModel: undefined })).toEqual({
      kind: "unconfigured",
    })
  })

  it("trims whitespace before resolving", () => {
    expect(
      resolveBootModel({
        cliModel: "  from-cli  ",
        cliProvider: "  provider-cli  ",
      }),
    ).toEqual({
      kind: "explicit",
      model: "from-cli",
      modelSource: "cli",
      provider: "provider-cli",
      providerSource: "cli",
    })
    expect(
      resolveBootModel({ configModel: " from-config ", configProvider: " provider-config " }),
    ).toEqual({
      kind: "explicit",
      model: "from-config",
      modelSource: "config",
      provider: "provider-config",
      providerSource: "config",
    })
  })
})

describe("resolveSingleStoredProviderBootModel", () => {
  it("selects a provider-suggested model only when exactly one usable provider is stored", () => {
    expect(
      resolveSingleStoredProviderBootModel(
        [{ providerId: "provider-a", credentialInfo: { usable: true } }],
        (providerId) => `${providerId}/model-a`,
      ),
    ).toEqual({
      kind: "explicit",
      model: "provider-a/model-a",
      modelSource: "stored-provider",
      provider: "provider-a",
      providerSource: "stored-provider",
    })
  })

  it("does not choose a global default when no provider is stored", () => {
    expect(resolveSingleStoredProviderBootModel([], () => "global-default")).toEqual({
      kind: "invalid",
      reason:
        "no provider credentials found; set both model and provider in config, or pass --provider <id> --model <id>",
    })
  })

  it("does not choose when multiple usable providers are stored", () => {
    expect(
      resolveSingleStoredProviderBootModel(
        [
          { providerId: "provider-a", credentialInfo: { usable: true } },
          { providerId: "provider-b", credentialInfo: { usable: true } },
        ],
        (providerId) => `${providerId}/model-a`,
      ),
    ).toEqual({
      kind: "invalid",
      reason:
        "multiple provider credentials found; set both model and provider in config, or pass --provider <id> --model <id>",
    })
  })

  it("does not choose an unreadable stored provider", () => {
    expect(
      resolveSingleStoredProviderBootModel(
        [{ providerId: "provider-a", credentialInfo: { usable: false } }],
        (providerId) => `${providerId}/model-a`,
      ),
    ).toEqual({
      kind: "invalid",
      reason:
        "no usable provider credentials found; set both model and provider in config, or pass --provider <id> --model <id>",
    })
  })
})
