/**
 * The tool round runs the tool-result chain at five phase boundaries (spec
 * R-API-3). With no chain it is a no-op: the result bytes do not change.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type {
  ToolResultPhase,
  ToolResultStage,
  ToolResultTransformDecl,
} from "../../plugin-api/src/types/tool-result-chain.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import type { SidebandKind } from "../sideband/types.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import {
  orderStages,
  runPhase,
  STAGE_FAILED,
  STAGE_TIMEOUT_MS,
  type ToolResultChainEntry,
  validateChain,
} from "./tool-result-chain.ts"
import { applyChainPhase, type ChainVars, hasChainPhase } from "./tool-result-chain-glue.ts"
import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

function baseCtx(overrides: Partial<ToolRoundContext> = {}): ToolRoundContext {
  return {
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    store: null,
    lifecycle: NOOP_LIFECYCLE,
    ...overrides,
  }
}

function readTool(): ToolUseBlock {
  const dir = mkdtempSync(join(tmpdir(), "ma-chain-wiring-"))
  const path = join(dir, "a.txt")
  writeFileSync(path, "line one\nline two\n")
  return { type: "tool_use", id: "tu_chain", name: "Read", input: { file_path: path } }
}

function entry(
  phase: ToolResultPhase,
  transform: (s: ToolResultStage) => ToolResultStage,
  pluginId = "p",
): ToolResultChainEntry {
  return { pluginId, decl: { phase, order: 0, transform } }
}

/** `s` with `body.text` = `text`. */
const withText = (s: ToolResultStage, text: string): ToolResultStage => ({ ...s, body: { text } })

const registry = {
  kind: (name: string): SidebandKind | undefined =>
    name === "known" ? ({ name } as unknown as SidebandKind) : undefined,
}

describe("tool-result chain wiring", () => {
  test("no chain and empty chain give the same bytes", async () => {
    const tool = readTool()
    const a = await executeToolRound(tool, baseCtx())
    const b = await executeToolRound(tool, baseCtx({ toolResultChain: [] }))
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    expect("sideband" in a).toBe(false)
  })

  test("a post-blob stage changes the content", async () => {
    const base = await executeToolRound(readTool(), baseCtx())
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        toolResultChain: [entry("post-blob", (s) => withText(s, `${s.body.text}X`))],
      }),
    )
    expect(String(out.content).endsWith("X")).toBe(true)
    expect(String(out.content).length).toBe(String(base.content).length + 1)
  })

  test("a stage with a registered kind sets block.sideband", async () => {
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        sidebandRegistry: registry,
        toolResultChain: [entry("stamp", (s) => ({ ...s, kind: "known" }))],
      }),
    )
    expect(out.sideband).toEqual({ kind: "known" })
  })

  test("a stage with no kind leaves the block without a sideband key", async () => {
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        sidebandRegistry: registry,
        toolResultChain: [entry("final", (s) => ({ ...s, hostHints: { view: "v" } }))],
      }),
    )
    expect("sideband" in out).toBe(false)
  })

  test("an unregistered kind drops the field and emits a diagnostic", async () => {
    const seen: string[] = []
    const diagnostics = createDiagnostics({ emit: (e) => void seen.push(e.source) })
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        sidebandRegistry: registry,
        diagnostics,
        toolResultChain: [entry("stamp", (s) => ({ ...s, kind: "nope" }))],
      }),
    )
    expect("sideband" in out).toBe(false)
    expect(seen.some((s) => s.includes("tool-result-chain"))).toBe(true)
  })

  test("phases run in the fixed order", async () => {
    const order: string[] = []
    const phases: ToolResultPhase[] = ["stamp", "final", "post-blob", "pre-outcome", "clamp"]
    await executeToolRound(
      readTool(),
      baseCtx({
        toolResultChain: phases.map((p) =>
          entry(p, (s) => {
            order.push(p)
            return s
          }),
        ),
      }),
    )
    expect(order).toEqual(["clamp", "pre-outcome", "post-blob", "final", "stamp"])
  })
})

type Warn = { source: string; data: unknown }

function warnSink(): { warns: Warn[]; diagnostics: ReturnType<typeof createDiagnostics> } {
  const warns: Warn[] = []
  const diagnostics = createDiagnostics({
    emit: (e) => void warns.push({ source: e.source, data: e.structuredData }),
  })
  return { warns, diagnostics }
}

