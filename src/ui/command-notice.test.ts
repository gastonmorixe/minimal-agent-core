import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../term-width.ts"

import { renderCommandNoticeBlock } from "./command-notice.ts"

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
