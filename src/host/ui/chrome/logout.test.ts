import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../../../term-width.ts"

import { renderLogoutResultRows, renderLogoutStartRows, renderLogoutWarningRows } from "./logout.ts"

describe("logout chrome", () => {
  it("renders start, warning, and result rows", () => {
    expect(renderLogoutStartRows().map(stripAnsi)).toEqual(["  ⊖ Sign out"])
    expect(renderLogoutWarningRows("store locked").map(stripAnsi)).toEqual([
      "  warn credential removal failed: store locked",
    ])
    expect(renderLogoutResultRows(true).map(stripAnsi).join("\n")).toContain("credentials  removed")
    expect(renderLogoutResultRows(false).map(stripAnsi).join("\n")).toContain("(no entry)")
    expect(renderLogoutResultRows(false).map(stripAnsi).join("\n")).toContain("Logged out")
  })
})
