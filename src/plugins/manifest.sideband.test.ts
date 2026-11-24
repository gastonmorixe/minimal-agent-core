import { describe, expect, test } from "bun:test"

import { parseManifest } from "./manifest.ts"
import { ManifestError } from "./manifest-helpers.ts"

const base = { id: "p1", name: "P", version: "1.0.0", description: "d" }
const kind = {
  kind: "note",
  direction: "to-model",
  placement: "turn",
  attrs: { id: { type: "string", required: true } },
  body: "text",
  trust: "harness",
  summary: "s",
}
const parse = (extra: Record<string, unknown>, warn: (m: string) => void = () => {}) =>
  parseManifest({ ...base, ...extra }, "/x/manifest.json", { warn })

describe("manifest sideband keys", () => {
  test("valid sideband parses and round trips", () => {
    const m = parse({ sideband: [kind] })
    expect(m.sideband).toEqual([kind as never])
  })
  test("absent keys leave the manifest unchanged", () => {
    const m = parse({})
    expect("sideband" in m).toBe(false)
    expect("sidebandCodec" in m).toBe(false)
  })
  test("non-array is rejected", () => {
    expect(() => parse({ sideband: {} })).toThrow(ManifestError)
  })
  test("missing kind skips the entry and keeps the others", () => {
    const { kind: _k, ...noKind } = kind
    const warns: string[] = []
    const m = parse({ sideband: [noKind, kind] }, (w) => warns.push(w))
    expect(m.sideband).toEqual([kind as never])
    expect(warns).toEqual(["sideband[0]:kind"])
  })
  test("bad attr type skips the entry", () => {
    const bad = { ...kind, attrs: { id: { type: "float" } } }
    const warns: string[] = []
    const m = parse({ sideband: [bad, kind] }, (w) => warns.push(w))
    expect(m.sideband).toEqual([kind as never])
    expect(warns).toEqual(["sideband[0]:attrs.type"])
  })
  test("non-object entry is skipped", () => {
    const m = parse({ sideband: [7, kind] })
    expect(m.sideband).toEqual([kind as never])
  })
  test("owner is dropped with one diagnostic", () => {
    const warns: string[] = []
    const m = parse({ sideband: [{ ...kind, owner: "evil" }] }, (w) => warns.push(w))
    expect(m.sideband?.[0]).not.toHaveProperty("owner")
    expect(warns).toHaveLength(1)
  })
  test("sidebandCodec parses", () => {
    const m = parse({ sidebandCodec: { id: "c", entry: "./c.ts" } })
    expect(m.sidebandCodec).toEqual({ id: "c", entry: "./c.ts" })
  })
  test("display: module handler parses", () => {
    const display = {
      handler: { type: "module", path: "./handlers/display.ts", export: "default" },
      host: true,
    }
    const warns: string[] = []
    const m = parse({ sideband: [{ ...kind, display }] }, (w) => warns.push(w))
    expect(m.sideband?.[0]?.display).toEqual(display as never)
    expect(warns).toEqual([])
  })
  test("display: subprocess is rejected, kind kept", () => {
    const display = { handler: { type: "subprocess", path: "./d.sh" } }
    const warns: string[] = []
    const m = parse({ sideband: [{ ...kind, display }] }, (w) => warns.push(w))
    expect(m.sideband).toEqual([kind as never])
    expect(warns).toEqual(["sideband[0]:display"])
  })
  test("display: unknown key warns", () => {
    const warns: string[] = []
    const m = parse(
      { sideband: [{ ...kind, display: { handler: { type: "module", path: "./d.ts" }, x: 1 } }] },
      (w) => warns.push(w),
    )
    expect(m.sideband?.[0]).not.toHaveProperty("display")
    expect(m.sideband?.[0]?.kind).toBe("note")
    expect(warns).toEqual(["sideband[0]:display"])
  })
  test("display: bad host type warns", () => {
    const warns: string[] = []
    const m = parse(
      {
        sideband: [
          { ...kind, display: { handler: { type: "module", path: "./d.ts" }, host: "yes" } },
        ],
      },
      (w) => warns.push(w),
    )
    expect(m.sideband).toEqual([kind as never])
    expect(warns).toEqual(["sideband[0]:display"])
  })
  test("display: a named export or an empty path warns", () => {
    for (const handler of [
      { type: "module", path: "./d.ts", export: "named" },
      { type: "module", path: "" },
    ]) {
      const warns: string[] = []
      const m = parse({ sideband: [{ ...kind, display: { handler } }] }, (w) => warns.push(w))
      expect(m.sideband).toEqual([kind as never])
      expect(warns).toEqual(["sideband[0]:display"])
    }
  })
  test("bad sidebandCodec is rejected", () => {
    expect(() => parse({ sidebandCodec: { id: "c" } })).toThrow(ManifestError)
  })
})
