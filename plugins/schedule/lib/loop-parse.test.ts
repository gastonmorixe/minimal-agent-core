/**
 * Tests for the /loop and /schedule argument parsers.
 *
 * @module schedule/lib/loop-parse.test
 */

import { describe, expect, it } from "bun:test"

import { parseLoopArgs, parseScheduleArgs } from "./loop-parse.ts"

describe("parseLoopArgs", () => {
  it("leading bare interval + prompt", () => {
    expect(parseLoopArgs("5m check the deploy")).toEqual({
      interval: "5m",
      prompt: "check the deploy",
    })
  })

  it("leading 'every N unit' clause", () => {
    expect(parseLoopArgs("every 2 hours check CI")).toEqual({
      interval: "every 2 hours",
      prompt: "check CI",
    })
  })

  it("prompt only (self-paced)", () => {
    expect(parseLoopArgs("check CI and address review comments")).toEqual({
      interval: null,
      prompt: "check CI and address review comments",
    })
  })

  it("bare interval, no prompt", () => {
    expect(parseLoopArgs("30m")).toEqual({ interval: "30m", prompt: "" })
  })

  it("empty argv", () => {
    expect(parseLoopArgs("")).toEqual({ interval: null, prompt: "" })
  })

  it("interval + nested command as the prompt", () => {
    expect(parseLoopArgs("20m /review-pr 1234")).toEqual({
      interval: "20m",
      prompt: "/review-pr 1234",
    })
  })

  it("non-interval leading token is part of the prompt", () => {
    expect(parseLoopArgs("5x check the thing")).toEqual({
      interval: null,
      prompt: "5x check the thing",
    })
  })
})

describe("parseScheduleArgs", () => {
  it("empty → usage", () => {
    expect(parseScheduleArgs("")).toEqual({ kind: "usage" })
  })

  it("list", () => {
    expect(parseScheduleArgs("list")).toEqual({ kind: "list" })
    expect(parseScheduleArgs("LIST")).toEqual({ kind: "list" })
  })

  it("cancel <id>", () => {
    expect(parseScheduleArgs("cancel a1b2c3d4")).toEqual({ kind: "cancel", id: "a1b2c3d4" })
  })

  it("quoted cron + prompt", () => {
    expect(parseScheduleArgs('"0 9 * * 1-5" run the morning report')).toEqual({
      kind: "create",
      cron: "0 9 * * 1-5",
      prompt: "run the morning report",
    })
    expect(parseScheduleArgs("'*/5 * * * *' poll the deploy")).toEqual({
      kind: "create",
      cron: "*/5 * * * *",
      prompt: "poll the deploy",
    })
  })

  it("unquoted 5-field cron + prompt", () => {
    expect(parseScheduleArgs("0 9 * * 1-5 run the report")).toEqual({
      kind: "create",
      cron: "0 9 * * 1-5",
      prompt: "run the report",
    })
  })

  it("too few tokens → error", () => {
    expect(parseScheduleArgs("0 9 * *").kind).toBe("error")
  })

  it("quoted cron with no prompt → error", () => {
    expect(parseScheduleArgs('"0 9 * * *"').kind).toBe("error")
  })
})