describe("tool-round call site passes signal and diagnostics", () => {
  test("a turn abort stops a waiting stage, the input is kept, reason aborted", async () => {
    const base = await executeToolRound(readTool(), baseCtx())
    const turn = new AbortController()
    const sink = warnSink()
    let seen: AbortSignal | undefined
    const hang: ToolResultChainEntry = {
      pluginId: "hang",
      decl: {
        phase: "stamp",
        order: 0,
        transform: (s, c) => {
          seen = c.signal
          setTimeout(() => turn.abort(), 5)
          return new Promise<ToolResultStage>((resolve) => {
            c.signal.addEventListener("abort", () => resolve({ ...s, kind: "LATE" }))
          })
        },
      },
    }
    const t0 = Date.now()
    const out = await executeToolRound(
      readTool(),
      baseCtx({ signal: turn.signal, diagnostics: sink.diagnostics, toolResultChain: [hang] }),
    )
    expect(Date.now() - t0).toBeLessThan(STAGE_TIMEOUT_MS)
    expect(seen?.aborted).toBe(true)
    expect(out.content).toBe(base.content)
    expect(sink.warns.filter((w) => w.source === STAGE_FAILED)).toEqual([
      {
        source: STAGE_FAILED,
        data: expect.objectContaining({ pluginId: "hang", phase: "stamp", reason: "aborted" }),
      },
    ])
  })

  test("a stage throw emits stage-failed when ctx has diagnostics", async () => {
    const base = await executeToolRound(readTool(), baseCtx())
    const sink = warnSink()
    const boom = entry(
      "final",
      () => {
        throw new Error("boom")
      },
      "bad",
    )
    const out = await executeToolRound(
      readTool(),
      baseCtx({ diagnostics: sink.diagnostics, toolResultChain: [boom] }),
    )
    expect(out.content).toBe(base.content)
    expect(sink.warns.filter((w) => w.source === STAGE_FAILED)).toEqual([
      {
        source: STAGE_FAILED,
        data: expect.objectContaining({ pluginId: "bad", phase: "final", reason: "throw" }),
      },
    ])
  })

  test("a stage throw with no ctx diagnostics does not throw", async () => {
    const base = await executeToolRound(readTool(), baseCtx())
    const boom = entry("final", () => {
      throw new Error("boom")
    })
    const out = await executeToolRound(readTool(), baseCtx({ toolResultChain: [boom] }))
    expect(out.content).toBe(base.content)
  })
})

const vars0: ChainVars = {
  content: "body",
  isError: false,
  aborted: false,
  truncInfo: undefined,
  rawForBlob: undefined,
  display: undefined,
}
const meta0 = { tool: "Read", toolUseId: "tu", input: {} }

