/**
 * Board item 42: `parseMode` must keep a mode's `permissions`, or the
 * ModeManager gate falls back to "allow everything" and ask mode runs
 * Edit and Write.
 *
 * @module plugins/manifest-mode-permissions.test
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { buildEffectiveModePermissions, ModeManager } from "../modes/modes.ts"

import { parseManifest } from "./manifest.ts"
import { ModePermissionsInvalidError } from "./manifest-mode-permissions.ts"
import type { ManifestMode } from "./types.ts"

const ASK_MANIFEST = join(
  import.meta.dir,
  "../../../minimal-agent-plugins/ma-ask-mode-plugin/manifest.json",
)
const HAS_ASK_PLUGIN = existsSync(ASK_MANIFEST)

const withModes = (modes: unknown[]) => ({
  id: "p",
  name: "P",
  version: "0.1.0",
  description: "d",
  headless: { modes },
})

const parseModes = (modes: unknown[]): ManifestMode[] =>
  parseManifest(withModes(modes), "/x/manifest.json").modes ?? []

const parseAskMode = (): ManifestMode => {
  const raw: unknown = JSON.parse(readFileSync(ASK_MANIFEST, "utf8"))
  const mode = parseManifest(raw, ASK_MANIFEST).modes?.find((m) => m.id === "ask")
  if (!mode) throw new Error("ask mode missing from the ask plugin manifest")
  return mode
}

const OLD_SHAPE = { allow: ["*"], deny: ["Edit", "Write"] }
const ARRAY_SHAPE = [
  { tool: "*", allow: true },
  { tool: "Edit", allow: false },
  { tool: "Grep", allow: "match", refusalHint: "h" },
]

describe("parseMode keeps permissions (item 42)", () => {
  it("keeps the old {allow, deny} object", () => {
    expect(parseModes([{ id: "m", permissions: OLD_SHAPE }])[0]?.permissions).toEqual(
      OLD_SHAPE as unknown as ManifestMode["permissions"],
    )
  })

  it("keeps the ToolPermission[] array", () => {
    expect(parseModes([{ id: "m", permissions: ARRAY_SHAPE }])[0]?.permissions).toEqual(
      ARRAY_SHAPE as ManifestMode["permissions"],
    )
  })

  it("leaves permissions undefined when the mode declares none", () => {
    expect(parseModes([{ id: "m" }])[0]?.permissions).toBeUndefined()
  })
})

describe.skipIf(!HAS_ASK_PLUGIN)("real ask mode manifest (sibling plugins checkout)", () => {
  it("parses deny equal to [Edit, Write]", () => {
    const perms = parseAskMode().permissions as unknown as { deny?: string[] }
    expect(perms.deny).toEqual(["Edit", "Write"])
  })

  it("ModeManager in ask refuses Edit and Write and allows Bash and Read", () => {
    const mgr = new ModeManager([parseAskMode()], "ask")
    expect(mgr.effectivePermissions("ask")?.source).toBe("manifest")
    expect(mgr.isToolAllowed("Edit").allowed).toBe(false)
    expect(mgr.isToolAllowed("Write").allowed).toBe(false)
    expect(mgr.isToolAllowed("Bash")).toEqual({ allowed: true })
    expect(mgr.isToolAllowed("Read")).toEqual({ allowed: true })
  })

  it("a user override gives the same result as before the fix", () => {
    const parsed = parseAskMode()
    const { permissions: _dropped, ...beforeFix } = parsed
    const overrides = [
      { permissions: { deny: ["Write"] } },
      { permissions: { allow: ["Read"], deny: ["Bash"] } },
    ]
    for (const o of overrides) {
      expect(buildEffectiveModePermissions(parsed, o)).toEqual(
        buildEffectiveModePermissions(beforeFix, o),
      )
    }
    const mgr = new ModeManager([parsed], "ask", undefined, undefined, () => overrides[0] ?? null)
    expect(mgr.isToolAllowed("Edit")).toEqual({ allowed: true })
    expect(mgr.isToolAllowed("Write").allowed).toBe(false)
  })
})

describe("bad permissions shape gives a typed ManifestError", () => {
  const cases: [string, unknown, "allow" | "deny" | null, number | null][] = [
    ["a string", "Edit", null, null],
    ["a number", 3, null, null],
    ["array entry not an object", ["Edit"], null, 0],
    ["array entry with empty tool", [{ tool: "", allow: true }], null, 0],
    [
      "array entry with a bad allow",
      [
        { tool: "*", allow: true },
        { tool: "E", allow: "no" },
      ],
      null,
      1,
    ],
    ["array entry with a bad refusalHint", [{ tool: "E", allow: false, refusalHint: 1 }], null, 0],
    ["deny not an array", { deny: "Edit" }, "deny", null],
    ["allow entry not a string", { allow: ["*", 2] }, "allow", 1],
    ["deny entry empty", { deny: [""] }, "deny", 0],
  ]
  for (const [name, permissions, key, entryIndex] of cases) {
    it(name, () => {
      let caught: unknown
      try {
        parseModes([{ id: "ok" }, { id: "m", permissions }])
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(ModePermissionsInvalidError)
      const err = caught as ModePermissionsInvalidError
      expect(err.kind).toBe("ModePermissionsInvalidError")
      expect(err.message).toBe("")
      expect(err.manifestPath).toBe("/x/manifest.json")
      expect(err.modeIndex).toBe(1)
      expect(err.key).toBe(key)
      expect(err.entryIndex).toBe(entryIndex)
    })
  }
})
