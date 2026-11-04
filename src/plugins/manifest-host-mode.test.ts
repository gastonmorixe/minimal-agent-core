/**
 * Unit tests for `hostModes[]` manifest parsing (`manifest-host-mode.ts`),
 * through the real {@link parseManifest} entry.
 *
 * @module plugins/manifest-host-mode.test
 */

import { describe, expect, it } from "bun:test"

import { splitFlatManifest } from "../test-utils/split-manifest.ts"

import {
  ManifestError,
  type ParseManifestOptions,
  parseManifest as parseSplit,
} from "./manifest.ts"

/** Parse a fixture written in the short flat form (see `splitFlatManifest`). */
const parseManifest = (raw: unknown, path: string, opts?: ParseManifestOptions) =>
  parseSplit(splitFlatManifest(raw), path, opts)

const BASE = { id: "acp", name: "ACP", version: "0.1.0", description: "ACP host mode" }

function withHostModes(hostModes: unknown): unknown {
  return { ...BASE, hostModes }
}

function hostMode(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acp",
    description: "Agent Client Protocol over stdio",
    entry: { type: "module", path: "./host-mode.ts" },
    ...over,
  }
}

describe("parseManifest hostModes", () => {
  it("defaults to [] when omitted", () => {
    expect(parseManifest(BASE, "/fake/manifest.json").hostModes).toEqual([])
  })

  it("parses a valid entry, with and without permissions", () => {
    const m = parseManifest(
      withHostModes([hostMode(), hostMode({ id: "acp-2", permissions: ["net:fetch"] })]),
      "/fake/manifest.json",
    )
    const entry = { type: "module", path: "./host-mode.ts", export: "default" } as const
    expect(m.hostModes).toEqual([
      { id: "acp", description: "Agent Client Protocol over stdio", entry },
      {
        id: "acp-2",
        description: "Agent Client Protocol over stdio",
        entry,
        permissions: ["net:fetch"],
      },
    ])
  })

  it("rejects a non-array hostModes", () => {
    expect(() => parseManifest(withHostModes({}), "/fake/manifest.json")).toThrow(
      /hostModes must be an array/,
    )
  })

  it("rejects a bad id, a duplicate id, and a missing description", () => {
    expect(() =>
      parseManifest(withHostModes([hostMode({ id: "Bad Id" })]), "/fake/manifest.json"),
    ).toThrow(/host mode id must match/)
    expect(() =>
      parseManifest(withHostModes([hostMode(), hostMode()]), "/fake/manifest.json"),
    ).toThrow(/duplicate host mode id: acp/)
    expect(() =>
      parseManifest(withHostModes([hostMode({ description: undefined })]), "/fake/manifest.json"),
    ).toThrow(ManifestError)
  })

  it("rejects a subprocess entry: a host mode must be a module", () => {
    expect(() =>
      parseManifest(
        withHostModes([hostMode({ entry: { type: "subprocess", command: ["node", "x.js"] } })]),
        "/fake/manifest.json",
      ),
    ).toThrow(ManifestError)
  })

  it("copies valid args and examples (SPEC-HELP R-20)", () => {
    const warnings: string[] = []
    const args = [{ name: "port", summary: "Port", required: true }]
    const examples = [{ argv: "--host-mode acp", summary: "Run ACP" }]
    const m = parseManifest(withHostModes([hostMode({ args, examples })]), "/fake/manifest.json", {
      warn: (s) => warnings.push(s),
    })
    expect(warnings).toEqual([])
    expect(m.hostModes?.[0]?.args).toEqual(args)
    expect(m.hostModes?.[0]?.examples).toEqual(examples)
  })

  it("drops bad args or examples with a warning and keeps the host mode", () => {
    const warnings: string[] = []
    const m = parseManifest(
      withHostModes([hostMode({ args: [{ name: "Bad Name", summary: "x" }], examples: "x" })]),
      "/fake/manifest.json",
      { warn: (s) => warnings.push(s) },
    )
    expect(m.hostModes?.[0]?.id).toBe("acp")
    expect(m.hostModes?.[0]).not.toHaveProperty("args")
    expect(m.hostModes?.[0]).not.toHaveProperty("examples")
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/hostModes\[0\]\.args dropped \(host mode still loads\)/)
    expect(warnings[1]).toMatch(/hostModes\[0\]\.examples dropped .*must be an array/)
  })

  it("replaces a description with control, bidi, or over-long text by '' and keeps the host mode (R-19)", () => {
    const bad = [
      `${String.fromCodePoint(0x1b)}[31mred`,
      `a${String.fromCodePoint(0x9b)}b`,
      `a${String.fromCodePoint(0x202e)}b`,
      "x".repeat(81),
    ]
    for (const description of bad) {
      const warnings: string[] = []
      const m = parseManifest(withHostModes([hostMode({ description })]), "/fake/manifest.json", {
        warn: (s) => warnings.push(s),
      })
      expect(m.hostModes?.[0]?.id).toBe("acp")
      expect(m.hostModes?.[0]?.description).toBe("")
      expect(m.hostModes?.[0]?.entry.type).toBe("module")
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(
        /\/fake\/manifest\.json: hostModes\[0\]\.description dropped \(host mode still loads\)/,
      )
    }
  })

  it("keeps a description at the 80-character cap with no warning", () => {
    const warnings: string[] = []
    const description = "x".repeat(80)
    const m = parseManifest(withHostModes([hostMode({ description })]), "/fake/manifest.json", {
      warn: (s) => warnings.push(s),
    })
    expect(warnings).toEqual([])
    expect(m.hostModes?.[0]?.description).toBe(description)
  })

  it("rejects permissions that are not non-empty strings", () => {
    expect(() =>
      parseManifest(withHostModes([hostMode({ permissions: "x" })]), "/fake/manifest.json"),
    ).toThrow(/permissions must be an array/)
    expect(() =>
      parseManifest(withHostModes([hostMode({ permissions: [""] })]), "/fake/manifest.json"),
    ).toThrow(/non-empty strings/)
  })
})