describe("applyChainPhase", () => {
  test("forwards opts.signal and opts.diagnostics to runPhase (m-2)", async () => {
    const turn = new AbortController()
    const sink = warnSink()
    let seen: AbortSignal | undefined
    const hang: ToolResultChainEntry = {
      pluginId: "hang",
      decl: {
        phase: "final",
        order: 0,
        transform: (_s, c) => {
          seen = c.signal
          setTimeout(() => turn.abort(), 5)
          return new Promise<ToolResultStage>(() => {})
        },
      },
    }
    const t0 = Date.now()
    const r = await applyChainPhase("final", [hang], vars0, meta0, {
      signal: turn.signal,
      diagnostics: sink.diagnostics,
    })
    expect(Date.now() - t0).toBeLessThan(STAGE_TIMEOUT_MS)
    expect(seen?.aborted).toBe(true)
    expect(r.vars).toStrictEqual(vars0)
    expect(sink.warns).toEqual([
      {
        source: STAGE_FAILED,
        data: expect.objectContaining({ pluginId: "hang", phase: "final", reason: "aborted" }),
      },
    ])
  })

  test("a timeoutMs below 2000 stops a slow stage at that limit at runtime (m-2)", async () => {
    const sink = warnSink()
    const slow: ToolResultChainEntry = {
      pluginId: "slow",
      decl: {
        phase: "final",
        order: 0,
        timeoutMs: 20,
        // The stage never settles, so only the 20 ms limit can stop it.
        // The `< 1000` check has a large margin for a loaded CI host.
        transform: () => new Promise<ToolResultStage>(() => {}),
      },
    }
    const t0 = Date.now()
    const r = await applyChainPhase("final", [slow], vars0, meta0, {
      diagnostics: sink.diagnostics,
    })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r.vars).toStrictEqual(vars0)
    expect(sink.warns).toEqual([
      {
        source: STAGE_FAILED,
        data: expect.objectContaining({ pluginId: "slow", reason: "timeout" }),
      },
    ])
  })

  test("a timeoutMs above 2000 keeps a stage that settles before 2000 ms at runtime (m-2)", async () => {
    const sink = warnSink()
    const ok: ToolResultChainEntry = {
      pluginId: "ok",
      decl: {
        phase: "final",
        order: 0,
        timeoutMs: 5000,
        transform: (s) =>
          new Promise<ToolResultStage>((res) =>
            setTimeout(() => res({ ...s, hostHints: { view: "done" } }), 20),
          ),
      },
    }
    const r = await applyChainPhase("final", [ok], vars0, meta0, { diagnostics: sink.diagnostics })
    expect(r.vars.display).toBe("done")
    expect(sink.warns).toEqual([])
  })

  test("isError undefined becomes false in the stage, as in base decb0e6", async () => {
    let seen: boolean | undefined
    const peek = entry("final", (s) => {
      seen = s.isError
      return s
    })
    const r = await applyChainPhase("final", [peek], { ...vars0, isError: undefined }, meta0)
    expect(seen).toBe(false)
    expect(r.vars.isError).toBe(false)
  })

  test("no stage for the phase: the vars deep-equal the input, no new keys", async () => {
    const r = await applyChainPhase("final", [entry("stamp", (s) => s)], vars0, meta0)
    expect(r.vars).toStrictEqual(vars0)
    expect(Object.keys(r.vars).sort()).toEqual(Object.keys(vars0).sort())
  })
})

describe("partial stage result is merged, the flags are kept (defect 2)", () => {
  const partial = (() => ({ body: { text: "changed" } })) as unknown as (
    s: ToolResultStage,
  ) => ToolResultStage

  test("(i) applyChainPhase: a text-only post-blob result keeps isError and aborted", async () => {
    const sink = warnSink()
    const vars: ChainVars = { ...vars0, isError: true, aborted: true, display: "view" }
    const r = await applyChainPhase(
      "post-blob",
      [entry("post-blob", partial, "part")],
      vars,
      meta0,
      {
        diagnostics: sink.diagnostics,
      },
    )
    expect(r.vars).toStrictEqual({ ...vars, content: "changed" })
    expect(r.stage.isError).toBe(true)
    expect(r.stage.aborted).toBe(true)
    expect(sink.warns).toEqual([])
  })

  test("(i) applyChainPhase: a dropped read-only change keeps all locals", async () => {
    const sink = warnSink()
    const vars: ChainVars = { ...vars0, isError: true, display: "view" }
    const flip = entry("stamp", (s) => ({ ...s, kind: "new", isError: false }), "flip")
    const r = await applyChainPhase("stamp", [flip], vars, meta0, {
      diagnostics: sink.diagnostics,
    })
    expect(r.vars).toStrictEqual(vars)
    expect(sink.warns).toEqual([
      {
        source: STAGE_FAILED,
        data: expect.objectContaining({
          pluginId: "flip",
          phase: "stamp",
          reason: "field-readonly",
        }),
      },
    ])
  })

  test("(g) applyChainPhase: an explicit undefined clears an optional local", async () => {
    const vars: ChainVars = { ...vars0, rawForBlob: "raw", display: "view" }
    const clear = entry("final", () => ({ hostHints: undefined }) as unknown as ToolResultStage)
    const r = await applyChainPhase("final", [clear], vars, meta0)
    expect(r.vars).toStrictEqual({ ...vars, display: undefined })
  })

  test("(8) applyChainPhase: an absent optional key keeps the prior local value", async () => {
    const vars: ChainVars = { ...vars0, rawForBlob: "raw", display: "view" }
    const drop = entry("pre-outcome", (s) => {
      const { rawForBlob: _r, hostHints: _d, ...rest } = s
      return withText(rest as ToolResultStage, "new")
    })
    const r = await applyChainPhase("pre-outcome", [drop], vars, meta0)
    expect(r.vars).toStrictEqual({ ...vars, content: "new" })
  })

  test("(i) executeToolRound: a text-only post-blob result keeps is_error on the provider result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-chain-wiring-"))
    const missing: ToolUseBlock = {
      type: "tool_use",
      id: "tu_missing",
      name: "Read",
      input: { file_path: join(dir, "no-such-file.txt") },
    }
    const base = await executeToolRound(missing, baseCtx())
    expect(base.is_error).toBe(true)
    const sink = warnSink()
    const out = await executeToolRound(
      missing,
      baseCtx({
        diagnostics: sink.diagnostics,
        toolResultChain: [entry("post-blob", partial, "part")],
      }),
    )
    expect(out.is_error).toBe(true)
    expect(out.content).toBe("changed")
    expect(sink.warns.filter((w) => w.source === STAGE_FAILED)).toEqual([])
  })
})

