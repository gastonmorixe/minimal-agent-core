import { describe, expect, test } from "bun:test"

import { stripAnsi } from "../../terminal/term-width.ts"

import { renderHelp } from "./help.ts"

describe("renderHelp", () => {
  test("documents plugin enable/disable CLI, env, and list subcommand", () => {
    const text = stripAnsi(renderHelp().join("\n"))
    expect(text).toContain("--disable-plugin")
    expect(text).toContain("--enable-plugin")
    expect(text).toContain("plugins list")
    expect(text).toContain("--list-plugins")
    expect(text).toContain("CLI → env → config → manifest")
    expect(text).toContain("MINIMAL_AGENT_DISABLE_PLUGINS")
    expect(text).toContain("MINIMAL_AGENT_ENABLE_PLUGINS")
    expect(text).toContain("minimal-agent --disable-plugin web-search,memory")
  })

  test("documents --tools allow-list and --no-tools", () => {
    const text = stripAnsi(renderHelp().join("\n"))
    expect(text).toContain("--tools <names>")
    expect(text).toContain("--no-tools")
    expect(text).toContain("Advertise only these tools")
    expect(text).toContain("Advertise no tools (pure Q&A)")
    expect(text).toContain('e.g. --tools "WebSearch,Task"')
  })
})
