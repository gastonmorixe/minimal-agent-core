/** Tests for the sub-agent target control channel: signature, read checks, follow rule. */

import { describe, expect, it } from "bun:test"

import {
  type ControlTarget,
  controlKeyId,
  controlPathFor,
  deriveControlKey,
  MAX_CONTROL_LINE_BYTES,
  readSwitchLines,
  signSwitchLine,
} from "./target-control.ts"

// Known-answer vectors. `KAT_FULL` was also made with `openssl dgst -sha256 -hmac`.
const KAT_KEY = "61205dcd71193f4cb7f791732bfd26bf3af2443a77e60907d43bb75fdd391973"
const KAT_KEY_ID = "0ae3441ba893668b"
const KAT_FULL = "cf43f30e71171d0140115bad56c6d355d76c838e395c5d2b0b468c160b1b0693"
const KAT_UNICODE = "6aa67c90f1f99d5809cdf8e12fbc38288e7712a6c477bb76596544bccdb431c5"

const SECRET = "lead-secret"
const LEAD = "ba0ad20f-1111-4111-8111-111111111111"
const CHILD = "d17b0257-2222-4222-8222-222222222222"
const KEY = deriveControlKey(SECRET, CHILD)

const A: ControlTarget = { credentialName: "full", providerId: "p1", model: "m1", effort: "high" }
const B: ControlTarget = { credentialName: "second", providerId: "p2", model: "m2", effort: "low" }

const line = (seq: number, from = A, to = B, key = KEY, lead = LEAD) =>
  signSwitchLine(key, { seq, ts: "2026-11-17T00:00:00.000Z", lead, from, to })
const text = (...lines: object[]): string => lines.map((l) => `${JSON.stringify(l)}\n`).join("")
const read = (t: string, afterSeq = 0) => readSwitchLines(t, { key: KEY, lead: LEAD, afterSeq })

describe("keys", () => {
  it("each worker has its own key, and the key id does not give the secret", () => {
    expect(KEY).toMatch(/^[0-9a-f]{64}$/)
    expect(deriveControlKey(SECRET, "other-child")).not.toBe(KEY)
    expect(deriveControlKey("other-secret", CHILD)).not.toBe(KEY)
    expect(controlKeyId(SECRET)).toMatch(/^[0-9a-f]{16}$/)
    expect(controlKeyId(SECRET)).not.toBe(controlKeyId("other-secret"))
    expect(KEY).not.toContain(controlKeyId(SECRET))
    expect(controlPathFor("/s", CHILD)).toBe(`/s/${CHILD}.control.jsonl`)
  })
})