describe("hostile chain entries do not break the tool round (C1)", () => {
  const throwingDecl = {
    pluginId: "d",
    get decl(): ToolResultChainEntry["decl"] {
      throw new Error("decl")
    },
  } as ToolResultChainEntry
  const throwingPhase = {
    pluginId: "f",
    decl: {
      order: 0,
      transform: (s: ToolResultStage) => s,
      get phase(): ToolResultPhase {
        throw new Error("phase")
      },
    },
  } as ToolResultChainEntry

  test("hasChainPhase skips an entry with a throwing decl or phase getter", () => {
    expect(() => hasChainPhase([throwingDecl, throwingPhase], "final")).not.toThrow()
    expect(hasChainPhase([throwingDecl, throwingPhase], "final")).toBe(false)
    const ok = entry("final", (s) => s)
    expect(hasChainPhase([throwingDecl, throwingPhase, ok], "final")).toBe(true)
  })

  test("executeToolRound does not reject, the good stage still runs", async () => {
    const base = await executeToolRound(readTool(), baseCtx())
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        toolResultChain: [
          throwingDecl,
          throwingPhase,
          entry("post-blob", (s) => withText(s, `${s.body.text}X`)),
        ],
      }),
    )
    expect(String(out.content)).toBe(`${String(base.content)}X`)
    const only = await executeToolRound(
      readTool(),
      baseCtx({ toolResultChain: [throwingDecl, throwingPhase] }),
    )
    expect(only.content).toBe(base.content)
  })
})

/*
 * Runner boundary tests (F6, C2, S, W4). They are in this file because
 * tool-result-chain.test.ts is at the max-lines limit of oxlint.
 */
