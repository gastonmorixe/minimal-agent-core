/**
 * `BUN_BE_BUN` never reaches a plugin subprocess handler.
 *
 * In a compiled binary `BUN_BE_BUN=1` turns the binary into the plain `bun`
 * CLI, and Bun reads it from the environment of every descendant. So the
 * handler env (`buildHandlerEnv`, which is `ctx.env`) drops it, and each
 * subprocess spawn passes its env through `childEnv` again, for a context
 * that a caller built by hand. See `plugin-api/utils/self-spawn`.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { EventHandlerContext, TUIContext } from "../types.ts"

import { invokeEventSubprocess } from "./event-subs.ts"
import { buildHandlerEnv } from "./handler-env.ts"
import { invokeSubprocess } from "./helpers.ts"

/** Write an executable `sh` script and return its absolute path. */
function writeScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ma-handler-env-"))
  const path = join(dir, "handler.sh")
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe("plugin handler env drops BUN_BE_BUN", () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.BUN_BE_BUN
    process.env.BUN_BE_BUN = "1"
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.BUN_BE_BUN
    else process.env.BUN_BE_BUN = saved
  })

  it("buildHandlerEnv has no BUN_BE_BUN and keeps the rest", () => {
    const env = buildHandlerEnv(undefined)
    expect(env.BUN_BE_BUN).toBeUndefined()
    expect(env.PATH).toBe(process.env.PATH as string)
  })

  it("a tool subprocess handler does not see it, even from a hand-built ctx.env", async () => {
    const script = writeScript('cat >/dev/null\nprintf "%s" "${BUN_BE_BUN-unset}"')
    const dir = join(script, "..")
    const ctx = {
      trigger: { type: "tool", name: "EnvTool", input: {}, tool_use_id: "toolu_env_1" },
      packageDir: dir,
      cwd: dir,
      env: { ...process.env, BUN_BE_BUN: "1" } as Record<string, string>,
      log: () => {},
    } as unknown as TUIContext
    const result = await invokeSubprocess(script, [], ctx)
    expect(result).toMatchObject({ kind: "tool_result", content: "unset" })
  })

  it("an event subprocess handler does not see it", async () => {
    const script = writeScript('cat >/dev/null\nprintf "%s" "${BUN_BE_BUN-unset}" > "$1"')
    const dir = join(script, "..")
    const out = join(dir, "out.txt")
    const ctx = {
      event: "session.start",
      payload: {},
      packageDir: dir,
      cwd: dir,
      env: { ...process.env, BUN_BE_BUN: "1" } as Record<string, string>,
      emit: () => {},
      log: () => {},
    } as unknown as EventHandlerContext
    await invokeEventSubprocess(script, [out], ctx)
    expect(readFileSync(out, "utf8")).toBe("unset")
  })
})
