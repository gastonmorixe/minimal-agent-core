/**
 * Architecture fitness function: core timers are inventoried, and the list
 * only shrinks (spec S43).
 *
 * THE RATCHET: every non-test core file that calls `setTimeout` or
 * `setInterval` must be in `TIMER_INVENTORY` (`timer-inventory.ts`) with its
 * exact call-site count and a reason. The check runs both ways:
 *
 *   - A file with more calls than its entry (or a new file with any) FAILS.
 *     A timer is not a loop (E7), but core does not gain new ones.
 *   - A file with fewer calls than its entry (or none) FAILS too: lower or
 *     remove the entry, so the cleanup cannot regress.
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { countTimerCalls, isTestCode, scanTimerCalls, TIMER_INVENTORY } from "./timer-inventory.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..")

describe("countTimerCalls", () => {
  it("counts setTimeout and setInterval calls", () => {
    const source = [
      "const a = setTimeout(() => {}, 10)",
      "const b = setInterval (tick, 1000)",
      "globalThis.setTimeout(fn, 0)",
    ].join("\n")
    expect(countTimerCalls(source)).toBe(3)
  })

  it("ignores comments, type uses, and injected fields", () => {
    const source = [
      "// setTimeout(() => {}, 10)",
      "/* setInterval(tick, 1) */",
      "let t: ReturnType<typeof setTimeout> | null = null",
      "interface Deps { setTimeout?: (cb: () => void, ms: number) => unknown }",
      "clearTimeout(t)",
    ].join("\n")
    expect(countTimerCalls(source)).toBe(0)
  })
})

describe("isTestCode", () => {
  it("treats test files and src/test-utils as test code", () => {
    expect(isTestCode("src/agent/reflection.test.ts")).toBe(true)
    expect(isTestCode("src/test-utils/fixtures/paste-pty-driver.ts")).toBe(true)
    expect(isTestCode("src/agent/reflection.ts")).toBe(false)
  })
})

describe("core timer inventory (repo ratchet)", () => {
  const actual = scanTimerCalls(REPO_ROOT)

  it("no core file has timer calls beyond its inventory entry", () => {
    const regressions: string[] = []
    for (const [file, n] of actual) {
      const allowed = TIMER_INVENTORY.get(file)?.sites ?? 0
      if (n > allowed) regressions.push(`  ${file}: ${n} timer call(s), inventory ${allowed}`)
    }
    expect(
      regressions,
      regressions.length > 0
        ? "New core timer calls. The inventory only shrinks: use an AbortSignal\n" +
            "timeout, an injected sleep or clock, or a host port instead.\n" +
            regressions.join("\n")
        : "",
    ).toEqual([])
  })

  it("the inventory has no stale entries (removed timers lower the list)", () => {
    const stale: string[] = []
    for (const [file, entry] of TIMER_INVENTORY) {
      const n = actual.get(file) ?? 0
      if (n < entry.sites) stale.push(`  ${file}: inventory ${entry.sites}, actual ${n}`)
    }
    expect(
      stale,
      stale.length > 0
        ? "Timer inventory has stale entries. Lower or remove them:\n" + stale.join("\n")
        : "",
    ).toEqual([])
  })

  it("every entry has a reason", () => {
    const wrong: string[] = []
    for (const [file, entry] of TIMER_INVENTORY) {
      if (entry.reason.trim() === "") wrong.push(`  ${file}: empty reason`)
    }
    expect(wrong).toEqual([])
  })
})
