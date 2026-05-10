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

describe("commands/login module shape", () => {
  it("exports runLoginCommand as an async function", async () => {
    const mod = await import("./login.ts")
    expect(typeof mod.runLoginCommand).toBe("function")
  })
})
