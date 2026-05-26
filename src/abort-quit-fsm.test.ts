/**
 * Tests for {@link step}, {@link initialState}, {@link EscapeHatch}.
 *
 * Spec encoded here mirrors the transition table in `abort-quit-fsm.ts`.
 * Each row of the spec gets at least one test; many rows get inverse-
 * direction guards (e.g. "ESC while armed does NOT quit, it cancels").
 */
import { describe, expect, it } from "bun:test"

import {
  ARMED_DURATION_MS,
  ESCAPE_HATCH_MS,
  EscapeHatch,
  type FsmEffect,
  type FsmState,
  initialState,
  step,
} from "./abort-quit-fsm.ts"

const idle: FsmState = { kind: "idle" }
const working: FsmState = { kind: "working" }
const armedConfirm = (expiresAt: number): FsmState => ({
  kind: "armed",
  expiresAt,
  source: "idle-confirm",
})
const armedPostAbort = (expiresAt: number): FsmState => ({
  kind: "armed",
  expiresAt,
  source: "post-abort",
})
const effectKinds = (es: FsmEffect[]) => es.map((e) => e.kind)

describe("abort-quit-fsm — initialState", () => {
  it("starts in idle", () => {
    expect(initialState()).toEqual({ kind: "idle" })
  })
})

describe("abort-quit-fsm — idle", () => {
  it("ctrl-c arms with idle-confirm source and shows footer", () => {
    const r = step(idle, { kind: "ctrl-c", at: 1_000 })
    expect(r.state).toEqual({
      kind: "armed",
      expiresAt: 1_000 + ARMED_DURATION_MS,
      source: "idle-confirm",
    })
    expect(r.effects).toEqual([
      {
        kind: "show-armed",
        expiresAt: 1_000 + ARMED_DURATION_MS,
        source: "idle-confirm",
      },
    ])
  })

  it("esc is a no-op (per rule 4: ESC never arms)", () => {
    const r = step(idle, { kind: "esc", at: 0 })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([])
  })

  it("printable is a no-op", () => {
    const r = step(idle, { kind: "printable", at: 0 })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([])
  })

  it("turn-start → working", () => {
    const r = step(idle, { kind: "turn-start", at: 0 })
    expect(r.state).toEqual(working)
    expect(r.effects).toEqual([])
  })

  it("tick is a no-op (not armed)", () => {
    const r = step(idle, { kind: "tick", at: 99_999 })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([])
  })
})

describe("abort-quit-fsm — working", () => {
  it("ctrl-c aborts AND arms with post-abort source (rule 2)", () => {
    const r = step(working, { kind: "ctrl-c", at: 1_000 })
    expect(r.state).toEqual({
      kind: "armed",
      expiresAt: 1_000 + ARMED_DURATION_MS,
      source: "post-abort",
    })
    expect(effectKinds(r.effects)).toEqual(["abort-turn", "show-armed"])
  })

  it("esc aborts only — does NOT arm (rule 1, rule 4)", () => {
    const r = step(working, { kind: "esc", at: 1_000 })
    expect(r.state).toEqual(working)
    expect(r.effects).toEqual([{ kind: "abort-turn" }])
  })

  it("printable is a no-op (typing during work is fine)", () => {
    const r = step(working, { kind: "printable", at: 0 })
    expect(r.state).toEqual(working)
    expect(r.effects).toEqual([])
  })

  it("turn-start is idempotent (already working)", () => {
    const r = step(working, { kind: "turn-start", at: 0 })
    expect(r.state).toEqual(working)
    expect(r.effects).toEqual([])
  })

  it("turn-end → idle", () => {
    const r = step(working, { kind: "turn-end", at: 0 })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([])
  })
})

describe("abort-quit-fsm — armed", () => {
  it("ctrl-c → quitting + quit:confirmed", () => {
    const r = step(armedConfirm(10_000), { kind: "ctrl-c", at: 5_000 })
    expect(r.state).toEqual({ kind: "quitting", reason: "confirmed" })
    expect(r.effects).toEqual([{ kind: "quit", reason: "confirmed" }])
  })

  it("ctrl-c → quit works from post-abort source too", () => {
    const r = step(armedPostAbort(10_000), { kind: "ctrl-c", at: 5_000 })
    expect(r.state).toEqual({ kind: "quitting", reason: "confirmed" })
    expect(r.effects).toEqual([{ kind: "quit", reason: "confirmed" }])
  })

  it("esc cancels the modal back to idle (ESC is not quit)", () => {
    const r = step(armedConfirm(10_000), { kind: "esc", at: 5_000 })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([{ kind: "hide-armed" }])
  })

  it("printable cancels the modal — user is back to typing", () => {
    const r = step(armedConfirm(10_000), { kind: "printable", at: 5_000 })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([{ kind: "hide-armed" }])
  })

  it("turn-start cancels modal AND transitions to working", () => {
    const r = step(armedConfirm(10_000), { kind: "turn-start", at: 5_000 })
    expect(r.state).toEqual(working)
    expect(r.effects).toEqual([{ kind: "hide-armed" }])
  })

  it("turn-end keeps the modal armed (settled-after-abort case)", () => {
    const s = armedPostAbort(10_000)
    const r = step(s, { kind: "turn-end", at: 5_000 })
    expect(r.state).toEqual(s)
    expect(r.effects).toEqual([])
  })

  it("tick before expiresAt is a no-op", () => {
    const s = armedConfirm(10_000)
    const r = step(s, { kind: "tick", at: 9_999 })
    expect(r.state).toEqual(s)
    expect(r.effects).toEqual([])
  })

  it("tick at exactly expiresAt closes the modal", () => {
    const r = step(armedConfirm(10_000), { kind: "tick", at: 10_000 })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([{ kind: "hide-armed" }])
  })

  it("tick after expiresAt closes the modal", () => {
    const r = step(armedConfirm(10_000), { kind: "tick", at: 11_500 })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([{ kind: "hide-armed" }])
  })
})

