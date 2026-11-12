import { describe, expect, it } from "bun:test"

import { CoreError } from "../errors/core-error.ts"

import {
  GenericEndpointAuthError,
  NoProviderCredentialsError,
  NoProviderSelectedError,
  type StoredProviderFact,
  UnhandledAuthTypeError,
} from "./errors.ts"

const FACTS: StoredProviderFact[] = [
  { providerId: "acme", labels: ["Work"], exampleModels: ["acme/m1"] },
]

describe("auth errors", () => {
  it("NoProviderSelectedError holds facts and an empty message", () => {
    const e = new NoProviderSelectedError("model-a", FACTS)
    expect(e).toBeInstanceOf(CoreError)
    expect(e.message).toBe("")
    expect(e.kind).toBe("NoProviderSelectedError")
    expect(e.toJSON()).toEqual({
      kind: "NoProviderSelectedError",
      fields: { modelId: "model-a", credentialedProviders: FACTS },
    })
  })

  it("NoProviderCredentialsError holds provider, model and facts", () => {
    const e = new NoProviderCredentialsError("acme", "model-a", [])
    expect(e.kind).toBe("NoProviderCredentialsError")
    expect(e.message).toBe("")
    expect(e.toJSON().fields).toEqual({
      providerId: "acme",
      modelId: "model-a",
      credentialedProviders: [],
    })
  })

  it("GenericEndpointAuthError holds the auth type and the missing flag", () => {
    const e = new GenericEndpointAuthError("custom-header", "auth-header")
    expect(e.kind).toBe("GenericEndpointAuthError")
    expect(e.toJSON().fields).toEqual({ authType: "custom-header", missing: "auth-header" })
  })

  it("UnhandledAuthTypeError holds the auth type", () => {
    const e = new UnhandledAuthTypeError("weird")
    expect(e.kind).toBe("UnhandledAuthTypeError")
    expect(e.name).toBe("UnhandledAuthTypeError")
    expect(e.toJSON().fields).toEqual({ authType: "weird" })
  })
})