describe("runner boundary: allow-list, entry snapshots, Proxy input", () => {
  const stage0: ToolResultStage = {
    tool: "t",
    toolUseId: "u",
    input: {},
    body: { text: "" },
    annotations: [],
    isError: false,
    aborted: false,
  }
  const addS =
    (tag: string) =>
    (s: ToolResultStage): ToolResultStage =>
      withText(s, s.body.text + tag)
  const stg = (
    pluginId: string,
    phase: ToolResultPhase,
    order: number,
    transform: ToolResultTransformDecl["transform"],
  ): ToolResultChainEntry => ({ pluginId, decl: { phase, order, transform } })
  const failed = (pluginId: string, reason: string) => ({
    source: STAGE_FAILED,
    data: { pluginId, phase: "post-blob", reason },
  })

  async function run1(
    input: ToolResultStage,
    result: unknown,
    phase: ToolResultPhase = "post-blob",
  ) {
    const sink = warnSink()
    const out = await runPhase(
      phase,
      input,
      [stg("p", phase, 1, () => result as ToolResultStage)],
      { diagnostics: sink.diagnostics },
    )
    return { out, warns: sink.warns }
  }

  test("(F6 a) an own __proto__ key from JSON.parse is ignored: no inherited kind, plain prototype", async () => {
    const raw = '{"__proto__":{"kind":12345},"body":{"text":"x"}}'
    expect(Object.hasOwn(JSON.parse(raw), "__proto__")).toBe(true)
    const a = await run1(stage0, JSON.parse(raw))
    expect(a.out.body.text).toBe("x")
    expect(a.out.kind).toBeUndefined()
    expect(Object.getPrototypeOf(a.out)).toBe(Object.prototype)
    expect(Object.hasOwn(a.out, "__proto__")).toBe(false)
    expect(a.warns).toEqual([])
    const b = await run1({ ...stage0, kind: "k" }, JSON.parse(raw))
    expect(b.out.kind).toBe("k")
    expect(Object.getPrototypeOf(b.out)).toBe(Object.prototype)
    expect(b.warns).toEqual([])
  })

  test("(F6 b) unknown keys outcome and sideband are not on the merged stage, no diagnostic", async () => {
    const { out, warns } = await run1(stage0, {
      body: { text: "x", extra: 1 },
      outcome: 5,
      sideband: { kind: "zz" },
      content: "c",
      display: "d",
      owner: "o",
      constructor: "c",
      prototype: null,
      evil: true,
    })
    expect(out).toEqual(withText(stage0, "x"))
    expect(Object.hasOwn(out.body, "extra")).toBe(false)
    for (const k of [
      "outcome",
      "sideband",
      "content",
      "display",
      "owner",
      "constructor",
      "prototype",
    ])
      expect(Object.hasOwn(out, k)).toBe(false)
    expect(Object.hasOwn(out, "evil")).toBe(false)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(warns).toEqual([])
  })

  test("(C2) a pluginId getter that gives 'a' then a hostile object is read one time, runPhase resolves", async () => {
    // TextEncoder.encode in byteCompare calls toString on a non-string.
    const later = [
      {},
      {
        toString(): string {
          throw new Error("toString")
        },
      },
    ]
    for (const second of later) {
      let reads = 0
      const flip = {
        get pluginId(): string {
          reads++
          return (reads === 1 ? "a" : second) as string
        },
        decl: stg("x", "post-blob", 1, addS("?")).decl,
      }
      const sink = warnSink()
      const entries = [
        flip,
        stg("b", "post-blob", 1, addS("!")),
        stg("c", "post-blob", 1, () => null as never),
      ]
      const out = await runPhase("post-blob", stage0, entries, { diagnostics: sink.diagnostics })
      expect(reads).toBe(1)
      expect(out.body.text).toBe("?!")
      expect(sink.warns).toEqual([failed("c", "not-object")])
    }
  })

  const throwingDecl = {
    pluginId: "d",
    get decl(): ToolResultTransformDecl {
      throw new Error("decl")
    },
  }
  const throwingPhase = {
    pluginId: "f",
    decl: {
      order: 1,
      transform: addS("x"),
      get phase(): ToolResultPhase {
        throw new Error("phase")
      },
    },
  } as ToolResultChainEntry
  const badId = { pluginId: 7 as unknown as string, decl: stg("z", "stamp", 1, addS("x")).decl }

  test("(S) orderStages and validateChain skip an entry whose read throws or whose id is not a string", () => {
    const ok = [stg("b", "final", 2, addS("x")), stg("a", "final", 2, addS("y"))]
    const sorted = orderStages([throwingDecl, throwingPhase, badId, ...ok])
    expect(sorted.map((e) => e.pluginId)).toEqual(["a", "b"])
    const v = validateChain([throwingDecl, throwingPhase, badId, stg("a", "stamp", 1, addS("x"))])
    expect(v).toEqual({ ok: true, violations: [] })
  })

  test("(S) orderStages reads pluginId one time", () => {
    let reads = 0
    const flip = {
      get pluginId(): string {
        reads++
        const later = {
          toString(): string {
            throw new Error("toString")
          },
        }
        return (reads === 1 ? "a" : later) as string
      },
      decl: stg("x", "final", 1, addS("x")).decl,
    }
    expect(() => orderStages([flip, stg("b", "final", 1, addS("y"))])).not.toThrow()
    expect(reads).toBe(1)
  })

  test("(W4) a transparent Proxy input: runPhase resolves (pinned present behavior)", async () => {
    const proxy = new Proxy({ ...stage0 }, {})
    expect(await runPhase("post-blob", proxy, [])).toBe(proxy)
    const sink = warnSink()
    const out = await runPhase("post-blob", proxy, [stg("p", "post-blob", 1, addS("!"))], {
      diagnostics: sink.diagnostics,
    })
    // structuredClone rejects a Proxy: no stage runs, the input is kept.
    expect(out).toBe(proxy)
    expect(sink.warns).toEqual([failed("p", "clone")])
  })
})
