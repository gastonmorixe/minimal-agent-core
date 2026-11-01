/**
 * Unit tests for the pure slash-command line parser.
 *
 * @module slash-command-parse.test
 */

import { describe, expect, it } from "bun:test"

import { looksLikeCommand, parseCommandLine } from "./slash-command-parse.ts"

describe("parseCommandLine", () => {
  it("parses a bare command (no args)", () => {
    expect(parseCommandLine("/loop")).toEqual({ name: "loop", argv: "" })
  })

  it("parses a command with args, trimming the argv", () => {
    expect(parseCommandLine("/loop 5m check the deploy")).toEqual({
      name: "loop",
      argv: "5m check the deploy",
    })
    expect(parseCommandLine("/loop    spaced   ")).toEqual({ name: "loop", argv: "spaced" })
  })

  it("keeps embedded newlines in argv (multi-line prompt)", () => {
    expect(parseCommandLine("/loop do X\nthen Y")).toEqual({ name: "loop", argv: "do X\nthen Y" })
  })

  it("accepts tabs as the name/argv separator", () => {
    expect(parseCommandLine("/schedule\t0 9 * * *")).toEqual({
      name: "schedule",
      argv: "0 9 * * *",
    })
  })

  it("allows digits, dashes, underscores in the name", () => {
    expect(parseCommandLine("/review-pr 1234")).toEqual({ name: "review-pr", argv: "1234" })
    expect(parseCommandLine("/g2_go")).toEqual({ name: "g2_go", argv: "" })
  })

  it("rejects a path-like slash token (no command)", () => {
    expect(parseCommandLine("/usr/bin/env node")).toBeNull()
    expect(parseCommandLine("/etc/passwd")).toBeNull()
  })

  it("rejects a lone slash and an empty string", () => {
    expect(parseCommandLine("/")).toBeNull()
    expect(parseCommandLine("")).toBeNull()
  })

  it("rejects when the slash is not at column 0", () => {
    expect(parseCommandLine(" /loop")).toBeNull()
    expect(parseCommandLine("please /loop")).toBeNull()
  })

  it("rejects an uppercase name (commands are lowercase)", () => {
    expect(parseCommandLine("/LOOP")).toBeNull()
  })

  it("rejects a name starting with a dash", () => {
    expect(parseCommandLine("/-x")).toBeNull()
  })

  it("does not treat normal prose with a slash as a command", () => {
    expect(parseCommandLine("and/or maybe")).toBeNull()
    expect(parseCommandLine("50/50 odds")).toBeNull()
  })
})

describe("looksLikeCommand", () => {
  it("is true for a slash + name-start char", () => {
    expect(looksLikeCommand("/l")).toBe(true)
    expect(looksLikeCommand("/loop 5m")).toBe(true)
    expect(looksLikeCommand("/9")).toBe(true)
  })

  it("is false for lone slash, empty, indented, or non-name", () => {
    expect(looksLikeCommand("/")).toBe(false)
    expect(looksLikeCommand("")).toBe(false)
    expect(looksLikeCommand(" /loop")).toBe(false)
    expect(looksLikeCommand("/-x")).toBe(false)
    expect(looksLikeCommand("hello")).toBe(false)
  })
})
