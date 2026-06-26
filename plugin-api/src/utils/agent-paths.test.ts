import { describe, expect, it } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  AGENT_HOME_ENV,
  resolveAgentHome,
  resolveNetDbgDir,
  resolveSessionsDir,
} from "./agent-paths.ts"

describe("resolveAgentHome", () => {
  it("defaults to <homedir>/.minimal-agent when neither override nor HOME is set", () => {
    expect(resolveAgentHome({})).toBe(join(homedir(), ".minimal-agent"))
  })

  it("honors MINIMAL_AGENT_HOME override verbatim (already absolute)", () => {
    expect(resolveAgentHome({ [AGENT_HOME_ENV]: "/tmp/ma-relocated" })).toBe("/tmp/ma-relocated")
  })

  it("trims surrounding whitespace from the override", () => {
    expect(resolveAgentHome({ [AGENT_HOME_ENV]: "  /tmp/x  " })).toBe("/tmp/x")
  })

  it("treats a whitespace-only override as unset and falls through", () => {
    expect(resolveAgentHome({ [AGENT_HOME_ENV]: "   " })).toBe(join(homedir(), ".minimal-agent"))
  })

  it("falls back to $HOME before os.homedir() so a HOME-only sandbox is honored", () => {
    expect(resolveAgentHome({ HOME: "/tmp/sandbox" })).toBe(join("/tmp/sandbox", ".minimal-agent"))
  })

  it("prefers the override over HOME when both are set", () => {
    expect(resolveAgentHome({ [AGENT_HOME_ENV]: "/tmp/override", HOME: "/tmp/home" })).toBe(
      "/tmp/override",
    )
  })

  it("reads process.env by default (no arg)", () => {
    // Smoke: the no-arg form must not throw and must return an absolute path
    // ending in the agent dir (or the published override).
    const p = resolveAgentHome()
    expect(p.length).toBeGreaterThan(0)
  })
})

describe("resolveSessionsDir", () => {
  it("is <home>/sessions", () => {
    expect(resolveSessionsDir({ [AGENT_HOME_ENV]: "/tmp/ma" })).toBe("/tmp/ma/sessions")
  })

  it("composes from the resolved default home", () => {
    expect(resolveSessionsDir({ HOME: "/tmp/h" })).toBe(join("/tmp/h", ".minimal-agent", "sessions"))
  })
})

describe("resolveNetDbgDir", () => {
  it("is <home>/net-dbg", () => {
    expect(resolveNetDbgDir({ [AGENT_HOME_ENV]: "/tmp/ma" })).toBe("/tmp/ma/net-dbg")
  })

  it("composes from the resolved default home (NOT the cwd)", () => {
    expect(resolveNetDbgDir({ HOME: "/tmp/h" })).toBe(join("/tmp/h", ".minimal-agent", "net-dbg"))
  })

  it("honors the override the same way the home resolver does", () => {
    expect(resolveNetDbgDir({ [AGENT_HOME_ENV]: "  /tmp/reloc  " })).toBe("/tmp/reloc/net-dbg")
  })
})
