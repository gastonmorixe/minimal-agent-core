/**
 * Unit tests for the `--debug` / `--verbose` request dump.
 *
 * Regression context: the request dump (model / max_tokens / messages /
 * system / tools printed to stderr) used to live inline in the legacy
 * `sendMessage` (src/client.ts). When the default transport flipped to the
 * canonical path (`canonicalSendFn`), nothing called those printers anymore,
 * so `--debug` produced no request dump and `--verbose` had nothing to
 * un-truncate. `debugRequestOptions` is the extracted, transport-agnostic
 * dump that both paths can call; these tests pin its behavior.
 *
 * @module client/debug.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth.ts"

import { debugRequestOptions } from "./debug.ts"
import type { Message } from "./types.ts"

describe("debugRequestOptions", () => {
  let lines: string[]
  let origError: typeof console.error
  const prevDebug = process.env.DEBUG
  const prevVerbose = process.env.VERBOSE

  beforeEach(() => {
    lines = []
    origError = console.error
    console.error = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "))
    }
  })

  afterEach(() => {
    console.error = origError
    if (prevDebug === undefined) delete process.env.DEBUG
    else process.env.DEBUG = prevDebug
    if (prevVerbose === undefined) delete process.env.VERBOSE
    else process.env.VERBOSE = prevVerbose
  })

  const auth: AuthResult = { type: "oauth", token: "tok" }
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hello there" }] }]

  it("prints the request dump (model, max_tokens, messages, tools) when DEBUG=1", () => {
    process.env.DEBUG = "1"
    debugRequestOptions({
      auth,
      messages,
      model: "model-under-test",
      stream: true,
      maxTokens: 1234,
      requestType: "conversation",
      system: [{ type: "text", text: "You are Minimal Agent, a helpful assistant." }],
      tools: [{ name: "Bash", description: "run a command", input_schema: {} }],
    })
    const out = lines.join("\n")
    expect(out).toContain("model-under-test")
    expect(out).toContain("max_tokens")
    expect(out).toContain("1234")
    expect(out).toContain("message(s)")
    expect(out).toContain("Bash")
  })

  it("is a no-op when DEBUG is unset", () => {
    delete process.env.DEBUG
    debugRequestOptions({ auth, messages, model: "model-under-test" })
    expect(lines).toEqual([])
  })

  it("does not truncate a long system block under VERBOSE", () => {
    process.env.DEBUG = "1"
    process.env.VERBOSE = "1"
    const longText = `You are Minimal Agent. ${"x".repeat(400)} END-OF-SYSTEM-MARKER`
    debugRequestOptions({
      auth,
      messages,
      model: "model-under-test",
      system: [{ type: "text", text: longText }],
    })
    const out = lines.join("\n")
    // Verbose disables the 80-char clamp, so the tail marker survives.
    expect(out).toContain("END-OF-SYSTEM-MARKER")
  })
})
