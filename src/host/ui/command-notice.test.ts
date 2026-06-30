import { describe, expect, it } from "bun:test"

import { displayWidth, stripAnsi } from "../../term-width.ts"

import { coerceNoticeBlock, renderCommandNoticeBlock } from "./command-notice.ts"

/**
 * Frame-integrity assertion: every interior row of a rendered notice must
 * carry the `│` gutter (so a terminal-level wrap can never produce a
 * gutterless orphan row), the block opens with `╭` and closes with `╰`, and
 * no row exceeds `cols` in DISPLAY width (not char length: CJK is 2 cells,
 * ANSI is 0). This is the mechanical check the toast tear bug needed.
 */
function assertFrameIntact(rows: string[], cols: number): void {
  const plain = rows.map(stripAnsi)
  expect(plain[0].startsWith("  ╭ ")).toBe(true)
  expect(plain[plain.length - 1].startsWith("  ╰")).toBe(true)
  for (let i = 1; i < plain.length - 1; i++) {
    // Interior rows are gutter rows: "  │" or "  │ <content>".
    expect(plain[i].startsWith("  │")).toBe(true)
  }
  for (const r of rows) {
    expect(displayWidth(r)).toBeLessThanOrEqual(cols)
  }
}

describe("renderCommandNoticeBlock", () => {
  it("renders host-owned frame chrome around semantic command notice data", () => {
    const rows = renderCommandNoticeBlock({
      icon: "⟳",
      title: "loop",
      info: "every 5m",
      timestamp: "12:34:56",
      body: ["do work"],
      footer: "id-1",
      color: "gold",
    }).map(stripAnsi)

    expect(rows).toEqual([
      "  ╭ ⟳ loop  every 5m  12:34:56",
      "  │",
      "  │ do work",
      "  │",
      "  ╰ id-1",
    ])
  })

  it("renders a compact close-only block when body and footer are omitted", () => {
    expect(
      renderCommandNoticeBlock({ title: "schedule", info: "no tasks" }).map(stripAnsi),
    ).toEqual(["  ╭ schedule  no tasks", "  ╰"])
  })
})

describe("coerceNoticeBlock", () => {
  it("accepts a well-formed block and passes string fields through", () => {
    const block = coerceNoticeBlock({
      icon: "⇆",
      title: "intercom",
      info: "1 new message",
      color: "magenta",
      body: ["⇆ ◇ b052aedf (test-model-x) at 00:10:30", "Done on my side, all green."],
      footer: "from b052aedf",
    })
    expect(block).not.toBeNull()
    expect(block?.title).toBe("intercom")
    expect(block?.icon).toBe("⇆")
    expect(block?.color).toBe("magenta")
    expect(block?.body).toEqual([
      "⇆ ◇ b052aedf (test-model-x) at 00:10:30",
      "Done on my side, all green.",
    ])
  })

  it("does NOT html-escape body rows (raw < and > survive for the terminal)", () => {
    const block = coerceNoticeBlock({
      title: "intercom",
      body: ["plants blob fixtures at <sessionsDir>/<sid>.blobs/<id>.raw"],
    })
    // The &lt; bug: the human-facing toast must keep literal angle brackets.
    expect(block?.body?.[0]).toBe("plants blob fixtures at <sessionsDir>/<sid>.blobs/<id>.raw")
  })

  it("rejects payloads with no usable title", () => {
    expect(coerceNoticeBlock(null)).toBeNull()
    expect(coerceNoticeBlock({})).toBeNull()
    expect(coerceNoticeBlock({ title: "" })).toBeNull()
    expect(coerceNoticeBlock({ title: "   " })).toBeNull()
    expect(coerceNoticeBlock({ title: 42 })).toBeNull()
    expect(coerceNoticeBlock("nope")).toBeNull()
  })

  it("drops non-string body entries and tolerates a non-array body", () => {
    const block = coerceNoticeBlock({
      title: "intercom",
      body: ["keep", 7, null, "also keep", { x: 1 }],
    })
    expect(block?.body).toEqual(["keep", "also keep"])
    expect(coerceNoticeBlock({ title: "intercom", body: "not-an-array" })?.body).toBeUndefined()
  })

  it("clamps a flood of body rows and over-long rows", () => {
    const huge = Array.from({ length: 500 }, (_, i) => `row ${i}`)
    const block = coerceNoticeBlock({ title: "intercom", body: huge })
    expect(block?.body?.length).toBe(200)

    const long = "x".repeat(10_000)
    const clamped = coerceNoticeBlock({ title: long, body: [long] })
    expect(clamped?.title.length).toBe(4_000)
    expect(clamped?.body?.[0]?.length).toBe(4_000)
  })

  it("round-trips through the frame renderer", () => {
    const block = coerceNoticeBlock({
      title: "intercom",
      info: "1 new message",
      icon: "⇆",
      body: ["hello"],
    })
    expect(block).not.toBeNull()
    if (!block) return
    expect(renderCommandNoticeBlock(block).map(stripAnsi)).toEqual([
      "  ╭ ⇆ intercom  1 new message",
      "  │",
      "  │ hello",
      "  │",
      "  ╰",
    ])
  })
})

