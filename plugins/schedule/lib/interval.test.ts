/**
 * Tests for human-interval → cron conversion.
 *
 * @module schedule/lib/interval.test
 */

import { describe, expect, it } from "bun:test"

import { durationToCron, intervalToCron, parseDuration } from "./interval.ts"

describe("parseDuration", () => {
  it("parses bare tokens", () => {
    expect(parseDuration("5m")).toBe(300)
    expect(parseDuration("30m")).toBe(1800)
    expect(parseDuration("2h")).toBe(7200)
    expect(parseDuration("1d")).toBe(86_400)
    expect(parseDuration("45s")).toBe(45)
  })

  it("parses clauses with words and 'every'", () => {
    expect(parseDuration("every 2 hours")).toBe(7200)
    expect(parseDuration("every 15 minutes")).toBe(900)
    expect(parseDuration("2 hours")).toBe(7200)
    expect(parseDuration("90 min")).toBe(5400)
  })

  it("returns null for non-durations", () => {
    expect(parseDuration("hello")).toBeNull()
    expect(parseDuration("check the deploy")).toBeNull()
    expect(parseDuration("0m")).toBeNull()
    expect(parseDuration("m")).toBeNull()
    expect(parseDuration("")).toBeNull()
  })
})

describe("durationToCron — clean cadences", () => {
  it("maps exact minute divisors", () => {
    expect(intervalToCron("5m")).toMatchObject({ cron: "*/5 * * * *", rounded: false, label: "5m" })
    expect(intervalToCron("30m")).toMatchObject({ cron: "*/30 * * * *", rounded: false })
    expect(intervalToCron("1m")).toMatchObject({ cron: "*/1 * * * *", rounded: false })
  })

  it("maps hourly + hour divisors", () => {
    expect(intervalToCron("60m")).toMatchObject({ cron: "0 * * * *", rounded: false })
    expect(intervalToCron("2h")).toMatchObject({ cron: "0 */2 * * *", rounded: false, label: "2h" })
    expect(intervalToCron("every 2 hours")).toMatchObject({ cron: "0 */2 * * *" })
  })

  it("maps days", () => {
    expect(intervalToCron("1d")).toMatchObject({ cron: "0 0 */1 * *", rounded: false, label: "1d" })
    expect(intervalToCron("3d")).toMatchObject({ cron: "0 0 */3 * *", rounded: false })
  })
})

describe("durationToCron — rounding", () => {
  it("rounds sub-minute up to one minute", () => {
    expect(durationToCron(45)).toMatchObject({
      cron: "*/1 * * * *",
      chosenSeconds: 60,
      rounded: true,
    })
    expect(durationToCron(90)).toMatchObject({
      cron: "*/2 * * * *",
      chosenSeconds: 120,
      rounded: true,
    })
  })

  it("rounds 7m to the nearest minute divisor (6m)", () => {
    expect(intervalToCron("7m")).toMatchObject({ cron: "*/6 * * * *", rounded: true, label: "6m" })
  })

  it("rounds 90m to 2h", () => {
    expect(intervalToCron("90m")).toMatchObject({
      cron: "0 */2 * * *",
      chosenSeconds: 7200,
      rounded: true,
      label: "2h",
    })
  })

  it("rounds odd hours to an hour divisor", () => {
    // 5h → nearest divisor of 24 is 4 or 6; |5-4|=1, |5-6|=1, tie → smaller (4)
    expect(intervalToCron("5h")).toMatchObject({ cron: "0 */4 * * *", rounded: true })
    // 7h → nearest is 6 or 8; tie → 6
    expect(intervalToCron("7h")).toMatchObject({ cron: "0 */6 * * *", rounded: true })
  })

  it("rounds >1 day spans to whole days", () => {
    // 36h → round(36/24)=2 days
    expect(intervalToCron("36h")).toMatchObject({ cron: "0 0 */2 * *", rounded: true, label: "2d" })
  })
})
