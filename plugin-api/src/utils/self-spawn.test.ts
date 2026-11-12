import { describe, expect, it } from "bun:test"

import {
  AGENT_BIN_ENV,
  assertScriptId,
  BUN_BE_BUN_ENV,
  childEnv,
  isStandaloneExecutable,
  isValidScriptId,
  RUN_SCRIPT_ARG,
  selfSpawn,
} from "./self-spawn.ts"

const SOURCE = {
  argv: ["/opt/bun/bin/bun", "/repo/minimal-agent-cli/src/index.ts", "-p", "hi"],
  execPath: "/opt/bun/bin/bun",
  standalone: false,
  env: {},
} as const

const COMPILED = {
  argv: ["bun", "/$bunfs/root/minimal-agent", "-p", "hi"],
  execPath: "/usr/local/bin/minimal-agent",
  standalone: true,
  env: {},
} as const

describe("isStandaloneExecutable", () => {
  it("is false under bun test (a source run)", () => {
    expect(isStandaloneExecutable()).toBe(false)
  })
})

describe("selfSpawn: source run", () => {
  const self = selfSpawn(SOURCE)

  it("agent() re-runs bun with the absolute CLI entry", () => {
    expect(self.agent()).toEqual(["/opt/bun/bin/bun", "/repo/minimal-agent-cli/src/index.ts"])
  })

  it("agent() falls back to [execPath] when argv has no entry", () => {
    expect(selfSpawn({ ...SOURCE, argv: ["/opt/bun/bin/bun"] }).agent()).toEqual([
      "/opt/bun/bin/bun",
    ])
  })

  it("script() runs the dev path with bun", () => {
    expect(self.script("background/runner", "/repo/plugins/bg/bin/runner.ts")).toEqual([
      "/opt/bun/bin/bun",
      "/repo/plugins/bg/bin/runner.ts",
    ])
  })

  it("script() rejects a relative dev path", () => {
    expect(() => self.script("background/runner", "bin/runner.ts")).toThrow(/absolute/)
  })
})

describe("selfSpawn: compiled binary", () => {
  const self = selfSpawn(COMPILED)

  it("agent() is the binary alone (argv[1] is a /$bunfs path)", () => {
    expect(self.agent()).toEqual(["/usr/local/bin/minimal-agent"])
  })

  it("script() goes through the __run dispatch, ignoring the dev path", () => {
    expect(self.script("fetch/obscura", "/$bunfs/root/obscura.ts")).toEqual([
      "/usr/local/bin/minimal-agent",
      RUN_SCRIPT_ARG,
      "fetch/obscura",
    ])
    expect(RUN_SCRIPT_ARG).toBe("__run")
  })
})

describe("selfSpawn: MINIMAL_AGENT_BIN override", () => {
  it("wins in a source run, split on whitespace", () => {
    const self = selfSpawn({ ...SOURCE, env: { [AGENT_BIN_ENV]: "  bun   /x/src/index.ts  " } })
    expect(self.agent()).toEqual(["bun", "/x/src/index.ts"])
  })

  it("wins in a compiled binary too", () => {
    const self = selfSpawn({ ...COMPILED, env: { [AGENT_BIN_ENV]: "/opt/ma --flag" } })
    expect(self.agent()).toEqual(["/opt/ma", "--flag"])
  })

  it("a blank override is ignored", () => {
    const self = selfSpawn({ ...COMPILED, env: { [AGENT_BIN_ENV]: "   " } })
    expect(self.agent()).toEqual(["/usr/local/bin/minimal-agent"])
  })

  it("does not change script()", () => {
    const self = selfSpawn({ ...COMPILED, env: { [AGENT_BIN_ENV]: "/opt/ma" } })
    expect(self.script("a/b", "/z.ts")).toEqual(["/usr/local/bin/minimal-agent", "__run", "a/b"])
  })

  it("reads the env when agent() runs, not when selfSpawn() is called", () => {
    const env: Record<string, string | undefined> = {}
    const self = selfSpawn({ ...SOURCE, env })
    env[AGENT_BIN_ENV] = "/late/bin"
    expect(self.agent()).toEqual(["/late/bin"])
  })
})

describe("script id validation", () => {
  const valid = ["background/runner", "fetch/obscura", "chrome-cdp/cdp-server", "a_1/b-2", "x/y"]
  const invalid = [
    "",
    "runner",
    "a/b/c",
    "../etc/passwd",
    "a/..",
    "../a",
    "/abs/path",
    "a/",
    "/b",
    "a/b.ts",
    "A/b",
    "a b/c",
    "-a/b",
    "a/_b",
    "a\\b",
    "a/b\n",
  ]

  it.each(valid)("accepts %p", (id) => {
    expect(isValidScriptId(id)).toBe(true)
    expect(() => selfSpawn(COMPILED).script(id, "/d.ts")).not.toThrow()
  })

  it.each(invalid)("rejects %p in both modes", (id) => {
    expect(isValidScriptId(id)).toBe(false)
    expect(() => assertScriptId(id)).toThrow(/invalid embedded script id/)
    expect(() => selfSpawn(COMPILED).script(id, "/d.ts")).toThrow(/invalid embedded script id/)
    expect(() => selfSpawn(SOURCE).script(id, "/d.ts")).toThrow(/invalid embedded script id/)
  })

  it("rejects a non-string", () => {
    expect(isValidScriptId(undefined)).toBe(false)
    expect(isValidScriptId(42)).toBe(false)
  })
})

describe("childEnv", () => {
  it("drops BUN_BE_BUN and undefined values, keeps the rest", () => {
    const src = { PATH: "/bin", [BUN_BE_BUN_ENV]: "1", GONE: undefined, EMPTY: "" }
    expect(childEnv(src)).toEqual({ PATH: "/bin", EMPTY: "" })
  })

  it("returns a copy and leaves the input alone", () => {
    const src: Record<string, string> = { A: "1", [BUN_BE_BUN_ENV]: "1" }
    const out = childEnv(src)
    out.A = "2"
    expect(src).toEqual({ A: "1", [BUN_BE_BUN_ENV]: "1" })
  })

  it("defaults to process.env", () => {
    const out = childEnv()
    expect(out.PATH).toBe(process.env.PATH as string)
    expect(BUN_BE_BUN_ENV in out).toBe(false)
  })

  it("is the same function on a SelfSpawn", () => {
    expect(selfSpawn(SOURCE).childEnv({ X: "1", BUN_BE_BUN: "1" })).toEqual({ X: "1" })
  })
})
