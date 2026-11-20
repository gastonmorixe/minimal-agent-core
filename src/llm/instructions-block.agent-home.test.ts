import { describe, expect, test } from "bun:test"

import {
  fixtureSystemPromptBase,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { buildInstructionsBlockText, renderInstructions } from "./instructions-block.ts"

// The instructions template comes from the real base prompt plugin; core fills agentHome in the ctx.
const BASE = textFixturesPresent() ? { systemPromptBase: fixtureSystemPromptBase() } : {}
const withBase = test.skipIf(!textFixturesPresent())

describe("instructions template: agentHome", () => {
  test("core holds no template: with no base provider the block is empty", () => {
    expect(buildInstructionsBlockText({ agentHome: "/x" })).toBe("")
  })

  test("caller instructions get every agentHome placeholder filled", () => {
    expect(renderInstructions("a %%agentHome%% b %%agentHome%%", "/h")).toBe("a /h b /h")
  })

  withBase("the agentHome option fills every placeholder", () => {
    const text = buildInstructionsBlockText({ agentHome: "/srv/ma-home", ...BASE })
    expect(text).toContain("`/srv/ma-home/sessions/<session_id>.jsonl`")
    expect(text).toContain("`/srv/ma-home/net-dbg/`")
    expect(text).not.toContain("%%")
  })

  withBase("with no option the resolved MINIMAL_AGENT_HOME is used", () => {
    const old = process.env.MINIMAL_AGENT_HOME
    process.env.MINIMAL_AGENT_HOME = "/env/ma-home"
    try {
      expect(buildInstructionsBlockText({ ...BASE })).toContain("`/env/ma-home/`")
    } finally {
      if (old === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = old
    }
  })

  test("text with no placeholder comes back unchanged", () => {
    expect(renderInstructions("plain text\n", "/x")).toBe("plain text\n")
  })
})
