import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../term-width.ts"

import { renderCommandList } from "./command-list.ts"

describe("renderCommandList", () => {
  it("renders titled framed items with summary", () => {
    const rows = renderCommandList({
      title: "Things",
      subtitle: "Pick one",
      items: [
        { title: "alpha", footer: "first" },
        { title: "beta", body: ["description", "source: test"], footer: "when: always" },
      ],
      summary: "2 things total",
    }).map(stripAnsi)

    expect(rows).toEqual([
      "",
      "  Things",
      "  Pick one",
      "",
      "  ╭ alpha",
      "  ╰ first",
      "",
      "  ╭ beta",
      "  │ description",
      "  │ source: test",
      "  ╰ when: always",
      "",
      "  2 things total",
    ])
  })
})