describe("renderCommandNoticeBlock width wrapping (the toast frame-tear fix)", () => {
  const COLS = 40

  it("word-wraps a long body line so every fragment keeps the │ gutter", () => {
    const long =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."
    const rows = renderCommandNoticeBlock(
      { icon: "⇆", title: "intercom", info: "1 new message", color: "magenta", body: [long] },
      COLS,
    )
    // More than one body row => it actually wrapped (not emitted whole).
    const bodyRows = rows.map(stripAnsi).filter((r) => r.startsWith("  │ "))
    expect(bodyRows.length).toBeGreaterThan(1)
    assertFrameIntact(rows, COLS)
    // No content was lost: re-joining the wrapped fragments reproduces the text.
    const rejoined = bodyRows.map((r) => r.slice("  │ ".length)).join(" ")
    expect(rejoined).toBe(long)
  })

  it("hard-breaks a single unbreakable token longer than cols, gutter survives", () => {
    // The nastiest tear case (Lautaro's refinement A): no spaces to wrap on.
    const token = "x".repeat(80) // 80 > COLS, no break opportunity
    const rows = renderCommandNoticeBlock({ title: "intercom", body: [token] }, COLS)
    const bodyRows = rows.map(stripAnsi).filter((r) => r.startsWith("  │ "))
    expect(bodyRows.length).toBeGreaterThan(1) // hard-broken into chunks
    assertFrameIntact(rows, COLS)
    // Every chunk reassembles to the original token (no chars dropped).
    expect(bodyRows.map((r) => r.slice("  │ ".length)).join("")).toBe(token)
  })

  it("keeps frame intact with wide (CJK) glyphs measured by display width", () => {
    // 30 CJK chars = 60 display cells, well over COLS=40.
    const cjk = "你好世界".repeat(8)
    const rows = renderCommandNoticeBlock({ title: "intercom", body: [cjk] }, COLS)
    expect(rows.map(stripAnsi).filter((r) => r.startsWith("  │ ")).length).toBeGreaterThan(1)
    assertFrameIntact(rows, COLS)
  })

  it("does NOT wrap when cols is omitted (legacy / non-TTY determinism)", () => {
    const long = "a ".repeat(100).trim()
    const rows = renderCommandNoticeBlock({ title: "intercom", body: [long] }).map(stripAnsi)
    // Exactly one body content row, emitted verbatim.
    expect(rows.filter((r) => r.startsWith("  │ "))).toEqual([`  │ ${long}`])
  })

  it("preserves blank body rows as bare gutter rows when wrapping", () => {
    const rows = renderCommandNoticeBlock(
      { title: "intercom", body: ["line one", "", "line two"] },
      COLS,
    ).map(stripAnsi)
    // The empty body entry stays a bare "  │" (no trailing space, no content).
    expect(rows).toContain("  │")
    expect(rows).toContain("  │ line one")
    expect(rows).toContain("  │ line two")
  })
})
