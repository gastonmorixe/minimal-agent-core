import { describe, expect, it } from "bun:test"

import { prepareEntrypointArgs } from "./entry-args.ts"

/** Sentinel thrown by the fake exit so control flow stops like `process.exit`. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

function makeHarness() {
  const writes: string[] = []
  let helpCalls = 0
  const deps = {
    stderr: { write: (s: string) => (writes.push(s), true) as unknown as boolean },
    exit: (code: number): never => {
      throw new ExitSignal(code)
    },
    printHelp: () => {
      helpCalls++
    },
  }
  return { writes, deps, helpCalls: () => helpCalls }
}

describe("prepareEntrypointArgs", () => {
  it("rejects smart-dash flags with exit 2 and a fix-it hint", () => {
    const h = makeHarness()
    let code: number | undefined
    try {
      prepareEntrypointArgs({
        rawArgv: ["--resume\u2013same-sid", "abc"],
        env: {},
        cwd: "/tmp",
        ...h.deps,
      })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(code).toBe(2)
    expect(h.writes.join("")).toContain("non-ASCII dash")
  })

  it("dispatches --help and exits 0 without parsing further", () => {
    const h = makeHarness()
    let code: number | undefined
    try {
      prepareEntrypointArgs({ rawArgv: ["--help"], env: {}, cwd: "/tmp", ...h.deps })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(code).toBe(0)
    expect(h.helpCalls()).toBe(1)
  })

  it("propagates --debug/--verbose/--show-hidden-chars into env", () => {
    const h = makeHarness()
    const env: Record<string, string | undefined> = {}
    prepareEntrypointArgs({
      rawArgv: ["--debug", "--verbose", "--show-hidden-chars", "--skip-quota"],
      env,
      cwd: "/tmp",
      ...h.deps,
    })
    expect(env.DEBUG).toBe("1")
    expect(env.VERBOSE).toBe("1")
    expect(env.MINIMAL_AGENT_SHOW_HIDDEN_CHARS).toBe("1")
  })

  it("returns normalized args, a command plan, and a working readFlagValue", () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["models"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    // `models` subcommand normalizes to --list-models and plans list-models.
    expect(prepared.args).toContain("--list-models")
    expect(prepared.commandPlan.command).toBe("list-models")
    expect(prepared.readFlagValue("--nope")).toBeUndefined()
  })

  it("readFlagValue reads both inline and spaced flag forms", () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["--auth-method=oauth", "hello"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    expect(prepared.readFlagValue("--auth-method")).toBe("oauth")
  })

  it("extractPrompt classifies a literal positional prompt", async () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["hello world"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    expect(await prepared.extractPrompt()).toBe("hello world")
  })

  it("extractPrompt slurps stdin for the `-` sentinel", async () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["-"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    async function* fakeStdin() {
      yield Buffer.from("piped ")
      yield Buffer.from("prompt\n")
    }
    expect(await prepared.extractPrompt(fakeStdin())).toBe("piped prompt")
  })

  it("extractPrompt returns null for interactive (no prompt) args", async () => {
    const h = makeHarness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["--skip-quota"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    expect(await prepared.extractPrompt()).toBeNull()
  })
})
