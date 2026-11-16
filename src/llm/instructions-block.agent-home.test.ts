import { describe, expect, test } from "bun:test"

import {
  buildInstructionsBlockText,
  DEFAULT_INSTRUCTIONS,
  renderInstructions,
} from "./instructions-block.ts"

describe("instructions template: agentHome", () => {
  test("the core template holds the placeholder, not a fixed path", () => {
    expect(DEFAULT_INSTRUCTIONS).toContain("%%agentHome%%")
    expect(DEFAULT_INSTRUCTIONS).not.toContain("~/.minimal-agent")
  })

  test("the agentHome option fills every placeholder", () => {
    const text = buildInstructionsBlockText({ reflectionInterval: 0, agentHome: "/srv/ma-home" })
    expect(text).toContain("`/srv/ma-home/sessions/<session_id>.jsonl`")
    expect(text).toContain("`/srv/ma-home/net-dbg/`")
    expect(text).not.toContain("%%")
  })

  test("with no option the resolved MINIMAL_AGENT_HOME is used", () => {
    const old = process.env.MINIMAL_AGENT_HOME
    process.env.MINIMAL_AGENT_HOME = "/env/ma-home"
    try {
      expect(buildInstructionsBlockText({ reflectionInterval: 0 })).toContain("`/env/ma-home/`")
    } finally {
      if (old === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = old
    }
  })

  test("text with no placeholder comes back unchanged", () => {
    expect(renderInstructions("plain text\n", "/x")).toBe("plain text\n")
  })
})