describe("abort-quit-fsm — quitting (terminal)", () => {
  const q: FsmState = { kind: "quitting", reason: "confirmed" }
  for (const ev of ["ctrl-c", "esc", "printable", "turn-start", "turn-end", "tick"] as const) {
    it(`${ev} after quitting is a no-op`, () => {
      const r = step(q, { kind: ev, at: 99_999 } as never)
      expect(r.state).toEqual(q)
      expect(r.effects).toEqual([])
    })
  }
})

describe("abort-quit-fsm — full scenarios", () => {
  it("scenario: work, abort, wait 10s, then idle-confirm path", () => {
    let s: FsmState = idle
    // user submits → working
    s = step(s, { kind: "turn-start", at: 0 }).state
    expect(s.kind).toBe("working")
    // user hits Ctrl+C at t=1s
    {
      const r = step(s, { kind: "ctrl-c", at: 1_000 })
      expect(effectKinds(r.effects)).toEqual(["abort-turn", "show-armed"])
      s = r.state
    }
    expect(s.kind).toBe("armed")
    // turn settles (post-abort)
    s = step(s, { kind: "turn-end", at: 1_100 }).state
    expect(s.kind).toBe("armed")
    // wait 10s — tick expires
    {
      const r = step(s, { kind: "tick", at: 11_001 })
      expect(r.effects).toEqual([{ kind: "hide-armed" }])
      s = r.state
    }
    expect(s).toEqual(idle)
    // now ctrl-c — fresh idle-confirm arm
    {
      const r = step(s, { kind: "ctrl-c", at: 20_000 })
      if (r.state.kind !== "armed") throw new Error("expected armed")
      expect(r.state.source).toBe("idle-confirm")
    }
  })

  it("scenario: rapid double Ctrl+C while working → arm + quit", () => {
    let s: FsmState = working
    {
      const r = step(s, { kind: "ctrl-c", at: 1_000 })
      s = r.state
    }
    expect(s.kind).toBe("armed")
    {
      const r = step(s, { kind: "ctrl-c", at: 1_050 })
      expect(r.state).toEqual({ kind: "quitting", reason: "confirmed" })
      expect(r.effects).toEqual([{ kind: "quit", reason: "confirmed" }])
    }
  })

  it("scenario: ESC while working never arms, second ESC is also pure abort", () => {
    let s: FsmState = working
    {
      const r = step(s, { kind: "esc", at: 1_000 })
      expect(r.effects).toEqual([{ kind: "abort-turn" }])
      s = r.state
    }
    expect(s).toEqual(working)
    {
      const r = step(s, { kind: "esc", at: 1_050 })
      expect(r.effects).toEqual([{ kind: "abort-turn" }])
    }
  })

  it("scenario: user types after Ctrl+C — modal dismisses", () => {
    let s: FsmState = idle
    s = step(s, { kind: "ctrl-c", at: 1_000 }).state
    expect(s.kind).toBe("armed")
    const r = step(s, { kind: "printable", at: 1_100 })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([{ kind: "hide-armed" }])
  })

  it("scenario: armedDurationMs override is honored", () => {
    const r = step(idle, { kind: "ctrl-c", at: 0 }, { armedDurationMs: 2_500 })
    if (r.state.kind !== "armed") throw new Error("expected armed")
    expect(r.state.expiresAt).toBe(2_500)
  })
})

// ---------------------------------------------------------------------------
// EscapeHatch
// ---------------------------------------------------------------------------

describe("EscapeHatch", () => {
  it("first observe is always 'continue'", () => {
    const h = new EscapeHatch()
    expect(h.observe(1_000)).toBe("continue")
  })

  it("second observe within window is 'force-quit'", () => {
    const h = new EscapeHatch()
    h.observe(1_000)
    expect(h.observe(1_000 + ESCAPE_HATCH_MS - 1)).toBe("force-quit")
  })

  it("second observe at exactly window boundary is 'continue' (strict <)", () => {
    const h = new EscapeHatch()
    h.observe(1_000)
    expect(h.observe(1_000 + ESCAPE_HATCH_MS)).toBe("continue")
  })

  it("third rapid observe also returns 'force-quit'", () => {
    const h = new EscapeHatch()
    h.observe(0)
    expect(h.observe(100)).toBe("force-quit")
    expect(h.observe(200)).toBe("force-quit")
  })

  it("reset() clears the counter", () => {
    const h = new EscapeHatch()
    h.observe(1_000)
    h.reset()
    expect(h.observe(1_100)).toBe("continue")
  })

  it("custom window is honored", () => {
    const h = new EscapeHatch(200)
    h.observe(1_000)
    expect(h.observe(1_199)).toBe("force-quit")
    expect(h.observe(1_500)).toBe("continue")
  })
})
