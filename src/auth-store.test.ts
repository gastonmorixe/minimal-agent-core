import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { AuthStore, AuthStoreError, normalizeProviderId } from "./auth-store.ts"

let dir: string
let path: string
function freshStore(now?: () => number) {
  return new AuthStore({ path, now })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-authstore-"))
  path = join(dir, "auth.jsonc")
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("normalizeProviderId", () => {
  it("lowercases and accepts dash-case ascii", () => {
    expect(normalizeProviderId("Anthropic")).toBe("anthropic")
    expect(normalizeProviderId(" Anthropic-Plan-OAuth ")).toBe("anthropic-plan-oauth")
    expect(normalizeProviderId("openai-api-key")).toBe("openai-api-key")
  })
  it("rejects spaces, unicode, leading/trailing/double dashes", () => {
    for (const bad of ["", "an thropic", "-anthropic", "anthropic-", "a--b", "anthröpic", "a_b"]) {
      expect(() => normalizeProviderId(bad)).toThrow(AuthStoreError)
    }
  })
})

describe("AuthStore basic CRUD", () => {
  it("returns null/empty for a fresh (nonexistent) store", () => {
    const s = freshStore()
    expect(s.get("anthropic-plan-oauth")).toBeNull()
    expect(s.getSecrets("anthropic-plan-oauth")).toBeNull()
    expect(s.has("anthropic-plan-oauth")).toBe(false)
    expect(s.list()).toEqual([])
  })

  it("sets and reads back an opaque secret bag verbatim", () => {
    const s = freshStore()
    const bag = { accessToken: "AT", nested: { a: [1, 2, 3], b: null }, n: 42, ok: true }
    s.set("anthropic-plan-oauth", "Anthropic Plan (OAuth)", bag)
    expect(s.getSecrets("anthropic-plan-oauth")).toEqual(bag)
    const entry = s.get("anthropic-plan-oauth")!
    expect(entry.id).toBe("anthropic-plan-oauth")
    expect(entry.name).toBe("Anthropic Plan (OAuth)")
    expect(entry.createdAt).toBeDefined()
  })

  it("normalizes the provider id on write (case-insensitive lookups)", () => {
    const s = freshStore()
    s.set("Anthropic-Plan-OAuth", "X", { k: 1 })
    expect(s.getSecrets("anthropic-plan-oauth")).toEqual({ k: 1 })
  })

  it("upsert preserves createdAt but advances updatedAt", () => {
    let t = 1000
    const s = freshStore(() => t)
    const a = s.set("p", "Name", { v: 1 })
    t = 5000
    const b = s.set("p", "Name", { v: 2 })
    expect(b.createdAt).toBe(a.createdAt)
    expect(b.updatedAt).not.toBe(a.updatedAt)
    expect(s.getSecrets("p", "Name")).toEqual({ v: 2 })
    expect(s.list("p")).toHaveLength(1)
  })

  it("patch shallow-merges, preserving untouched keys", () => {
    const s = freshStore()
    s.set("p", "N", { accessToken: "A", refreshToken: "R", scopes: ["x"] })
    s.patch("p", "N", { accessToken: "A2", expiresAt: 99 })
    expect(s.getSecrets("p", "N")).toEqual({
      accessToken: "A2",
      refreshToken: "R",
      scopes: ["x"],
      expiresAt: 99,
    })
  })

  it("patch on a missing entry creates it", () => {
    const s = freshStore()
    s.patch("p", "N", { a: 1 })
    expect(s.getSecrets("p", "N")).toEqual({ a: 1 })
  })

  it("remove is idempotent and returns whether it removed", () => {
    const s = freshStore()
    s.set("p", "N", { a: 1 })
    expect(s.remove("p", "N")).toBe(true)
    expect(s.remove("p", "N")).toBe(false)
    expect(s.has("p", "N")).toBe(false)
  })

  it("clear wipes the whole file", () => {
    const s = freshStore()
    s.set("p", "N", { a: 1 })
    s.set("q", "M", { b: 2 })
    s.clear()
    expect(s.list()).toEqual([])
    s.clear() // idempotent
  })
})

describe("AuthStore multi-entry / same-slug semantics", () => {
  it("allows multiple entries under one slug with distinct names", () => {
    const s = freshStore()
    s.set("anthropic-enterprise-oauth", "Anthropic Enterprise (OAuth)", { org: "A" })
    s.set("anthropic-enterprise-oauth", "Anthropic Enterprise (OAuth) 2", { org: "B" })
    expect(s.list("anthropic-enterprise-oauth")).toHaveLength(2)
    expect(s.getSecrets("anthropic-enterprise-oauth", "Anthropic Enterprise (OAuth)")).toEqual({
      org: "A",
    })
    expect(s.getSecrets("anthropic-enterprise-oauth", "Anthropic Enterprise (OAuth) 2")).toEqual({
      org: "B",
    })
  })

  it("treats same (id,name) as the same entry (case-insensitive name)", () => {
    const s = freshStore()
    s.set("p", "Name", { v: 1 })
    s.set("p", "name", { v: 2 }) // same entry, different case
    expect(s.list("p")).toHaveLength(1)
  })

  it("name-less get/remove throws when the slug is ambiguous", () => {
    const s = freshStore()
    s.set("p", "A", { v: 1 })
    s.set("p", "B", { v: 2 })
    expect(() => s.get("p")).toThrow(/specify a name/)
    expect(() => s.remove("p")).toThrow(/specify a name/)
    // but explicit name works
    expect(s.remove("p", "A")).toBe(true)
    expect(s.get("p")).not.toBeNull() // now unambiguous
  })
})

describe("AuthStore validation", () => {
  it("rejects non-object secrets", () => {
    const s = freshStore()
    // @ts-expect-error intentionally wrong type
    expect(() => s.set("p", "N", "nope")).toThrow(AuthStoreError)
    // @ts-expect-error intentionally wrong type
    expect(() => s.set("p", "N", [1, 2])).toThrow(AuthStoreError)
    // @ts-expect-error intentionally wrong type
    expect(() => s.set("p", "N", null)).toThrow(AuthStoreError)
  })
  it("rejects empty names", () => {
    const s = freshStore()
    expect(() => s.set("p", "   ", { a: 1 })).toThrow(AuthStoreError)
  })
})

describe("AuthStore persistence", () => {
  it("writes a 0600 .jsonc file with a banner, re-readable by a new instance", () => {
    freshStore().set("anthropic-plan-oauth", "Anthropic Plan (OAuth)", { accessToken: "AT" })
    const text = readFileSync(path, "utf-8")
    expect(text).toContain("minimal-agent credential store")
    expect(text).toContain('"version": 1')
    // 0600 — owner rw only
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // a brand-new instance sees the persisted data
    expect(new AuthStore({ path }).getSecrets("anthropic-plan-oauth")).toEqual({
      accessToken: "AT",
    })
  })

  it("tolerates comments and trailing commas on read", () => {
    writeFileSync(
      path,
      `// hand-written\n{ "version": 1, "entries": [ { "id": "p", "name": "N", "secrets": { "a": 1 }, }, ], }`,
    )
    expect(new AuthStore({ path }).getSecrets("p", "N")).toEqual({ a: 1 })
  })

  it("throws AuthStoreError (not a silent reset) on a corrupt file", () => {
    writeFileSync(path, "{ this is : not json")
    expect(() => new AuthStore({ path }).list()).toThrow(AuthStoreError)
  })

  it("throws on a duplicate (id,name) in a hand-edited file", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          { id: "p", name: "N", secrets: {} },
          { id: "p", name: "n", secrets: {} },
        ],
      }),
    )
    expect(() => new AuthStore({ path }).list()).toThrow(/duplicate/)
  })
})
