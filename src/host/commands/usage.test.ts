import { afterEach, describe, expect, it } from "bun:test"

import { runUsageCommand } from "./usage.ts"

describe("runUsageCommand", () => {
  const previousExitCode = process.exitCode

  afterEach(() => {
    process.exitCode = previousExitCode ?? 0
  })

  it("writes invalid period errors through injected output", async () => {
    let err = ""
    await runUsageCommand({
      period: "forever",
      error: { write: (s) => (err += s) },
    })

    expect(err).toContain('unknown period "forever"')
    expect(err).toContain("Valid:")
    expect(process.exitCode).toBe(1)
  })
})
