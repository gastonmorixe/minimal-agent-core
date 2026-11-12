import { describe, expect, it } from "bun:test"

import type {
  TurnContentCtx,
  TurnContentProviderDecl,
} from "../../plugin-api/src/types/turn-content.ts"

import { collectTurnContent } from "./turn-content.ts"

const ctx: TurnContentCtx = {
  seam: "initial",
  round: 0,
  previousTurn: null,
  salvaged: false,
  resumingFromCheckpoint: false,
}

function diag() {
  const calls: { source: string; message: string; data: unknown }[] = []
  return {
    calls,
    d: {
      warn: (source: string, message: string, data?: unknown) =>
        calls.push({ source, message, data }),
    } as never,
  }
}

const t = (text: string) => ({ type: "text" as const, text })

describe("collectTurnContent", () => {
  it("runs in ascending order, ties by registration order", async () => {
    const mk = (order: number, text: string): TurnContentProviderDecl => ({
      order,
      provide: () => [t(text)],
    })
    const { d } = diag()
    const out = await collectTurnContent([mk(5, "c"), mk(1, "a"), mk(5, "d"), mk(2, "b")], ctx, d)
    expect(out.map((b) => (b as { text: string }).text)).toEqual(["a", "b", "c", "d"])
  })

  it("skips a throwing provider and records a diagnostic", async () => {
    const { d, calls } = diag()
    const out = await collectTurnContent(
      [
        {
          order: 3,
          provide: () => {
            throw new Error("boom")
          },
        },
        { order: 4, provide: () => [t("ok")] },
      ],
      ctx,
      d,
    )
    expect(out).toEqual([t("ok")])
    expect(calls).toEqual([
      { source: "turn_content.provider_failed", message: "", data: { order: 3 } },
    ])
  })

  it("gives each provider a frozen copy of ctx", async () => {
    const { calls, d } = diag()
    const seen: TurnContentCtx[] = []
    const out = await collectTurnContent(
      [
        {
          order: 1,
          provide: (c) => {
            ;(c as { round: number }).round = 99
            return [t("bad")]
          },
        },
        { order: 2, provide: (c) => (seen.push(c), [t("ok")]) },
      ],
      ctx,
      d,
    )
    expect(out).toEqual([t("ok")])
    expect(calls.map((c) => c.source)).toEqual(["turn_content.provider_failed"])
    expect(seen[0]).toEqual(ctx)
    expect(Object.isFrozen(seen[0])).toBe(true)
    expect(ctx.round).toBe(0)
  })

  it("adds nothing for an empty result and awaits async providers", async () => {
    const { d } = diag()
    const out = await collectTurnContent(
      [
        { order: 1, provide: () => [] },
        { order: 2, provide: async () => [t("late")] },
      ],
      ctx,
      d,
    )
    expect(out).toEqual([t("late")])
  })

  it("passes ctx to the provider", async () => {
    const { d } = diag()
    let seen: TurnContentCtx | undefined
    await collectTurnContent([{ order: 0, provide: (c) => ((seen = c), []) }], ctx, d)
    expect(seen).toEqual(ctx)
  })
})
