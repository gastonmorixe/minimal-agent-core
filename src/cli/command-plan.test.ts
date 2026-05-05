import { describe, expect, test } from "bun:test"
import { planCommand } from "./command-plan.ts"

const base = {
  wantListSessions: false,
  wantListFlags: false,
  wantListSpinners: false,
  wantListModels: false,
}

describe("planCommand", () => {
  test("defaults to run with full startup capabilities", () => {
    const plan = planCommand(base)
    expect(plan.command).toBe("run")
    expect(plan.needsStartupUi).toBe(true)
    expect(plan.needsAuth).toBe(true)
    expect(plan.needsNetwork).toBe(true)
    expect(plan.needsFormatter).toBe(true)
    expect(plan.needsQuota).toBe(true)
    expect(plan.supportsPromptInput).toBe(true)
  })

  test("routes to dump first when dump arg is present", () => {
    const plan = planCommand({
      ...base,
      dumpArg: "last",
      wantListSessions: true,
      wantListFlags: true,
      wantListSpinners: true,
      wantListModels: true,
    })
    expect(plan.command).toBe("dump")
    expect(plan.needsStartupUi).toBe(false)
    expect(plan.needsAuth).toBe(false)
    expect(plan.needsNetwork).toBe(false)
    expect(plan.needsFormatter).toBe(false)
    expect(plan.needsQuota).toBe(false)
    expect(plan.supportsPromptInput).toBe(false)
  })

  test("routes sessions/list-flags/list-spinners/list-models with expected profiles", () => {
    expect(planCommand({ ...base, wantListSessions: true }).command).toBe("sessions")
    expect(planCommand({ ...base, wantListFlags: true }).command).toBe("list-flags")
    expect(planCommand({ ...base, wantListSpinners: true }).command).toBe("list-spinners")

    const models = planCommand({ ...base, wantListModels: true })
    expect(models.command).toBe("list-models")
    expect(models.needsAuth).toBe(true)
    expect(models.needsNetwork).toBe(true)
    expect(models.needsStartupUi).toBe(false)
    expect(models.needsFormatter).toBe(false)
    expect(models.needsQuota).toBe(false)
    expect(models.supportsPromptInput).toBe(false)
  })
})