describe("readSwitchLines", () => {
  it("accepts signed lines in order and gives the last seq", () => {
    const result = read(text(line(1), line(2, B, A)))
    expect(result.rejects).toEqual([])
    expect(result.lines.map((l) => l.seq)).toEqual([1, 2])
    expect(result.lines[0]?.to).toEqual(B)
    expect(result.lastSeq).toBe(2)
  })

  it("a line has no token, key or endpoint field", () => {
    expect(Object.keys(line(1)).sort()).toEqual(
      ["from", "kind", "lead", "mac", "seq", "to", "ts", "v"].sort(),
    )
    expect(JSON.stringify(line(1))).not.toContain(KEY)
  })

  it("rejects a line that an other party wrote (no key, wrong key, key of an other worker)", () => {
    const forged = { ...line(1), mac: "00".repeat(32) }
    const wrongKey = line(1, A, B, deriveControlKey("attacker", CHILD))
    const otherChild = line(1, A, B, deriveControlKey(SECRET, "other-child"))
    const noMac = { ...line(1), mac: "" }
    expect(read(text(forged, wrongKey, otherChild, noMac))).toEqual({
      lines: [],
      rejects: ["bad_mac", "bad_mac", "bad_mac", "bad_mac"],
      lastSeq: 0,
    })
  })

  it("rejects a signed line after any field changed (each field is in the mac)", () => {
    const good = line(5)
    const edits: object[] = [
      { ...good, seq: 6 },
      { ...good, ts: "2027-01-01T00:00:00.000Z" },
      { ...good, lead: "other-lead" },
      { ...good, to: { ...good.to, credentialName: "attacker" } },
      { ...good, to: { ...good.to, providerId: "evil" } },
      { ...good, to: { ...good.to, model: "other" } },
      { ...good, to: { ...good.to, effort: "max" } },
      { ...good, from: { ...good.from, credentialName: "x" } },
    ]
    const result = read(text(...edits))
    expect(result.lines).toEqual([])
    expect(result.rejects).toEqual(edits.map(() => "bad_mac"))
  })

  it("a name with a separator cannot look like two fields", () => {
    const one = line(1, { model: "a", credentialName: 'x","y' }, B)
    const two = { ...one, from: { model: "a", credentialName: "x", providerId: "y" } }
    expect(read(text(two)).rejects).toEqual(["bad_mac"])
    expect(read(text(one)).lines).toHaveLength(1)
  })

  it("keeps unicode names and round-trips them", () => {
    const from: ControlTarget = { credentialName: "josé@例え.jp ✓", providerId: "p1", model: "m1" }
    const result = read(text(line(1, from, B)))
    expect(result.rejects).toEqual([])
    expect(result.lines[0]?.from.credentialName).toBe("josé@例え.jp ✓")
  })

  it("rejects a line from an other lead, and an old or repeated seq (replay)", () => {
    const otherLead = line(1, A, B, KEY, "other-lead")
    expect(read(text(otherLead)).rejects).toEqual(["wrong_lead"])
    expect(read(text(line(3)), 3).rejects).toEqual(["old_seq"])
    expect(read(text(line(2)), 3).rejects).toEqual(["old_seq"])
    // The same line two times in one file: the second is a replay.
    const result = read(text(line(4), line(4)), 3)
    expect(result.lines.map((l) => l.seq)).toEqual([4])
    expect(result.rejects).toEqual(["old_seq"])
  })

  it("a bad line does not stop the next lines", () => {
    const huge = "x".repeat(MAX_CONTROL_LINE_BYTES + 1)
    const future = { ...line(9), kind: "future_kind" }
    const input = `not json\n${huge}\n[1,2]\n{"v":1}\n${JSON.stringify(future)}\n\n${text(line(1))}`
    const result = read(input)
    expect(result.rejects).toEqual(["bad_json", "too_long", "bad_shape", "bad_shape", "unknown_kind"])
    expect(result.lines.map((l) => l.seq)).toEqual([1])
  })

  it("rejects wrong field types before any use", () => {
    const good = line(1)
    const bad: object[] = [
      { ...good, seq: "1" },
      { ...good, seq: 1.5 },
      { ...good, to: { model: "" } },
      { ...good, to: { model: "m", providerId: 7 } },
      { ...good, from: null },
      { ...good, mac: 5 },
    ]
    expect(read(text(...bad)).rejects).toEqual(bad.map(() => "bad_shape"))
  })
})

describe("known-answer vectors (the lead and the worker must make the same bytes)", () => {
  // Fixed inputs and the mac they must give. A change of the mac input
  // format breaks these on purpose: an old and a new build would not agree.
  const VECTOR_KEY = deriveControlKey("vector-secret", "vector-child")

  it("the key derivation is fixed", () => {
    expect(VECTOR_KEY).toBe(KAT_KEY)
    expect(controlKeyId("vector-secret")).toBe(KAT_KEY_ID)
  })

  it("a line with all fields", () => {
    const signed = signSwitchLine(VECTOR_KEY, {
      seq: 7,
      ts: "2026-11-17T12:00:00.000Z",
      lead: "vector-lead",
      from: { credentialName: "full", providerId: "p1", model: "m1", effort: "high" },
      to: { credentialName: "second", providerId: "p2", model: "m2", effort: "low" },
    })
    expect(signed.mac).toBe(KAT_FULL)
  })

  it("unicode names, and a target with no credential, provider or effort (null in the mac)", () => {
    const signed = signSwitchLine(VECTOR_KEY, {
      seq: 9007199254740991,
      ts: "2026-11-17T12:00:00.000Z",
      lead: "vector-lead",
      from: { credentialName: "josé@例え.jp ✓", providerId: "p1", model: "m1[1m]" },
      to: { model: "m2" },
    })
    expect(signed.mac).toBe(KAT_UNICODE)
    expect(signed.to).toEqual({ model: "m2" })
  })
})
