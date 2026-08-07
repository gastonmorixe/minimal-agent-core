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

  test("documents --no-agents-md and MINIMAL_AGENT_NO_AGENTS_MD", () => {
    const text = stripAnsi(renderHelp().join("\n"))
    expect(text).toContain("--no-agents-md")
    expect(text).toContain("Skip AGENTS.md injection")
    expect(text).toContain("MINIMAL_AGENT_NO_AGENTS_MD=1")
    expect(text).toContain("--disable-plugin agents-md")
  })

  test("leads with runnable examples and the command map", () => {
    const text = stripAnsi(renderHelp().join("\n"))
    expect(text).toContain("Start here")
    expect(text).toContain('minimal-agent "explain this codebase"')
    expect(text).toContain('echo "summarize stdin" | minimal-agent -')
    expect(text).toContain("Command map")
    expect(text).toContain("providers models-live")
    expect(text).toContain("Every command also accepts --help")
  })

  test("documents current output, auth, and command aliases", () => {
    const text = stripAnsi(renderHelp().join("\n"))
    expect(text).toContain("--output-format <text|json|stream-json>")
    expect(text).toContain("--json is an alias for --output-format json")
    expect(text).toContain("--format, --surface <id>")
    expect(text).toContain("--auth-method <oauth|api-key>")
    expect(text).toContain("--email, --email-hint <address>")
    expect(text).toContain("--list-providers")
    expect(text).toContain("--usage-stats")
    expect(text).toContain("resume-same <sid|last>")
  })
})
