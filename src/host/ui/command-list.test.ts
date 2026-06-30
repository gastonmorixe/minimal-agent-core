import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../../term-width.ts"

import { renderCommandList } from "./command-list.ts"
import { renderCommandTable } from "./command-table.ts"

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

describe("renderCommandTable", () => {
  it("renders aligned sections with summary", () => {
    const rows = renderCommandTable({
      columns: [
        { key: "id", minWidth: 5, color: "cyan" },
        { key: "name", minWidth: 4, color: "dim" },
      ],
      sections: [
        {
          title: "provider",
          rows: [{ cells: { id: "a", name: "one" } }, { cells: { id: "longer", name: "two" } }],
        },
      ],
      summary: "2 rows",
    }).map(stripAnsi)

    expect(rows).toEqual(["", "  provider", "    a      one", "    longer two", "  2 rows"])
  })
})
