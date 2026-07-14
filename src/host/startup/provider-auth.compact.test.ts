/**
 * providerAuthToAuthResult must preserve plan-auth baseUrl for compact.
 *
 * @module host/startup/provider-auth.compact.test
 */

import { describe, expect, it } from "bun:test"

import { providerAuthToAuthResult } from "./provider-auth.ts"

describe("providerAuthToAuthResult (compact / plan baseUrl)", () => {
  it("keeps oauth+baseUrl as type:provider so compact hits plan host", () => {
    const auth = providerAuthToAuthResult({
      kind: "oauth",
      token: "tok",
      baseUrl: "https://plan.example/backend-api/agent",
      headers: { "plan-account-id": "acc" },
    })
    expect(auth).toEqual({
      type: "provider",
      auth: {
        kind: "oauth",
        token: "tok",
        baseUrl: "https://plan.example/backend-api/agent",
        headers: { "plan-account-id": "acc" },
      },
    })
  })

  it("keeps plain oauth without baseUrl as type:oauth", () => {
    const auth = providerAuthToAuthResult({
      kind: "oauth",
      token: "tok",
    })
    expect(auth.type).toBe("oauth")
    if (auth.type === "oauth") expect(auth.token).toBe("tok")
  })
})
