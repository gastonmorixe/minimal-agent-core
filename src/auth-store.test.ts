import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  AuthStore,
  AuthStoreError,
  defaultAuthFilePath,
  normalizeProviderId,
} from "./auth-store.ts"

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

describe("defaultAuthFilePath (token-store path — byte-pinned)", () => {
  it("defaults to <agent-home>/auth.jsonc", () => {
    // The default home now resolves through `resolveAgentHome` (honoring
    // MINIMAL_AGENT_HOME), so clear BOTH the file override and the home
    // override to pin the true default, then restore.
    const prevFile = process.env.MINIMAL_AGENT_AUTH_FILE
    const prevHome = process.env.MINIMAL_AGENT_HOME
    delete process.env.MINIMAL_AGENT_AUTH_FILE
    delete process.env.MINIMAL_AGENT_HOME
    try {
      const home = process.env.HOME?.trim()
      const expected = home
        ? join(home, ".minimal-agent", "auth.jsonc")
        : join(homedir(), ".minimal-agent", "auth.jsonc")
      expect(defaultAuthFilePath()).toBe(expected)
    } finally {
      if (prevFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
      else process.env.MINIMAL_AGENT_AUTH_FILE = prevFile
      if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prevHome
    }
  })

  it("honors a relocated MINIMAL_AGENT_HOME for the default", () => {
    const prevFile = process.env.MINIMAL_AGENT_AUTH_FILE
    const prevHome = process.env.MINIMAL_AGENT_HOME
    delete process.env.MINIMAL_AGENT_AUTH_FILE
    process.env.MINIMAL_AGENT_HOME = "/tmp/ma-auth-reloc"
    try {
      expect(defaultAuthFilePath()).toBe("/tmp/ma-auth-reloc/auth.jsonc")
    } finally {
      if (prevFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
      else process.env.MINIMAL_AGENT_AUTH_FILE = prevFile
      if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prevHome
    }
  })

  it("honors the MINIMAL_AGENT_AUTH_FILE override verbatim", () => {
    const prev = process.env.MINIMAL_AGENT_AUTH_FILE
    process.env.MINIMAL_AGENT_AUTH_FILE = "/tmp/custom-auth.jsonc"
    try {
      expect(defaultAuthFilePath()).toBe("/tmp/custom-auth.jsonc")
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
      else process.env.MINIMAL_AGENT_AUTH_FILE = prev
    }
  })
})

describe("normalizeProviderId", () => {
  it("lowercases and accepts dash-case ascii", () => {
    expect(normalizeProviderId("Acme")).toBe("acme")
    expect(normalizeProviderId(" Acme-Plan-OAuth ")).toBe("acme-plan-oauth")
    expect(normalizeProviderId("widget-api-key")).toBe("widget-api-key")
  })
  it("rejects spaces, unicode, leading/trailing/double dashes", () => {
    for (const bad of ["", "ac me", "-acme", "acme-", "a--b", "acmé", "a_b"]) {
      expect(() => normalizeProviderId(bad)).toThrow(AuthStoreError)
    }
  })
})

describe("AuthStore basic CRUD", () => {
  it("returns null/empty for a fresh (nonexistent) store", () => {
    const s = freshStore()
    expect(s.get("acme-plan-oauth")).toBeNull()
    expect(s.getSecrets("acme-plan-oauth")).toBeNull()
    expect(s.has("acme-plan-oauth")).toBe(false)
    expect(s.list()).toEqual([])
  })

  it("sets and reads back an opaque secret bag verbatim", () => {
    const s = freshStore()
    const bag = { accessToken: "AT", nested: { a: [1, 2, 3], b: null }, n: 42, ok: true }
    s.set("acme-plan-oauth", "Acme Plan (OAuth)", bag)
    expect(s.getSecrets("acme-plan-oauth")).toEqual(bag)
    const entry = s.get("acme-plan-oauth")!
    expect(entry.id).toBe("acme-plan-oauth")
    expect(entry.name).toBe("Acme Plan (OAuth)")
    expect(entry.createdAt).toBeDefined()
  })

  it("normalizes the provider id on write (case-insensitive lookups)", () => {
    const s = freshStore()
    s.set("Acme-Plan-OAuth", "X", { k: 1 })
    expect(s.getSecrets("acme-plan-oauth")).toEqual({ k: 1 })
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
    s.set("acme-enterprise-oauth", "Acme Enterprise (OAuth)", { org: "A" })
    s.set("acme-enterprise-oauth", "Acme Enterprise (OAuth) 2", { org: "B" })
    expect(s.list("acme-enterprise-oauth")).toHaveLength(2)
    expect(s.getSecrets("acme-enterprise-oauth", "Acme Enterprise (OAuth)")).toEqual({
      org: "A",
    })
    expect(s.getSecrets("acme-enterprise-oauth", "Acme Enterprise (OAuth) 2")).toEqual({
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

describe("AuthStore.suggestCredentialName (auto-naming)", () => {
  it("returns the base name as-is when the slug has no entries", () => {
    const s = freshStore()
    expect(s.suggestCredentialName("svc-a", "Service A")).toBe("Service A")
  })

  it("returns the base name when it is free (first login)", () => {
    const s = freshStore()
    s.set("svc-a", "Some Other Name", { v: 1 })
    expect(s.suggestCredentialName("svc-a", "Service A")).toBe("Service A")
  })

  it("auto-generates {serviceId}-2 when the base name is taken", () => {
    const s = freshStore()
    s.set("svc-a", "Service A", { v: 1 })
    expect(s.suggestCredentialName("svc-a", "Service A")).toBe("svc-a-2")
  })

  it("increments the suffix past existing generated names", () => {
    const s = freshStore()
    s.set("svc-a", "Service A", { v: 1 })
    s.set("svc-a", "svc-a-2", { v: 2 })
    expect(s.suggestCredentialName("svc-a", "Service A")).toBe("svc-a-3")
  })

  it("collision check is case-insensitive", () => {
    const s = freshStore()
    s.set("p", "MyName", { v: 1 })
    // "myname" collides with "MyName" — suggest the slug-based fallback
    expect(s.suggestCredentialName("p", "myname")).toBe("p-2")
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
    freshStore().set("acme-plan-oauth", "Acme Plan (OAuth)", { accessToken: "AT" })
    const text = readFileSync(path, "utf-8")
    expect(text).toContain("minimal-agent credential store")
    expect(text).toContain('"version": 1')
    // 0600 — owner rw only
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // a brand-new instance sees the persisted data
    expect(new AuthStore({ path }).getSecrets("acme-plan-oauth")).toEqual({
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
