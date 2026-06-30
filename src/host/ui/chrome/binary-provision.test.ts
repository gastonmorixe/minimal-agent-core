import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../../../term-width.ts"

import { renderBinaryProvisionHalt } from "./binary-provision.ts"

describe("binary provision chrome", () => {
  it("renders fatal setup rows without owning provisioning logic", () => {
    expect(
      renderBinaryProvisionHalt({
        pluginId: "test-plugin",
        message: "first line\nsecond line",
      }).map(stripAnsi),
    ).toEqual([
      "",
      "  ✗ Setup incomplete (test-plugin)",
      "  │ first line",
      "  │ second line",
      "  ╰ fix the above, then re-run. Skip this check with MINIMAL_AGENT_NO_BINARY_SETUP=1.",
    ])
  })
})
