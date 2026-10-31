/**
 * Unit tests for the interactive resume decision. Each case runs the real
 * argv path (normalizeArgs, then extractPromptFromArgs), so every prompt
 * form the CLI accepts is covered.
 *
 * @module host/startup/resume-mode.test
 */

import { describe, expect, it } from "bun:test"

import { normalizeArgs } from "../../cli/cli-args.ts"
import { extractPromptFromArgs } from "../../cli/extract-prompt.ts"

import {
  isHostModeRun,
  isInteractiveResumeRun,
  wantsStreamJsonFailureLines,
} from "./resume-mode.ts"

function decide(resumeSid: string | null, raw: string[]): boolean {
  return isInteractiveResumeRun(resumeSid, extractPromptFromArgs(normalizeArgs(raw)))
}

describe("isInteractiveResumeRun", () => {
  it("--prompt x: not interactive", () => {
    expect(decide("sid", ["--resume", "sid", "--prompt", "x"])).toBe(false)
  })

  it("-p x: not interactive", () => {
    expect(decide("sid", ["--resume", "sid", "-p", "x"])).toBe(false)
  })

  it("--prompt=x: not interactive", () => {
    expect(decide("sid", ["--resume", "sid", "--prompt=x"])).toBe(false)
  })

  it("positional prompt: not interactive", () => {
    expect(decide("sid", ["--resume", "sid", "hello"])).toBe(false)
  })

  it("- (stdin): not interactive", () => {
    expect(decide("sid", ["--resume", "sid", "-"])).toBe(false)
  })

  it("no prompt: interactive", () => {
    expect(decide("sid", ["--resume", "sid"])).toBe(true)
  })

  it("--resume abc123 with no prompt: interactive (the id is not a prompt)", () => {
    expect(decide("abc123", ["--resume", "abc123"])).toBe(true)
  })

  it("--resume last with no prompt: interactive", () => {
    expect(decide("sid", ["--resume", "last"])).toBe(true)
  })

  it("no resume: never interactive resume", () => {
    expect(decide(null, [])).toBe(false)
  })
})

describe("wantsStreamJsonFailureLines", () => {
  function wants(raw: string[], format: "text" | "json" | "stream-json", schema = false): boolean {
    return wantsStreamJsonFailureLines({
      outputFormat: format,
      hasOutputSchema: schema,
      promptSource: extractPromptFromArgs(normalizeArgs(raw)),
    })
  }

  it("stream-json with a prompt: yes", () => {
    expect(wants(["-p", "go"], "stream-json")).toBe(true)
    expect(wants(["go"], "stream-json")).toBe(true)
    expect(wants(["-"], "stream-json")).toBe(true)
  })

  it("stream-json with NO prompt (the REPL): no JSON on the TTY", () => {
    expect(wants([], "stream-json")).toBe(false)
    expect(wants(["--resume", "abc123"], "stream-json")).toBe(false)
  })

  it("json, text, or --output-schema: no", () => {
    expect(wants(["-p", "go"], "json")).toBe(false)
    expect(wants(["-p", "go"], "text")).toBe(false)
    expect(wants(["-p", "go"], "stream-json", true)).toBe(false)
  })

  it("agrees with the resume decision: a non-interactive resume gets JSON lines", () => {
    for (const raw of [
      ["--resume", "s", "-p", "x"],
      ["--resume", "s", "x"],
      ["--resume", "s"],
    ]) {
      const ps = extractPromptFromArgs(normalizeArgs(raw))
      const json = wantsStreamJsonFailureLines({
        outputFormat: "stream-json",
        hasOutputSchema: false,
        promptSource: ps,
      })
      expect(json).toBe(!isInteractiveResumeRun("s", ps))
    }
  })
})

describe("isHostModeRun", () => {
  it("is true only for the host-mode command", () => {
    expect(isHostModeRun("host-mode")).toBe(true)
    for (const command of ["run", "login", "sessions", "auth-status", ""]) {
      expect(isHostModeRun(command)).toBe(false)
    }
  })

  it("a bare --host-mode <id> run is not taken for an interactive resume prompt", () => {
    const ps = extractPromptFromArgs(normalizeArgs(["--host-mode", "acp"]))
    expect(ps).toEqual({ kind: "none" })
  })
})
