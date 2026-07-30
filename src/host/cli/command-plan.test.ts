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

  test("routes usage as a read-only command (no auth/network/quota)", () => {
    const u = planCommand({ ...base, wantUsage: true })
    expect(u.command).toBe("usage")
    expect(u.needsAuth).toBe(false)
    expect(u.needsNetwork).toBe(false)
    expect(u.needsStartupUi).toBe(false)
    expect(u.needsFormatter).toBe(false)
    expect(u.needsQuota).toBe(false)
    expect(u.supportsPromptInput).toBe(false)
  })

  test("sessions takes precedence over usage when both set", () => {
    expect(planCommand({ ...base, wantListSessions: true, wantUsage: true }).command).toBe(
      "sessions",
    )
  })

  test("routes list-plugins as read-only (no auth/network)", () => {
    const p = planCommand({ ...base, wantListPlugins: true })
    expect(p.command).toBe("list-plugins")
    expect(p.needsAuth).toBe(false)
    expect(p.needsNetwork).toBe(false)
    expect(p.needsStartupUi).toBe(false)
    expect(p.needsFormatter).toBe(false)
    expect(p.needsQuota).toBe(false)
  })

  test("list-plugins takes precedence over login", () => {
    expect(planCommand({ ...base, wantListPlugins: true, wantLogin: true }).command).toBe(
      "list-plugins",
    )
  })

  test("routes sessions/list-flags/list-spinners/list-models with expected profiles", () => {
    expect(planCommand({ ...base, wantListSessions: true }).command).toBe("sessions")
    expect(planCommand({ ...base, wantListFlags: true }).command).toBe("list-flags")
    expect(planCommand({ ...base, wantListSpinners: true }).command).toBe("list-spinners")

    const models = planCommand({ ...base, wantListModels: true })
    expect(models.command).toBe("list-models")
    // Static registry only — no auth/network (live catalogs are models-live).
    expect(models.needsAuth).toBe(false)
    expect(models.needsNetwork).toBe(false)
    expect(models.needsStartupUi).toBe(false)
    expect(models.needsFormatter).toBe(false)
    expect(models.needsQuota).toBe(false)
    expect(models.supportsPromptInput).toBe(false)

    const live = planCommand({ ...base, wantListModelsLive: true })
    expect(live.command).toBe("list-models-live")
    expect(live.needsAuth).toBe(true)
    expect(live.needsNetwork).toBe(true)
  })

  test("list-models-live takes precedence over list-models", () => {
    expect(planCommand({ ...base, wantListModels: true, wantListModelsLive: true }).command).toBe(
      "list-models-live",
    )
  })

  test("login: needs network but NOT auth (must work with no stored credentials)", () => {
    const p = planCommand({ ...base, wantLogin: true })
    expect(p.command).toBe("login")
    expect(p.needsAuth).toBe(false)
    expect(p.needsNetwork).toBe(true)
    expect(p.needsStartupUi).toBe(false)
    expect(p.needsFormatter).toBe(false)
    expect(p.needsQuota).toBe(false)
    expect(p.supportsPromptInput).toBe(false)
  })

  test("logout: pure local op — no auth, no network, no UI", () => {
    const p = planCommand({ ...base, wantLogout: true })
    expect(p.command).toBe("logout")
    expect(p.needsAuth).toBe(false)
    expect(p.needsNetwork).toBe(false)
    expect(p.needsStartupUi).toBe(false)
  })

  test("auth-status: read-only local — no auth, no network", () => {
    const p = planCommand({ ...base, wantAuthStatus: true })
    expect(p.command).toBe("auth-status")
    expect(p.needsAuth).toBe(false)
    expect(p.needsNetwork).toBe(false)
  })

  test("read-only inspection commands take precedence over auth subcommands", () => {
    expect(planCommand({ ...base, wantListSessions: true, wantLogout: true }).command).toBe(
      "sessions",
    )
    expect(planCommand({ ...base, wantListFlags: true, wantLogin: true }).command).toBe(
      "list-flags",
    )
  })

  test("among auth subcommands: login > logout > auth-status", () => {
    expect(
      planCommand({ ...base, wantLogin: true, wantLogout: true, wantAuthStatus: true }).command,
    ).toBe("login")
    expect(planCommand({ ...base, wantLogout: true, wantAuthStatus: true }).command).toBe("logout")
  })
})
