import { describe, expect, test } from "bun:test"

import {
  allowDecision,
  chainResultToDecision,
  collectAdditionalContext,
  denyDecision,
  isDenied,
  NOOP_LIFECYCLE,
} from "./lifecycle.ts"

describe("PolicyDecision helpers", () => {
  test("allowDecision / denyDecision / isDenied", () => {
    const ok = allowDecision({ text: "hi" }, ["ctx"])
    expect(ok.action).toBe("allow")
    expect(ok.additionalContext).toEqual(["ctx"])
    expect(isDenied(ok)).toBe(false)

    const no = denyDecision("blocked", { text: "x" })
    expect(no.action).toBe("deny")
    if (no.action === "deny") expect(no.reason).toBe("blocked")
    expect(isDenied(no)).toBe(true)
  })

  test("chainResultToDecision maps halt to deny", () => {
    const denied = chainResultToDecision(
      { payload: { n: 1 }, halted: true, reason: "nope" },
      "default",
    )
    expect(denied).toEqual({ action: "deny", reason: "nope", payload: { n: 1 } })

    const allowed = chainResultToDecision({ payload: { n: 2 }, halted: false })
    expect(allowed).toEqual({ action: "allow", payload: { n: 2 } })
  })

  test("collectAdditionalContext filters empties", () => {
    expect(collectAdditionalContext(allowDecision(1, ["a", "", "  ", "b"]))).toEqual(["a", "b"])
  })

  test("NOOP_LIFECYCLE allows through", async () => {
    const t = await NOOP_LIFECYCLE.beforeTool!({
      tool: "Bash",
      toolUseId: "tu_1",
      input: { command: "echo hi" },
      cwd: "/tmp",
    })
    expect(t.action).toBe("allow")
    if (t.action === "allow") expect(t.payload.tool).toBe("Bash")
  })
})
