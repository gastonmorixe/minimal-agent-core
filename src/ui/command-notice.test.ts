import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../term-width.ts"

import { coerceNoticeBlock, renderCommandNoticeBlock } from "./command-notice.ts"

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
      body: ["⇆ ◇ b052aedf (claude-opus-4-8) at 00:10:30", "Done on my side, all green."],
      footer: "from b052aedf",
    })
    expect(block).not.toBeNull()
    expect(block?.title).toBe("intercom")
    expect(block?.icon).toBe("⇆")
    expect(block?.color).toBe("magenta")
    expect(block?.body).toEqual([
      "⇆ ◇ b052aedf (claude-opus-4-8) at 00:10:30",
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
