import { describe, expect, test } from "bun:test"

import {
  fixtureSystemPromptBase,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import {
  buildInstructionsBlockText,
  DEFAULT_INSTRUCTIONS,
  renderInstructions,
} from "./instructions-block.ts"

// The instructions template comes from the real base prompt plugin; core fills agentHome in the ctx.
const BASE = textFixturesPresent() ? { systemPromptBase: fixtureSystemPromptBase() } : {}
const withBase = test.skipIf(!textFixturesPresent())

describe("instructions template: agentHome", () => {
  test("the core template holds the placeholder, not a fixed path", () => {
    expect(DEFAULT_INSTRUCTIONS).toContain("%%agentHome%%")
    expect(DEFAULT_INSTRUCTIONS).not.toContain("~/.minimal-agent")
  })

  withBase("the agentHome option fills every placeholder", () => {
    const text = buildInstructionsBlockText({
      reflectionInterval: 0,
      agentHome: "/srv/ma-home",
      ...BASE,
    })
    expect(text).toContain("`/srv/ma-home/sessions/<session_id>.jsonl`")
    expect(text).toContain("`/srv/ma-home/net-dbg/`")
    expect(text).not.toContain("%%")
  })

  withBase("with no option the resolved MINIMAL_AGENT_HOME is used", () => {
    const old = process.env.MINIMAL_AGENT_HOME
    process.env.MINIMAL_AGENT_HOME = "/env/ma-home"
    try {
      expect(buildInstructionsBlockText({ reflectionInterval: 0, ...BASE })).toContain(
        "`/env/ma-home/`",
      )
    } finally {
      if (old === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = old
    }
  })

  test("text with no placeholder comes back unchanged", () => {
    expect(renderInstructions("plain text\n", "/x")).toBe("plain text\n")
  })
})
