import { describe, expect, test } from "bun:test"

import type {
  ToolResultPhase,
  ToolResultStage,
  ToolResultTransformDecl,
} from "../../plugin-api/src/types/tool-result-chain.ts"
import { createSidebandRegistry } from "../sideband/registry.ts"

import {
  applyStageKind,
  orderStages,
  runChain,
  runPhase,
  validateChain,
} from "./tool-result-chain.ts"

const base: ToolResultStage = {
  tool: "t",
  toolUseId: "u",
  input: {},
  content: "",
  isError: false,
  aborted: false,
  diagnosticNotes: [],
  policyNotes: [],
}

const add =
  (s: string) =>
  (st: ToolResultStage): ToolResultStage => ({ ...st, content: st.content + s })

function entry(
  pluginId: string,
  phase: ToolResultPhase,
  order: number,
  tag: string,
  async = false,
) {
  const decl: ToolResultTransformDecl = {
    phase,
    order,
    transform: async ? (st) => Promise.resolve(add(tag)(st)) : add(tag),
  }
  return { pluginId, decl }
}

describe("orderStages", () => {
  test("sorts by ascending order", () => {
    const out = orderStages([entry("a", "final", 2, "x"), entry("a", "final", 1, "y")])
    expect(out.map((e) => e.decl.order)).toEqual([1, 2])
  })
  test("ties break by plugin id", () => {
    const out = orderStages([entry("b", "final", 1, "x"), entry("a", "final", 1, "y")])
    expect(out.map((e) => e.pluginId)).toEqual(["a", "b"])
  })
  test("tie break is byte order, not locale order", () => {
    // Locale order puts "e" < "é"... and "Z" after "a". Byte order puts "Z" (0x5a) before "a" (0x61).
    const out = orderStages([entry("a", "final", 1, "x"), entry("Z", "final", 1, "y")])
    expect(out.map((e) => e.pluginId)).toEqual(["Z", "a"])
    const non = orderStages([entry("\u00e9", "final", 1, "x"), entry("f", "final", 1, "y")])
    expect(non.map((e) => e.pluginId)).toEqual(["f", "\u00e9"])
  })
  test("does not mutate input", () => {
    const input = [entry("b", "final", 1, "x"), entry("a", "final", 1, "y")]
    orderStages(input)
    expect(input[0]?.pluginId).toBe("b")
  })
})

describe("runPhase", () => {
  test("returns the same object when no stage matches", async () => {
    const out = await runPhase("clamp", base, [entry("a", "final", 1, "x")])
    expect(out).toBe(base)
  })
  test("output feeds the next transform", async () => {
    const out = await runPhase("final", base, [
      entry("a", "final", 2, "B"),
      entry("a", "final", 1, "A"),
    ])
    expect(out.content).toBe("AB")
  })
  test("awaits async transforms", async () => {
    const out = await runPhase("final", base, [
      entry("a", "final", 1, "A", true),
      entry("a", "final", 2, "B"),
    ])
    expect(out.content).toBe("AB")
  })
  test("a throwing transform propagates unchanged", async () => {
    const boom = new Error("boom")
    const bad = {
      pluginId: "a",
      decl: {
        phase: "final" as const,
        order: 1,
        transform: () => {
          throw boom
        },
      },
    }
    await expect(runPhase("final", base, [bad])).rejects.toBe(boom)
  })
})

describe("runChain", () => {
  test("runs phases in the fixed order", async () => {
    const entries = [
      entry("a", "stamp", 1, "5"),
      entry("a", "final", 1, "4"),
      entry("a", "post-blob", 1, "3"),
      entry("a", "pre-outcome", 1, "2"),
      entry("a", "clamp", 1, "1"),
    ]
    const out = await runChain(base, entries)
    expect(out.content).toBe("12345")
  })
})

describe("validateChain", () => {
  test("passes a valid chain", () => {
    expect(validateChain([entry("a", "clamp", 1, "x"), entry("a", "stamp", 1, "y")])).toEqual({
      ok: true,
      violations: [],
    })
  })
  test("flags two stamps", () => {
    const r = validateChain([entry("a", "stamp", 1, "x"), entry("b", "stamp", 1, "y")])
    expect(r.ok).toBe(false)
    expect(r.violations.map((v) => v.kind)).toEqual(["stamp-multiple"])
  })
  test("flags two clamps", () => {
    const r = validateChain([entry("a", "clamp", 1, "x"), entry("b", "clamp", 1, "y")])
    expect(r.violations.map((v) => v.kind)).toEqual(["clamp-multiple"])
  })
  test("flags an unknown phase", () => {
    const bad = entry("a", "nope" as ToolResultPhase, 1, "x")
    const r = validateChain([bad])
    expect(r.violations).toEqual([{ kind: "phase-unknown", pluginId: "a" }])
  })
})

describe("applyStageKind", () => {
  const registry = createSidebandRegistry()
  registry.register(
    {
      owner: "owner",
      kind: "known",
      direction: "to-model",
      placement: "tool-result",
      attrs: {},
      body: "none",
      trust: "harness",
      summary: "s",
    },
    "owner",
  )
  test("registered kind returns sideband", () => {
    expect(applyStageKind({ ...base, kind: "known" }, registry)).toEqual({
      sideband: { kind: "known" },
    })
  })
  test("unregistered kind is dropped", () => {
    expect(applyStageKind({ ...base, kind: "zzz" }, registry)).toEqual({ dropped: "zzz" })
  })
  test("absent kind returns no sideband key", () => {
    const r = applyStageKind(base, registry)
    expect("sideband" in r).toBe(false)
    expect("dropped" in r).toBe(false)
  })
})

describe("types", () => {
  test("ToolResultStage requires the documented fields", () => {
    // @ts-expect-error missing required fields
    const bad: ToolResultStage = { tool: "t" }
    expect(bad).toBeDefined()
    const ok = { ...base } satisfies ToolResultStage
    expect(ok.diagnosticNotes).toEqual([])
  })
})
