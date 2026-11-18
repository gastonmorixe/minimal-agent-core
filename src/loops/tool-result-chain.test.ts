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
  TOOL_RESULT_PHASES,
  type ToolResultChainEntry,
  validateChain,
} from "./tool-result-chain.ts"

const base: ToolResultStage = {
  tool: "t",
  toolUseId: "u",
  input: {},
  body: { text: "" },
  annotations: [],
  isError: false,
  aborted: false,
}

/** `st` with `body.text` = `text`. */
const withText = (st: ToolResultStage, text: string): ToolResultStage => ({
  ...st,
  body: { text },
})

const add =
  (s: string) =>
  (st: ToolResultStage): ToolResultStage =>
    withText(st, st.body.text + s)

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
    const out = await runPhase("clamp", base, [entry("a", "post-blob", 1, "x")])
    expect(out).toBe(base)
  })
  test("output feeds the next transform", async () => {
    const out = await runPhase("post-blob", base, [
      entry("a", "post-blob", 2, "B"),
      entry("a", "post-blob", 1, "A"),
    ])
    expect(out.body.text).toBe("AB")
  })
  test("awaits async transforms", async () => {
    const out = await runPhase("post-blob", base, [
      entry("a", "post-blob", 1, "A", true),
      entry("a", "post-blob", 2, "B"),
    ])
    expect(out.body.text).toBe("AB")
  })
  test("a throwing transform no longer propagates (fail open)", async () => {
    const bad = {
      pluginId: "a",
      decl: {
        phase: "post-blob" as const,
        order: 1,
        transform: () => {
          throw new Error("boom")
        },
      },
    }
    const out = await runPhase("post-blob", base, [bad])
    expect(out).toBe(base)
  })
})

