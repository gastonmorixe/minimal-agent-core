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

import { PassThrough } from "node:stream"

import { afterEach, describe, expect, it } from "bun:test"

import { clearProviderPlugins, registerProviderPlugin } from "../../llm/provider-plugin.ts"
import { readSecureInput } from "../ui/secure-input.ts"

import { readLine, runLoginCommand } from "./login.ts"

afterEach(() => {
  clearProviderPlugins()
})

describe("commands/login module shape", () => {
  it("exports runLoginCommand as an async function", async () => {
    const mod = await import("./login.ts")
    expect(typeof mod.runLoginCommand).toBe("function")
  })
})

describe("runLoginCommand", () => {
  it("writes non-TTY failure through injected output", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean }
    input.isTTY = false
    let out = ""

    const code = await runLoginCommand({
      input,
      output: { write: (s: string) => ((out += s), true) } as NodeJS.WritableStream,
    })

    expect(code).toBe(1)
    expect(out).toContain("--login requires an interactive terminal")
  })

  it("returns 130 when API-key entry is aborted with Ctrl+C", async () => {
    registerProviderPlugin({
      id: "test-provider",
      displayName: "Test Provider",
      shortCode: "test",
      register() {},
      apiKeyAuth: {
        serviceId: "test-api-key",
        displayName: "Test API Key",
        buildCredential: (apiKey) => ({
          serviceId: "test-api-key",
          displayName: "Test API Key",
          secrets: { apiKey },
        }),
        readApiKey: (secrets) => (typeof secrets.apiKey === "string" ? secrets.apiKey : null),
      },
    })
    const input = new PassThrough() as PassThrough & {
      isRaw?: boolean
      isTTY?: boolean
      setRawMode?: (mode: boolean) => void
    }
    input.isTTY = true
    input.isRaw = false
    input.setRawMode = (mode) => {
      input.isRaw = mode
    }
    let out = ""

    const promise = runLoginCommand({
      providerId: "test-provider",
      authMethod: "api-key",
      input,
      output: { write: (s: string) => ((out += s), true) } as NodeJS.WritableStream,
    })
    input.write("\x03")

    expect(await promise).toBe(130)
    expect(input.isRaw).toBe(false)
    expect(out).toContain("aborted")
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

  it("rejects when readline receives SIGINT", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean }
    input.isTTY = true
    const output = new PassThrough()

    const promise = readLine("> ", input, output)
    input.write("\x03")

    await expect(promise).rejects.toThrow("login aborted")
  })
})

describe("readSecureInput", () => {
  it("returns null on Ctrl+C and restores raw mode", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean
      isRaw?: boolean
      setRawMode?: (mode: boolean) => void
    }
    input.isTTY = true
    input.isRaw = false
    input.setRawMode = (mode) => {
      input.isRaw = mode
    }
    const output = new PassThrough()

    const promise = readSecureInput("> ", { input, output })
    input.write("\x03")

    const result = await promise
    expect(result).toBeNull()
    expect(input.isRaw).toBe(false)
  })
})
