import { describe, expect, it } from "bun:test"

import * as pluginApi from "@minimal-agent/core/plugin-api"

import type { ToolResultPhase } from "./tool-result-chain.ts"
import {
  CORE_ANNOTATION_KINDS,
  type CoreAnnotationKind,
  TOOL_OUTCOME_FIELD_TABLE,
  type ToolAnnotation,
  type ToolOutcome,
  type ToolOutcomeField,
} from "./tool-outcome.ts"

/** Phase order of the chain (SPEC v6.1 D4). */
const PHASES = [
  "clamp",
  "pre-outcome",
  "post-blob",
  "final",
  "stamp",
] as const satisfies readonly ToolResultPhase[]
type MissingPhase = Exclude<ToolResultPhase, (typeof PHASES)[number]>
const _allPhases: [MissingPhase] extends [never] ? true : never = true

/** Core annotation kinds (SPEC v6.1 D4 owner rule 3), in SPEC order. */
const CORE_KINDS = [
  "mode-active",
  "policy",
  "raw-output",
  "output-preview",
  "output-truncated",
  "output-streak",
  "diagnostics",
] as const satisfies readonly CoreAnnotationKind[]
type MissingKind = Exclude<CoreAnnotationKind, (typeof CORE_KINDS)[number]>
const _allKinds: [MissingKind] extends [never] ? true : never = true

/** One field of the field table, as written in the SPEC, row by row. */
const SPEC_ROWS: Record<ToolOutcomeField, string> = {
  "body.text": "yes yes yes no no",
  "body.data": "no yes yes no no",
  "body.schema": "no yes yes no no",
  media: "no no no no no",
  annotations: "own own own own own",
  isError: "no yes no no no",
  aborted: "no no no no no",
  truncInfo: "yes no no no no",
  rawForBlob: "yes yes no no no",
  blob: "no no no no no",
  hostHints: "no no yes yes no",
  kind: "no no no no yes",
}

describe("plugin-api tool-outcome types (SPEC v6.1 D2, D4)", () => {
  it("keeps the phase and kind lists in sync with the types", () => {
    expect(_allPhases).toBe(true)
    expect(_allKinds).toBe(true)
  })

  it("matches the D4 field table cell by cell", () => {
    expect(Object.keys(TOOL_OUTCOME_FIELD_TABLE).sort()).toEqual(Object.keys(SPEC_ROWS).sort())
    for (const [field, row] of Object.entries(SPEC_ROWS)) {
      const cells = PHASES.map((p) => TOOL_OUTCOME_FIELD_TABLE[field as ToolOutcomeField][p])
      expect(cells.join(" "), field).toBe(row)
    }
  })

  it("is deep-frozen at runtime (m-5)", () => {
    expect(Object.isFrozen(TOOL_OUTCOME_FIELD_TABLE)).toBe(true)
    for (const row of Object.values(TOOL_OUTCOME_FIELD_TABLE)) expect(Object.isFrozen(row)).toBe(true)
    expect(() => {
      ;(TOOL_OUTCOME_FIELD_TABLE.media as Record<string, string>).final = "yes"
    }).toThrow(TypeError)
    expect(TOOL_OUTCOME_FIELD_TABLE.media.final).toBe("no")
  })

  it("is exported from the plugin-api root", () => {
    expect(pluginApi.TOOL_OUTCOME_FIELD_TABLE).toBe(TOOL_OUTCOME_FIELD_TABLE)
    expect(pluginApi.CORE_ANNOTATION_KINDS).toBe(CORE_ANNOTATION_KINDS)
  })

  it("CORE_ANNOTATION_KINDS: the SPEC names in SPEC order, frozen", () => {
    expect([...CORE_ANNOTATION_KINDS]).toEqual([...CORE_KINDS])
    expect(Object.isFrozen(CORE_ANNOTATION_KINDS)).toBe(true)
    expect(() => {
      ;(CORE_ANNOTATION_KINDS as unknown as string[]).push("x")
    }).toThrow(TypeError)
    expect(CORE_ANNOTATION_KINDS.length).toBe(7)
  })

  it("accepts the text and data body arms", () => {
    const ann: ToolAnnotation = { kind: "raw-output", text: "<x/>", join: "\n\n", owner: "core" }
    const textOutcome: ToolOutcome = {
      body: { text: "ok" },
      annotations: [ann],
      isError: false,
      aborted: false,
    }
    const dataOutcome: ToolOutcome = {
      body: { data: { a: 1 }, text: '{\n  "a": 1\n}' },
      annotations: [],
      isError: false,
      aborted: false,
    }
    expect(textOutcome.body.text).toBe("ok")
    expect("data" in dataOutcome.body).toBe(true)
  })
})
