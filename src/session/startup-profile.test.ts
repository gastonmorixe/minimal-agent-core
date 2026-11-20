import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import type { StartupProfile } from "@minimal-agent/core/plugin-api/types/startup-profile"

import {
  namePolicyFromTools,
  parseStartupProfile,
  readStartupProfileFile,
  serializeStartupProfile,
  startupProfilePath,
  toolsFromNamePolicy,
  writeStartupProfileFile,
} from "./startup-profile.ts"

const TMP_ROOT = join(import.meta.dirname, "..", "..", "tmp")
mkdirSync(TMP_ROOT, { recursive: true })
const DIR = mkdtempSync(join(TMP_ROOT, "startup-profile-"))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

const FULL: StartupProfile = {
  version: 1,
  systemPrompt: {
    identity: { kind: "replace", text: "You are X.\nLine 2" },
    providerPreamble: { kind: "omit" },
    toolOutputConventions: { kind: "default" },
    unsafeProviderOverrides: true,
  },
  noAgentsMd: true,
  pluginPrompts: { all: false, suppress: ["zeta", "alpha"], keep: ["k"] },
  plugins: { disable: ["intercom", "agents-md"], enable: ["b"] },
  bare: true,
  tools: { kind: "list", names: ["Write", "Read"] },
}

function base(): Record<string, unknown> {
  return JSON.parse(serializeStartupProfile(FULL)) as Record<string, unknown>
}

describe("startup profile codec", () => {
  it("round-trips through serialize + parse, with sorted id arrays", () => {
    const text = serializeStartupProfile(FULL)
    expect(text.endsWith("}\n")).toBe(true)
    const parsed = parseStartupProfile(JSON.parse(text))
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.value.systemPrompt).toEqual(FULL.systemPrompt)
    expect(parsed.value.pluginPrompts.suppress).toEqual(["alpha", "zeta"])
    expect(parsed.value.plugins.disable).toEqual(["agents-md", "intercom"])
    expect(parsed.value.tools).toEqual({ kind: "list", names: ["Read", "Write"] })
    expect(serializeStartupProfile(parsed.value)).toBe(text)
  })

  it("rejects a wrong or missing version", () => {
    for (const version of [2, 0, "1", undefined]) {
      const r = parseStartupProfile({ ...base(), version })
      expect(r).toMatchObject({ ok: false, code: "unsupported-version" })
    }
  })

  it("rejects a non-object root", () => {
    expect(parseStartupProfile([])).toMatchObject({ ok: false, code: "not-object" })
    expect(parseStartupProfile(null)).toMatchObject({ ok: false, code: "not-object" })
  })

  it("rejects unknown keys and unknown prompt part names", () => {
    expect(parseStartupProfile({ ...base(), extra: 1 })).toMatchObject({
      ok: false,
      code: "unknown-field",
      field: "extra",
    })
    const sp = { ...base(), systemPrompt: { bogus: { kind: "omit" } } }
    expect(parseStartupProfile(sp)).toMatchObject({
      ok: false,
      code: "unknown-field",
      field: "systemPrompt.bogus",
    })
  })

  it("rejects mistyped fields with the JSON path", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ noAgentsMd: "yes" }, "noAgentsMd"],
      [{ bare: 1 }, "bare"],
      [{ pluginPrompts: { all: true, suppress: [""], keep: [] } }, "pluginPrompts.suppress[0]"],
      [{ pluginPrompts: { suppress: [], keep: [] } }, "pluginPrompts.all"],
      [{ plugins: { disable: [3], enable: [] } }, "plugins.disable[0]"],
      [{ tools: { kind: "some" } }, "tools.kind"],
      [{ tools: { kind: "list" } }, "tools.names"],
      [{ systemPrompt: { full: { kind: "replace" } } }, "systemPrompt.full.text"],
    ]
    for (const [patch, field] of cases) {
      const r = parseStartupProfile({ ...base(), ...patch })
      expect(r).toMatchObject({ ok: false, code: "invalid-field", field })
      if (!r.ok) expect(r.error).toBe(`invalid-field ${field}`)
    }
  })

  it("carries the optional prompt-cache flags (M3); absent stays absent", () => {
    const withCache: StartupProfile = { ...FULL, cacheAnchor: true, thinkingHistory: "keep" }
    const text = serializeStartupProfile(withCache)
    const parsed = parseStartupProfile(JSON.parse(text))
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.value.cacheAnchor).toBe(true)
    expect(parsed.value.thinkingHistory).toBe("keep")
    expect(serializeStartupProfile(parsed.value)).toBe(text)
    // An older profile has no cache keys: it parses and writes the same bytes.
    const old = parseStartupProfile(base())
    if (!old.ok) throw new Error(old.error)
    expect("cacheAnchor" in old.value).toBe(false)
    expect("thinkingHistory" in old.value).toBe(false)
    expect(serializeStartupProfile(old.value)).toBe(serializeStartupProfile(FULL))
    for (const [patch, field] of [
      [{ cacheAnchor: "1" }, "cacheAnchor"],
      [{ thinkingHistory: "all" }, "thinkingHistory"],
    ] as const) {
      expect(parseStartupProfile({ ...base(), ...patch })).toMatchObject({
        ok: false,
        code: "invalid-field",
        field,
      })
    }
  })

  it("converts tool name policies both ways", () => {
    expect(toolsFromNamePolicy(null)).toEqual({ kind: "all" })
    expect(toolsFromNamePolicy({ kind: "deny-all" })).toEqual({ kind: "none" })
    expect(toolsFromNamePolicy({ kind: "allow-list", tools: ["A"] })).toEqual({
      kind: "list",
      names: ["A"],
    })
    expect(namePolicyFromTools({ kind: "all" })).toBeNull()
    expect(namePolicyFromTools({ kind: "none" })).toEqual({ kind: "deny-all" })
    expect(namePolicyFromTools({ kind: "list", names: ["A"] })).toEqual({
      kind: "allow-list",
      tools: ["A"],
    })
  })
})

describe("startup profile files", () => {
  it("builds the sidecar path", () => {
    expect(startupProfilePath("/s", "abc")).toBe(join("/s", "abc.profile.json"))
  })

  it("writes 0600 and reads back", () => {
    const p = startupProfilePath(DIR, "sid-1")
    writeStartupProfileFile(p, FULL)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    const r = readStartupProfileFile(p)
    if (!r.ok) throw new Error(r.error)
    expect(r.value.bare).toBe(true)
  })

  it("reports a missing file", () => {
    expect(readStartupProfileFile(join(DIR, "none.json"))).toMatchObject({
      ok: false,
      code: "not-found",
    })
  })

  it("reports invalid JSON", () => {
    const p = join(DIR, "bad.json")
    writeFileSync(p, "{ not json")
    expect(readStartupProfileFile(p)).toMatchObject({ ok: false, code: "invalid-json" })
  })
})
