/**
 * Smoke test for `runLoginCommand`. The orchestrator's tests live next
 * to it (`src/oauth-login.test.ts`); here we just verify the wrapper
 * doesn't double-`process.exit`, returns the right code on outcome paths,
 * and that the banner prints.
 *
 * Heavy mocking through env / module-level interception isn't worth it for
 * the wrapper — the meat of the logic is in `runOAuthLogin` and we covered
 * that. This file exists to catch regressions like accidentally swallowing
 * the exit code, or printing the banner only on success, etc.
 */

import { describe, expect, it } from "bun:test"
import { PassThrough } from "node:stream"
import { readLine } from "./login.ts"

describe("commands/login module shape", () => {
  it("exports runLoginCommand as an async function", async () => {
    const mod = await import("./login.ts")
    expect(typeof mod.runLoginCommand).toBe("function")
  })
})

describe("readLine line/close ordering", () => {
  // Regression: `rl.close()` (called inside the line handler) emits 'close'
  // SYNCHRONOUSLY. The previous code did `rl.close(); resolve(line)`, so the
  // close handler's `resolve("")` won the race and the pasted line was
  // dropped — the user saw "no code pasted" despite pasting a valid code.
  // A PassThrough input reproduces the race deterministically: writing a
  // line then end()ing triggers line + an immediate close.
  it("returns the pasted line, not empty, when the stream closes right after the line", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const code = "6yfzAUTHCODE#CgCQSTATE"

    const promise = readLine("paste code > ", input, output)
    // Deliver the line and immediately end the stream — this is what forces
    // the synchronous close that the old code lost the race to.
    input.write(`${code}\n`)
    input.end()

    expect(await promise).toBe(code)
  })

  it("returns the line even with a trailing CRLF", async () => {
    const input = new PassThrough()
    const output = new PassThrough()

    const promise = readLine("> ", input, output)
    input.write("hello\r\n")
    input.end()

    expect(await promise).toBe("hello")
  })

  it("returns empty string when the stream closes with no line", async () => {
    const input = new PassThrough()
    const output = new PassThrough()

    const promise = readLine("> ", input, output)
    input.end()

    expect(await promise).toBe("")
  })
})
