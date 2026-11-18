import { describe, expect, it } from "bun:test"

import {
  PERSISTED_TOOL_OUTCOME_VERSION,
  type PersistedToolOutcome,
  TOOL_OUTCOME_DATA_INLINE_MAX_BYTES,
} from "./tool-outcome-record.ts"

describe("PersistedToolOutcome (SPEC v6.1 D8)", () => {
  it("has version 1 and the D-F inline cap of 16000 bytes", () => {
    expect(PERSISTED_TOOL_OUTCOME_VERSION).toBe(1)
    expect(TOOL_OUTCOME_DATA_INLINE_MAX_BYTES).toBe(16_000)
  })

  it("a record is plain JSON and holds no text field", () => {
    const rec: PersistedToolOutcome = {
      v: 1,
      bodyEnd: 4,
      annotations: [{ kind: "raw-output", attrs: { bytes: 9 }, start: 6, end: 20 }],
      data: { n: 1 },
      schema: { type: "object" },
    }
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec)
    expect(Object.keys(rec)).not.toContain("text")
    expect(Object.keys(rec)).not.toContain("hostHints")
    expect(Object.keys(rec)).not.toContain("truncInfo")
  })
})