describe("runChain", () => {
  test("runs phases in the fixed order", async () => {
    const entries = [
      stageOf("a", "stamp", 1, (st) => ({ ...st, kind: `${st.hostHints?.view}5` })),
      stageOf("a", "final", 1, (st) => ({ ...st, hostHints: { view: `${st.body.text}4` } })),
      entry("a", "post-blob", 1, "3"),
      entry("a", "pre-outcome", 1, "2"),
      entry("a", "clamp", 1, "1"),
    ]
    const out = await runChain(base, entries)
    expect(out.body.text).toBe("123")
    expect(out.kind).toBe("12345")
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
        // body.text is read only in final and stamp (D4 field table).
        return p === "final" || p === "stamp" ? st : withText(st, `${st.body.text}${p};`)
      })
    const entries = [rec("stamp"), rec("final"), rec("post-blob"), rec("pre-outcome"), rec("clamp")]
    const out = await runChain(base, entries)
    expect(seen).toEqual(["clamp", "pre-outcome", "post-blob", "final", "stamp"])
    expect(out.body.text).toBe("clamp;pre-outcome;post-blob;")
  })

  test("case 1: a stage throws, the next stage of the same phase still runs (item 6)", async () => {
    const r = recorder()
    const entries = [
      stageOf("p1", "post-blob", 1, add("A")),
      stageOf("p2", "post-blob", 2, () => {
        throw new Error("boom")
      }),
      stageOf("p3", "post-blob", 3, add("C")),
    ]
    const out = await runPhase("post-blob", base, entries, { diagnostics: r.diagnostics })
    expect(out.body.text).toBe("AC")
    expect(r.warns).toEqual([
      { source: STAGE_FAILED, data: { pluginId: "p2", phase: "post-blob", reason: "throw" } },
    ])
  })

  test("a rejected promise is the same as a throw", async () => {
    const r = recorder()
    const entries = [
      stageOf("p1", "clamp", 1, () => Promise.reject(new Error("x"))),
      stageOf("p2", "clamp", 2, add("B")),
    ]
    const out = await runPhase("clamp", base, entries, { diagnostics: r.diagnostics })
    expect(out.body.text).toBe("B")
    expect(r.warns.map((w) => (w.data as { reason: string }).reason)).toEqual(["throw"])
  })

  test("case 2: an in-place change then a throw does not leak (item 7)", async () => {
    const r = recorder()
    const input: ToolResultStage = { ...withText(base, "orig"), truncInfo: undefined }
    const seen: string[] = []
    const entries = [
      stageOf("p1", "post-blob", 1, (st) => {
        ;(st.body as { text: string }).text = "changed"
        return st
      }),
      stageOf("p2", "post-blob", 2, (st) => {
        ;(st.annotations as unknown[]).push("x")
        return st
      }),
      stageOf("p3", "post-blob", 3, (st) => {
        seen.push(st.body.text, String(st.annotations.length))
        return st
      }),
    ]
    const out = await runPhase("post-blob", input, entries, { diagnostics: r.diagnostics })
    expect(seen).toEqual(["orig", "0"])
    expect(out.body.text).toBe("orig")
    expect(input.body.text).toBe("orig")
    expect(input.annotations).toEqual([])
    expect(r.warns.map((w) => (w.data as { reason: string }).reason)).toEqual(["throw", "throw"])
  })

  test("each stage gets a deep-frozen copy, not the caller object (item 7)", async () => {
    let got: ToolResultStage | undefined
    const input: ToolResultStage = {
      ...base,
      truncInfo: { truncated: true, shownBytes: 1, shownLines: 1, cutLine: 1 },
    }
    await runPhase("post-blob", input, [
      stageOf("p1", "post-blob", 1, (st) => {
        got = st
        return st
      }),
    ])
    expect(got).not.toBe(input)
    expect(got).toEqual(input)
    expect(Object.isFrozen(got)).toBe(true)
    expect(Object.isFrozen(got?.truncInfo)).toBe(true)
    expect(Object.isFrozen(got?.annotations)).toBe(true)
    expect(Object.isFrozen(got?.body)).toBe(true)
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
    expect(out.body.text).toBe("B")
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
        return withText(st, `${st.body.text}C`)
      }),
      stageOf("s", "stamp", 1, (st) => ({ ...st, kind: "k" })),
    ]
    const out = await runChain(base, entries, { signal: turn.signal, diagnostics: r.diagnostics })
    expect(out.body.text).toBe("C")
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
        "post-blob",
        1,
        (st, ctx) => {
          signal = ctx.signal
          return st
        },
        20,
      ),
      stageOf(
        "bad",
        "post-blob",
        2,
        () => {
          throw new Error("x")
        },
        20,
      ),
    ]
    await runPhase("post-blob", base, entries, { signal: turn.signal })
    expect(added.length).toBe(2)
    expect(removed).toEqual(added)
    await Bun.sleep(40)
    expect(signal?.aborted).toBe(false)
  })

  test("timeoutMs 0 and -3 run with the 1 ms floor, not the 2000 ms default", async () => {
    for (const t of [0, -3]) {
      const r = recorder()
      const t0 = Date.now()
      const out = await runPhase("post-blob", base, [stageOf("z", "post-blob", 1, never, t)], {
        diagnostics: r.diagnostics,
      })
      expect(Date.now() - t0).toBeLessThan(STAGE_TIMEOUT_MS)
      expect(out).toBe(base)
      expect(r.warns).toEqual([
        { source: STAGE_FAILED, data: { pluginId: "z", phase: "post-blob", reason: "timeout" } },
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
      stageOf("noc", "pre-outcome", 5, bad({ ...base, body: { text: 1 } })),
      stageOf("ok", "pre-outcome", 6, add("Z")),
    ]
    const out = await runPhase("pre-outcome", base, entries, { diagnostics: r.diagnostics })
    expect(out.body.text).toBe("Z")
    expect(
      r.warns.map((w) => {
        const d = w.data as { pluginId: string; reason: string }
        return [d.pluginId, d.reason]
      }),
    ).toEqual([
      ["u", "not-object"],
      ["n", "not-object"],
      ["s", "not-object"],
      ["arr", "not-object"],
      ["noc", "shape"],
    ])
  })

  test("a result with a non-boolean isError or aborted is dropped, reason shape (m-3)", async () => {
    const r = recorder()
    const bad = (v: unknown) => (st: ToolResultStage) =>
      ({ ...st, ...(v as object) }) as ToolResultStage
    const entries = [
      stageOf("e", "pre-outcome", 1, bad({ body: { text: "e" }, isError: "yes" })),
      stageOf("a", "pre-outcome", 2, bad({ body: { text: "a" }, aborted: 1 })),
      stageOf("ok", "pre-outcome", 3, bad({ body: { text: "ok" }, isError: true })),
    ]
    const out = await runPhase("pre-outcome", base, entries, { diagnostics: r.diagnostics })
    expect(out.body.text).toBe("ok")
    expect(out.isError).toBe(true)
    expect(r.warns).toEqual([
      { source: STAGE_FAILED, data: { pluginId: "e", phase: "pre-outcome", reason: "shape" } },
      { source: STAGE_FAILED, data: { pluginId: "a", phase: "pre-outcome", reason: "shape" } },
    ])
  })

  test("a stage input with a typed array does not fail with reason clone (n-2)", async () => {
    const r = recorder()
    const input = { ...base, input: { bytes: new Uint8Array([1, 2, 3]) } }
    let got: ToolResultStage | undefined
    const out = await runPhase(
      "post-blob",
      input,
      [
        stageOf("p", "post-blob", 1, (st) => {
          got = st
          return withText(st, "x")
        }),
      ],
      { diagnostics: r.diagnostics },
    )
    expect(r.warns).toEqual([])
    expect(out.body.text).toBe("x")
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
        "post-blob",
        1,
        (st) => ({ ...withText(st, "x"), extra: () => 1 }) as ToolResultStage,
      ),
      stageOf("next", "post-blob", 2, add("!")),
    ]
    const out = await runPhase("post-blob", base, entries, { diagnostics: r.diagnostics })
    expect(out.body.text).toBe("!")
    expect(r.warns).toEqual([
      { source: STAGE_FAILED, data: { pluginId: "fn", phase: "post-blob", reason: "clone" } },
    ])
  })

  test("a stage cannot change the result of the stage before it", async () => {
    let first: ToolResultStage | undefined
    const out = await runPhase("post-blob", base, [
      stageOf("a", "post-blob", 1, (st) => {
        first = withText(st, "A")
        return first
      }),
      stageOf("b", "post-blob", 2, add("B")),
    ])
    expect(out.body.text).toBe("AB")
    expect(first?.body.text).toBe("A")
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

describe("stage result boundary", () => {
  const prior: ToolResultStage = { ...withText(base, "prior"), isError: true, aborted: true }

  /** Run `bad` then a stage that adds "!", and check the fail-open contract. */
  async function expectDropped(bad: () => unknown, reason: string) {
    const r = recorder()
    const entries = [
      stageOf("bad", "post-blob", 1, bad as ToolResultTransformDecl["transform"]),
      stageOf("next", "post-blob", 2, add("!")),
    ]
    const out = await runPhase("post-blob", prior, entries, { diagnostics: r.diagnostics })
    expect(out).toEqual(withText(prior, "prior!"))
    expect(r.warns).toEqual([
      { source: STAGE_FAILED, data: { pluginId: "bad", phase: "post-blob", reason } },
    ])
    const only = await runPhase("post-blob", prior, [entries[0] as ToolResultChainEntry])
    expect(only).toEqual(prior)
  }

  test("(1) a throwing body getter is dropped, the next stage runs", async () => {
    await expectDropped(
      () => ({
        ...prior,
        get body(): { text: string } {
          throw new Error("getter crash")
        },
      }),
      "clone",
    )
  })

  test("(2) a throwing isError getter is dropped, the next stage runs", async () => {
    await expectDropped(
      () => ({
        ...withText(prior, "x"),
        get isError(): boolean {
          throw new Error("getter crash")
        },
      }),
      "clone",
    )
  })

  test("(3) a Proxy whose get trap throws is dropped, the next stage runs", async () => {
    await expectDropped(
      () =>
        new Proxy(
          { ...withText(prior, "x") },
          {
            get() {
              throw new Error("get trap")
            },
          },
        ),
      // The Promise resolve step reads `then` before core gets the value
      // (ECMA-262 CreateResolvingFunctions), so the trap throws there.
      "throw",
    )
  })

  test("(4) a Proxy whose ownKeys or has trap throws is dropped, the next stage runs", async () => {
    const trap = () => {
      throw new Error("trap")
    }
    await expectDropped(() => new Proxy({ ...withText(prior, "x") }, { ownKeys: trap }), "clone")
    await expectDropped(() => new Proxy({ ...withText(prior, "x") }, { has: trap }), "clone")
    await expectDropped(
      () => new Proxy({ ...withText(prior, "x") }, { getPrototypeOf: trap }),
      "clone",
    )
  })

  test("(5) a revoked Proxy is dropped, the next stage runs", async () => {
    await expectDropped(() => {
      const p = Proxy.revocable({ ...withText(prior, "x") }, {})
      p.revoke()
      return p.proxy
    }, "throw")
  })

  test("(6) a null, primitive or array result is dropped, reason not-object", async () => {
    await expectDropped(() => null, "not-object")
    await expectDropped(() => 5, "not-object")
    await expectDropped(() => [prior], "not-object")
  })

  test("(7) a result with a present field of the wrong type is dropped, reason shape", async () => {
    const x = { text: "x" }
    await expectDropped(() => ({ ...prior, body: x, isError: "yes" }), "shape")
    await expectDropped(() => ({ body: { text: 5 } }), "shape")
    await expectDropped(() => ({ body: "x" }), "shape")
    await expectDropped(() => ({ ...prior, body: x, annotations: [1] }), "shape")
    await expectDropped(() => ({ ...prior, body: x, kind: 7 }), "shape")
    await expectDropped(() => ({ body: x, truncInfo: { truncated: true } }), "shape")
    await expectDropped(() => ({ body: x, blob: { path: "/b" } }), "shape")
    await expectDropped(() => ({ body: x, tool: undefined }), "shape")
    await expectDropped(() => ({ body: x, hostHints: { view: 1 } }), "shape")
  })

  test("a full result with valid optional fields is accepted", async () => {
    const r = recorder()
    const full: ToolResultStage = {
      ...withText(prior, "x"),
      truncInfo: { truncated: true, shownBytes: 1, shownLines: 1, cutLine: 1 },
      rawForBlob: "raw",
      hostHints: { view: "d" },
      blob: { path: "/b", bytes: 1, sha256: "h" },
    }
    // clamp may change body.text, truncInfo and rawForBlob. The input holds
    // the same blob and hostHints (read only in clamp).
    const input = { ...prior, blob: full.blob, hostHints: full.hostHints }
    const out = await runPhase("clamp", input, [stageOf("ok", "clamp", 1, () => full)], {
      diagnostics: r.diagnostics,
    })
    expect(out).toEqual(full)
    expect(r.warns).toEqual([])
  })

  test("a diagnostics handle that throws does not stop the chain", async () => {
    const diagnostics = {
      warn: () => {
        throw new Error("sink")
      },
    }
    const entries = [
      stageOf("bad", "post-blob", 1, () => ({ body: 5 }) as unknown as ToolResultStage),
      stageOf("next", "post-blob", 2, add("!")),
    ]
    const out = await runPhase("post-blob", prior, entries, { diagnostics })
    expect(out.body.text).toBe("prior!")
  })

  test("an entry with a throwing decl getter is skipped, runChain resolves", async () => {
    const hostile = {
      pluginId: "h",
      get decl(): ToolResultTransformDecl {
        throw new Error("decl")
      },
    }
    const out = await runChain(prior, [hostile, stageOf("next", "post-blob", 1, add("!"))])
    expect(out.body.text).toBe("prior!")
  })
})

describe("stage result merge rule", () => {
  const flagged: ToolResultStage = { ...withText(base, "in"), isError: true, aborted: true }
  const partial = (v: object) => () => v as unknown as ToolResultStage

  async function run1(
    phase: ToolResultPhase,
    input: ToolResultStage,
    transform: ToolResultTransformDecl["transform"],
  ) {
    const r = recorder()
    const out = await runPhase(phase, input, [stageOf("p", phase, 1, transform)], {
      diagnostics: r.diagnostics,
    })
    return { out, warns: r.warns }
  }

  const failed = (phase: ToolResultPhase, reason: string) => [
    { source: STAGE_FAILED, data: { pluginId: "p", phase, reason } },
  ]

  test("(a) a text-only result in post-blob keeps isError and aborted, no diagnostic", async () => {
    const { out, warns } = await run1("post-blob", flagged, partial({ body: { text: "changed" } }))
    expect(out).toEqual(withText(flagged, "changed"))
    expect(out.isError).toBe(true)
    expect(out.aborted).toBe(true)
    expect(Object.isFrozen(out)).toBe(true)
    expect(warns).toEqual([])
  })

  test("(b) a full result with the same flags in clamp is applied, no diagnostic", async () => {
    const { out, warns } = await run1("clamp", flagged, (s) => withText(s, "x"))
    expect(out).toEqual(withText(flagged, "x"))
    expect(warns).toEqual([])
  })

  test("(c) stamp sets isError false and sets kind: whole result dropped, field-readonly", async () => {
    const { out, warns } = await run1("stamp", flagged, (s) => ({
      ...s,
      kind: "k",
      isError: false,
    }))
    expect(out).toBe(flagged)
    expect(out.kind).toBeUndefined()
    expect(warns).toEqual(failed("stamp", "field-readonly"))
  })

  test("(d) clamp sets aborted false: dropped, field-readonly", async () => {
    const { out, warns } = await run1("clamp", flagged, partial({ aborted: false }))
    expect(out).toBe(flagged)
    expect(warns).toEqual(failed("clamp", "field-readonly"))
  })

  test("(d) aborted is read only in each phase, isError in each phase but pre-outcome", async () => {
    for (const phase of TOOL_RESULT_PHASES) {
      const a = await run1(phase, flagged, partial({ aborted: false }))
      expect(a.warns).toEqual(failed(phase, "field-readonly"))
      const e = await run1(phase, flagged, partial({ isError: false }))
      if (phase === "pre-outcome") {
        expect(e.out.isError).toBe(false)
        expect(e.warns).toEqual([])
      } else expect(e.warns).toEqual(failed(phase, "field-readonly"))
    }
  })

  test("(e) pre-outcome sets isError true on a non-error result: applied, no diagnostic", async () => {
    const { out, warns } = await run1("pre-outcome", base, partial({ isError: true }))
    expect(out).toEqual({ ...base, isError: true })
    expect(warns).toEqual([])
  })

  test("(e) the same value of a read-only field is not a change", async () => {
    const { out, warns } = await run1(
      "stamp",
      flagged,
      partial({ kind: "y", isError: true, aborted: true }),
    )
    expect(out).toEqual({ ...flagged, kind: "y" })
    expect(warns).toEqual([])
  })

  test("(f) isError 'yes' or body.text 5 is dropped, reason shape", async () => {
    const a = await run1("pre-outcome", base, partial({ isError: "yes" }))
    expect(a.out).toBe(base)
    expect(a.warns).toEqual(failed("pre-outcome", "shape"))
    const b = await run1("final", flagged, partial({ body: { text: 5 } }))
    expect(b.out).toBe(flagged)
    expect(b.warns).toEqual(failed("final", "shape"))
  })

  test("(f) a wrong type is shape, not field-readonly, also with a read-only change", async () => {
    const { out, warns } = await run1(
      "final",
      flagged,
      partial({ body: { text: 5 }, aborted: false }),
    )
    expect(out).toBe(flagged)
    expect(warns).toEqual(failed("final", "shape"))
  })

  test("(g) an explicit undefined clears an optional field, omission keeps it", async () => {
    const full: ToolResultStage = {
      ...base,
      truncInfo: { truncated: true, shownBytes: 1, shownLines: 1, cutLine: 1 },
      rawForBlob: "raw",
    }
    const kept = await run1("clamp", full, partial({ body: { text: "c" } }))
    expect(kept.out).toEqual(withText(full, "c"))
    const cleared = await run1(
      "clamp",
      full,
      partial({ truncInfo: undefined, rawForBlob: undefined }),
    )
    expect(cleared.out).toEqual(base)
    expect("truncInfo" in cleared.out).toBe(false)
    expect("rawForBlob" in cleared.out).toBe(false)
    expect(cleared.warns).toEqual([])
  })

  test("(h) an input that cannot be cloned: resolves, no stage runs, input as given, clone", async () => {
    const throwing = {
      ...base,
      get body(): { text: string } {
        throw new Error("input getter")
      },
    } as ToolResultStage
    const proxy = new Proxy({ ...base }, {})
    for (const input of [throwing, proxy]) {
      let ran = false
      const { out, warns } = await run1("final", input, (s) => {
        ran = true
        return s
      })
      expect(ran).toBe(false)
      expect(out).toBe(input)
      expect(warns).toEqual(failed("final", "clone"))
    }
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
    expect(ok.annotations).toEqual([])
  })
})
