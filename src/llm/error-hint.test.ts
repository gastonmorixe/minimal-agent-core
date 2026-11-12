import { describe, expect, test } from "bun:test"

import { NoProviderCredentialsError } from "../auth/errors.ts"

import { fatalErrorFields } from "./error-hint.ts"

describe("fatalErrorFields error field", () => {
  test("a CoreError fills error with kind and fields, message stays empty", () => {
    const err = new NoProviderCredentialsError("prov-a", "gpt-x", [])
    const out = fatalErrorFields(err)
    expect(out).not.toBeNull()
    expect(out?.message).toBe("")
    expect(out?.error?.kind).toBe("NoProviderCredentialsError")
    expect(out?.error?.fields).toEqual({
      providerId: "prov-a",
      modelId: "gpt-x",
      credentialedProviders: [],
    })
  })

  test("a plain Error has no error key and the JSON is unchanged", () => {
    const out = fatalErrorFields(new Error("boom"))
    expect(out).not.toBeNull()
    expect("error" in (out as object)).toBe(false)
    expect(JSON.stringify(out)).toBe('{"message":"boom"}')
  })
})
