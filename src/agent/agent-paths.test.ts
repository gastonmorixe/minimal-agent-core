import { homedir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  AGENT_HOME_ENV,
  publishAgentHomeEnv,
  resolveAgentHome,
  resolveNetDbgDir,
  resolveSessionsDir,
} from "./agent-paths.ts"

// The deep resolution semantics are pinned in the leaf package's own test
// (`plugin-api/src/utils/agent-paths.test.ts`). These cases verify the host
// re-export surface is wired (the same functions reach `src/` callers) and
// cover the host-only `publishAgentHomeEnv`.

describe("resolveAgentHome (re-exported from leaf)", () => {
  it("defaults to ~/.minimal-agent when no override", () => {
    expect(resolveAgentHome({})).toBe(join(homedir(), ".minimal-agent"))
  })

  it("honors MINIMAL_AGENT_HOME override", () => {
    expect(resolveAgentHome({ [AGENT_HOME_ENV]: "/tmp/ma-relocated" })).toBe("/tmp/ma-relocated")
  })
})

describe("resolveSessionsDir (re-exported from leaf)", () => {
  it("is <home>/sessions", () => {
    expect(resolveSessionsDir({ [AGENT_HOME_ENV]: "/tmp/ma" })).toBe("/tmp/ma/sessions")
  })
})

describe("resolveNetDbgDir (re-exported from leaf)", () => {
  it("is <home>/net-dbg", () => {
    expect(resolveNetDbgDir({ [AGENT_HOME_ENV]: "/tmp/ma" })).toBe("/tmp/ma/net-dbg")
  })
})

describe("publishAgentHomeEnv", () => {
  it("writes the resolved default into the env object and returns it", () => {
    const env: NodeJS.ProcessEnv = {}
    const home = publishAgentHomeEnv(env)
    expect(home).toBe(join(homedir(), ".minimal-agent"))
    expect(env[AGENT_HOME_ENV]).toBe(home)
  })

  it("preserves (does not clobber) an existing override", () => {
    const env: NodeJS.ProcessEnv = { [AGENT_HOME_ENV]: "/tmp/ma-custom" }
    const home = publishAgentHomeEnv(env)
    expect(home).toBe("/tmp/ma-custom")
    expect(env[AGENT_HOME_ENV]).toBe("/tmp/ma-custom")
  })

  it("is idempotent", () => {
    const env: NodeJS.ProcessEnv = {}
    const a = publishAgentHomeEnv(env)
    const b = publishAgentHomeEnv(env)
    expect(a).toBe(b)
    expect(env[AGENT_HOME_ENV]).toBe(b)
  })
})
