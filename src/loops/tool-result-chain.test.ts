import { describe, expect, test } from "bun:test"

import type {
  ToolResultPhase,
  ToolResultStage,
  ToolResultTransformDecl,
} from "../../plugin-api/src/types/tool-result-chain.ts"
import { createSidebandRegistry } from "../sideband/registry.ts"

import {
  applyStageKind,
  clampStageTimeout,
  orderStages,
  runChain,
  runPhase,
  STAGE_FAILED,
  STAGE_TIMEOUT_MS,
  type ToolResultChainEntry,
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
  test("a throwing transform no longer propagates (fail open)", async () => {
    const bad = {
      pluginId: "a",
      decl: {
        phase: "final" as const,
        order: 1,
        transform: () => {
          throw new Error("boom")
        },
      },
    }
    const out = await runPhase("final", base, [bad])
    expect(out).toBe(base)
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

/** A diagnostics stub that records each warning. */
function recorder() {
  const warns: { source: string; data: unknown }[] = []
  return {
    warns,
    diagnostics: {
      warn: (source: string, _message: string, data?: unknown) => {
        warns.push({ source, data })
      },
    },
  }
}

function stageOf(
  pluginId: string,
  phase: ToolResultPhase,
  order: number,
  transform: ToolResultTransformDecl["transform"],
  timeoutMs?: number,
): ToolResultChainEntry {
  return {
    pluginId,
    decl: { phase, order, transform, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
  }
}

const never = () => new Promise<ToolResultStage>(() => {})

describe("T3 phase order and fail open", () => {
  test("a recording stage in each phase runs in the order of TOOL_RESULT_PHASES", async () => {
    const seen: string[] = []
    const rec = (p: ToolResultPhase) =>
      stageOf("a", p, 1, (st) => {
        seen.push(p)
        return { ...st, content: `${st.content}${p};` }
      })
    const entries = [rec("stamp"), rec("final"), rec("post-blob"), rec("pre-outcome"), rec("clamp")]
    const out = await runChain(base, entries)
    expect(seen).toEqual(["clamp", "pre-outcome", "post-blob", "final", "stamp"])
    expect(out.content).toBe("clamp;pre-outcome;post-blob;final;stamp;")
  })

  test("case 1: a stage throws, the next stage of the same phase still runs (item 6)", async () => {
    const r = recorder()
    const entries = [
      stageOf("p1", "final", 1, add("A")),
      stageOf("p2", "final", 2, () => {
        throw new Error("boom")
      }),
      stageOf("p3", "final", 3, add("C")),
    ]
    const out = await runPhase("final", base, entries, { diagnostics: r.diagnostics })
    expect(out.content).toBe("AC")
    expect(r.warns).toEqual([
      { source: STAGE_FAILED, data: { pluginId: "p2", phase: "final", reason: "throw" } },
    ])
  })

  test("a rejected promise is the same as a throw", async () => {
    const r = recorder()
    const entries = [
      stageOf("p1", "clamp", 1, () => Promise.reject(new Error("x"))),
      stageOf("p2", "clamp", 2, add("B")),
    ]
    const out = await runPhase("clamp", base, entries, { diagnostics: r.diagnostics })
    expect(out.content).toBe("B")
    expect(r.warns.map((w) => (w.data as { reason: string }).reason)).toEqual(["throw"])
  })

  test("case 2: an in-place change then a throw does not leak (item 7)", async () => {
    const r = recorder()
    const input: ToolResultStage = { ...base, content: "orig", truncInfo: undefined }
    const seen: string[] = []
    const entries = [
      stageOf("p1", "final", 1, (st) => {
        ;(st as { content: string }).content = "changed"
        return st
      }),
      stageOf("p2", "final", 2, (st) => {
        ;(st.diagnosticNotes as string[]).push("x")
        return st
      }),
      stageOf("p3", "final", 3, (st) => {
        seen.push(st.content, String(st.diagnosticNotes.length))
        return st
      }),
    ]
    const out = await runPhase("final", input, entries, { diagnostics: r.diagnostics })
    expect(seen).toEqual(["orig", "0"])
    expect(out.content).toBe("orig")
    expect(input.content).toBe("orig")
    expect(input.diagnosticNotes).toEqual([])
    expect(r.warns.map((w) => (w.data as { reason: string }).reason)).toEqual(["throw", "throw"])
  })

  test("each stage gets a deep-frozen copy, not the caller object (item 7)", async () => {
    let got: ToolResultStage | undefined
    const input: ToolResultStage = {
      ...base,
      truncInfo: { truncated: true, shownBytes: 1, shownLines: 1, cutLine: 1 },
    }
    await runPhase("final", input, [
      stageOf("p1", "final", 1, (st) => {
        got = st
        return st
      }),
    ])
    expect(got).not.toBe(input)
    expect(got).toEqual(input)
    expect(Object.isFrozen(got)).toBe(true)
    expect(Object.isFrozen(got?.truncInfo)).toBe(true)
    expect(Object.isFrozen(got?.diagnosticNotes)).toBe(true)
    expect(Object.isFrozen(input)).toBe(false)
  })

  test("case 3a: a stage that does not resolve stops at its time limit (item 8)", async () => {
    const r = recorder()
    let signal: AbortSignal | undefined
    const entries = [
      stageOf(
        "slow",
        "post-blob",
        1,
        (_st, ctx) => {
          signal = ctx.signal
          return never()
        },
        20,
      ),
      stageOf("p2", "post-blob", 2, add("B")),
    ]
    const out = await runPhase("post-blob", base, entries, { diagnostics: r.diagnostics })
    expect(out.content).toBe("B")
    expect(signal?.aborted).toBe(true)
    expect(r.warns).toEqual([
      { source: STAGE_FAILED, data: { pluginId: "slow", phase: "post-blob", reason: "timeout" } },
    ])
  })

  test("case 3b: the turn abort stops a stage that does not resolve (item 8)", async () => {
    const r = recorder()
    const turn = new AbortController()
    let signal: AbortSignal | undefined
    const entries = [
      stageOf("hang", "stamp", 1, (_st, ctx) => {
        signal = ctx.signal
        setTimeout(() => turn.abort(), 5)
        return never()
      }),
    ]
    const t0 = Date.now()
    const out = await runPhase("stamp", base, entries, {
      signal: turn.signal,
      diagnostics: r.diagnostics,
    })
    expect(Date.now() - t0).toBeLessThan(STAGE_TIMEOUT_MS)
    expect(out).toBe(base)
    expect(signal?.aborted).toBe(true)
    expect(r.warns).toEqual([
      { source: STAGE_FAILED, data: { pluginId: "hang", phase: "stamp", reason: "aborted" } },
    ])
  })

  test("the default limit is 2000 ms", () => {
    expect(STAGE_TIMEOUT_MS).toBe(2000)
  })

  test("timeoutMs clamps to 1..2000, absent or not finite gives 2000", () => {
    expect(clampStageTimeout(5000)).toBe(2000)
    expect(clampStageTimeout(2000)).toBe(2000)
    expect(clampStageTimeout(0)).toBe(1)
    expect(clampStageTimeout(-3)).toBe(1)
    expect(clampStageTimeout(Number.NaN)).toBe(2000)
    expect(clampStageTimeout(Number.POSITIVE_INFINITY)).toBe(2000)
    expect(clampStageTimeout(undefined)).toBe(2000)
    expect(clampStageTimeout(50)).toBe(50)
  })

  test("timeoutMs floors, then clamps to 1..2000", () => {
    expect(clampStageTimeout(50.9)).toBe(50)
    expect(clampStageTimeout(0.5)).toBe(1)
    expect(clampStageTimeout(2000.7)).toBe(2000)
    expect(clampStageTimeout(-0.5)).toBe(1)
  })

  test("a turn signal that is already aborted does not skip the stages (M-2)", async () => {
    const r = recorder()
    const turn = new AbortController()
    turn.abort()
    let signal: AbortSignal | undefined
    const entries = [
      stageOf("c", "clamp", 1, (st, ctx) => {
        signal = ctx.signal
        return { ...st, content: `${st.content}C` }
      }),
      stageOf("s", "stamp", 1, (st) => ({ ...st, kind: "k" })),
    ]
    const out = await runChain(base, entries, { signal: turn.signal, diagnostics: r.diagnostics })
    expect(out.content).toBe("C")
    expect(out.kind).toBe("k")
    expect(signal?.aborted).toBe(false)
    expect(r.warns).toEqual([])
  })

  test("a turn signal that is already aborted keeps the stage time limit", async () => {
    const r = recorder()
    const turn = new AbortController()
    turn.abort()
    const out = await runPhase("clamp", base, [stageOf("z", "clamp", 1, never, 5)], {
      signal: turn.signal,
      diagnostics: r.diagnostics,
    })
    expect(out).toBe(base)
    expect(r.warns).toEqual([
      { source: STAGE_FAILED, data: { pluginId: "z", phase: "clamp", reason: "timeout" } },
    ])
  })

  test("a settled stage leaves no timer and no turn listener (m-1)", async () => {
    const turn = new AbortController()
    const added: unknown[] = []
    const removed: unknown[] = []
    const add0 = turn.signal.addEventListener.bind(turn.signal)
    const rem0 = turn.signal.removeEventListener.bind(turn.signal)
    turn.signal.addEventListener = ((t: string, l: EventListener, o?: unknown) => {
      added.push(l)
      add0(t, l, o as AddEventListenerOptions)
    }) as typeof turn.signal.addEventListener
    turn.signal.removeEventListener = ((t: string, l: EventListener) => {
      removed.push(l)
      rem0(t, l)
    }) as typeof turn.signal.removeEventListener
    let signal: AbortSignal | undefined
    const entries = [
      stageOf(
        "ok",
        "final",
        1,
        (st, ctx) => {
          signal = ctx.signal
          return st
        },
        20,
      ),
      stageOf(
        "bad",
        "final",
        2,
        () => {
          throw new Error("x")
        },
        20,
      ),
    ]
    await runPhase("final", base, entries, { signal: turn.signal })
    expect(added.length).toBe(2)
    expect(removed).toEqual(added)
    await Bun.sleep(40)
    expect(signal?.aborted).toBe(false)
  })

  test("timeoutMs 0 and -3 run with the 1 ms floor, not the 2000 ms default", async () => {
    for (const t of [0, -3]) {
      const r = recorder()
      const t0 = Date.now()
      const out = await runPhase("final", base, [stageOf("z", "final", 1, never, t)], {
        diagnostics: r.diagnostics,
      })
      expect(Date.now() - t0).toBeLessThan(STAGE_TIMEOUT_MS)
      expect(out).toBe(base)
      expect(r.warns).toEqual([
        { source: STAGE_FAILED, data: { pluginId: "z", phase: "final", reason: "timeout" } },
      ])
    }
  })

  test("case 4: a stage that returns undefined or a non-object is dropped (item 9)", async () => {
    const r = recorder()
    const bad = (v: unknown) => () => v as ToolResultStage
    const entries = [
      stageOf("u", "pre-outcome", 1, bad(undefined)),
      stageOf("n", "pre-outcome", 2, bad(null)),
      stageOf("s", "pre-outcome", 3, bad("text")),
      stageOf("arr", "pre-outcome", 4, bad([])),
      stageOf("noc", "pre-outcome", 5, bad({ ...base, content: 1 })),
      stageOf("ok", "pre-outcome", 6, add("Z")),
    ]
    const out = await runPhase("pre-outcome", base, entries, { diagnostics: r.diagnostics })
    expect(out.content).toBe("Z")
    expect(r.warns.map((w) => (w.data as { pluginId: string }).pluginId)).toEqual([
      "u",
      "n",
      "s",
      "arr",
      "noc",
    ])
    expect(r.warns.every((w) => (w.data as { reason: string }).reason === "not-object")).toBe(true)
  })

  test("a result with a non-boolean isError or aborted is dropped (m-3)", async () => {
    const r = recorder()
    const bad = (v: unknown) => (st: ToolResultStage) =>
      ({ ...st, ...(v as object) }) as ToolResultStage
    const entries = [
      stageOf("e", "pre-outcome", 1, bad({ content: "e", isError: "yes" })),
      stageOf("a", "pre-outcome", 2, bad({ content: "a", aborted: 1 })),
      stageOf("ok", "pre-outcome", 3, bad({ content: "ok", isError: true })),
    ]
    const out = await runPhase("pre-outcome", base, entries, { diagnostics: r.diagnostics })
    expect(out.content).toBe("ok")
    expect(out.isError).toBe(true)
    expect(r.warns).toEqual([
      { source: STAGE_FAILED, data: { pluginId: "e", phase: "pre-outcome", reason: "not-object" } },
      { source: STAGE_FAILED, data: { pluginId: "a", phase: "pre-outcome", reason: "not-object" } },
    ])
  })

  test("a stage input with a typed array does not fail with reason clone (n-2)", async () => {
    const r = recorder()
    const input = { ...base, input: { bytes: new Uint8Array([1, 2, 3]) } }
    let got: ToolResultStage | undefined
    const out = await runPhase(
      "final",
      input,
      [
        stageOf("p", "final", 1, (st) => {
          got = st
          return { ...st, content: "x" }
        }),
      ],
      { diagnostics: r.diagnostics },
    )
    expect(r.warns).toEqual([])
    expect(out.content).toBe("x")
    expect(Object.isFrozen(got?.input)).toBe(true)
    expect((got?.input as { bytes?: Uint8Array } | undefined)?.bytes).toEqual(
      new Uint8Array([1, 2, 3]),
    )
  })

  test("a stage result that cannot be cloned is dropped, the next stage runs", async () => {
    const r = recorder()
    const entries = [
      stageOf(
        "fn",
        "final",
        1,
        (st) => ({ ...st, content: "x", extra: () => 1 }) as ToolResultStage,
      ),
      stageOf("next", "final", 2, add("!")),
    ]
    const out = await runPhase("final", base, entries, { diagnostics: r.diagnostics })
    expect(out.content).toBe("!")
    expect(r.warns).toEqual([
      { source: STAGE_FAILED, data: { pluginId: "fn", phase: "final", reason: "clone" } },
    ])
  })

  test("a stage cannot change the result of the stage before it", async () => {
    let first: ToolResultStage | undefined
    const out = await runPhase("final", base, [
      stageOf("a", "final", 1, (st) => {
        first = { ...st, content: "A" }
        return first
      }),
      stageOf("b", "final", 2, add("B")),
    ])
    expect(out.content).toBe("AB")
    expect(first?.content).toBe("A")
    expect(Object.isFrozen(out)).toBe(true)
  })

  test("with no diagnostics handle a failure is silent and does not throw", async () => {
    const out = await runChain(base, [
      stageOf("a", "clamp", 1, () => {
        throw new Error("x")
      }),
    ])
    expect(out).toBe(base)
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
