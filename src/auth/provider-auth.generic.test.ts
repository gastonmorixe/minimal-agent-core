import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { resolveStartupAuth } from "./provider-auth.ts"

const prev = process.env.MINIMAL_AGENT_TEST_AUTH

describe("resolveStartupAuth — generic-endpoint auth", () => {
  beforeEach(() => {
    delete process.env.MINIMAL_AGENT_TEST_AUTH
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.MINIMAL_AGENT_TEST_AUTH
    else process.env.MINIMAL_AGENT_TEST_AUTH = prev
  })

  it("auth-type none yields empty custom headers", async () => {
    const auth = await resolveStartupAuth("generic-endpoint", "local-model", undefined, {
      authType: "none",
    })
    expect(auth).toEqual({ type: "provider", auth: { kind: "custom", headers: {} } })
  })

  it("auth-type bearer yields api-key auth", async () => {
    const auth = await resolveStartupAuth("generic-endpoint", "local-model", undefined, {
      authType: "bearer",
      apiKey: "sk-local",
    })
    expect(auth).toEqual({ type: "provider", auth: { kind: "api-key", key: "sk-local" } })
  })

  it("auth-type api-key requires a key", async () => {
    await expect(
      resolveStartupAuth("generic-endpoint", "local-model", undefined, { authType: "api-key" }),
    ).rejects.toThrow(/requires --api-key/)
  })

  it("auth-type custom-header wires the header bag", async () => {
    const auth = await resolveStartupAuth("generic-endpoint", "local-model", undefined, {
      authType: "custom-header",
      apiKey: "secret",
      authHeader: "X-Api-Key",
    })
    expect(auth).toEqual({
      type: "provider",
      auth: { kind: "custom", headers: { "X-Api-Key": "secret" } },
    })
  })

  it("custom-header requires --auth-header", async () => {
    await expect(
      resolveStartupAuth("generic-endpoint", "local-model", undefined, {
        authType: "custom-header",
        apiKey: "secret",
      }),
    ).rejects.toThrow(/requires --auth-header/)
  })

  it("defaults to none when no auth config is provided", async () => {
    const auth = await resolveStartupAuth("generic-endpoint", "local-model")
    expect(auth).toEqual({ type: "provider", auth: { kind: "custom", headers: {} } })
  })

  it("defaults to bearer when only an api-key is provided", async () => {
    const auth = await resolveStartupAuth("generic-endpoint", "local-model", undefined, {
      apiKey: "sk-local",
    })
    expect(auth).toEqual({ type: "provider", auth: { kind: "api-key", key: "sk-local" } })
  })
})
