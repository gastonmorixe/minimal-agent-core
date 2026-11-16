import { describe, expect, test } from "bun:test"

import type { ModePolicyEntry } from "@minimal-agent/core/plugin-api/types/startup-profile"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import type { ManifestMode, ToolPermission } from "../plugins/types.ts"

import {
  buildEffectiveModePermissions,
  type EffectiveModePermissions,
  isToolAllowedByPermissions,
  ModeManager,
  type ModeUserOverride,
  permissionsToAllowDeny,
} from "./modes.ts"

const ASK: ManifestMode = { id: "ask", label: "ASK", disallowedTools: ["Edit", "Write"] }
const PLAN: ManifestMode = {
  id: "plan",
  permissions: [
    { tool: "Read", allow: true },
    { tool: "Bash", allow: "match", predicate: () => true },
  ],
}

/** Old-style `{ allow, deny }` manifest permissions, as JSON manifests ship them. */
function legacy(p: { allow?: string[]; deny?: string[] }): ManifestMode["permissions"] {
  return p as unknown as ManifestMode["permissions"]
}

/** Shipped ask-mode manifest shape (`ma-ask-mode-plugin`). */
const SHIPPED_ASK: ManifestMode = {
  id: "ask",
  label: "ASK",
  permissions: legacy({ allow: ["*"], deny: ["Edit", "Write"] }),
}
const RO: ManifestMode = { id: "ro", permissions: legacy({ allow: ["Read", "Grep"], deny: ["*"] }) }
const GUARDED: ManifestMode = {
  id: "guarded",
  permissions: [
    { tool: "Bash", allow: "match", predicate: (i) => i.command === "ls" },
    { tool: "Bash", allow: true },
    { tool: "Edit", allow: "match" },
    { tool: "*", allow: "match", predicate: () => true },
    { tool: "*", allow: false },
  ],
}

/** Copy of `perms` whose predicates all return `result` (missing predicates stay missing). */
function withPredicates(
  perms: EffectiveModePermissions,
  result: boolean,
): EffectiveModePermissions {
  const tools: ToolPermission[] = []
  for (const r of perms.tools) {
    tools.push(
      r.allow === "match" && r.predicate ? Object.assign({}, r, { predicate: () => result }) : r,
    )
  }
  return { tools, source: perms.source }
}

/** Plugin evaluation rule over a snapshot entry: true, false, or "match". */
function allows(entry: ModePolicyEntry, tool: string): boolean | "match" {
  const p = entry.permissions
  for (const name of [tool, "*"]) {
    if (p.deny.includes(name)) return false
    if (p.allow.includes(name)) return true
    if (p.match.includes(name)) return "match"
  }
  return false
}

describe("permissionsToAllowDeny", () => {
  test("first rule per name wins, lists are disjoint, match kept apart", () => {
    expect(
      permissionsToAllowDeny({
        tools: [
          { tool: "*", allow: true },
          { tool: "Edit", allow: false },
          { tool: "Bash", allow: "match", predicate: () => true },
          { tool: "Grep", allow: "match" },
          { tool: "Edit", allow: true },
          { tool: "*", allow: false },
        ],
        source: "manifest",
      }),
    ).toEqual({ allow: ["*"], deny: ["Edit", "Grep"], match: ["Bash"] })
  })

  test("allow-only user override over a base that denies Edit keeps Edit allowed", () => {
    const perms = buildEffectiveModePermissions(SHIPPED_ASK, {
      permissions: { allow: ["Read", "Edit"] },
    })
    expect(isToolAllowedByPermissions("Edit", perms)).toBe(true)
    expect(permissionsToAllowDeny(perms)).toEqual({
      allow: ["Read", "Edit"],
      deny: ["Write"],
      match: [],
    })
  })
})

describe("policySnapshot agrees with core decisions", () => {
  const MODES: ManifestMode[] = [SHIPPED_ASK, ASK, PLAN, RO, GUARDED]
  const OVERRIDES: Record<string, ModeUserOverride | null>[] = [
    {},
    { ask: { permissions: { allow: ["Read", "Edit"] } } },
    { ask: { permissions: { deny: ["Bash"] } } },
    { ro: { permissions: { allow: ["Edit"] } } },
  ]
  const TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebSearch", "UnknownTool"]

  for (const [n, overrides] of OVERRIDES.entries()) {
    test(`override set ${n}`, () => {
      const m = new ModeManager(MODES, null, undefined, undefined, (id) => overrides[id] ?? null)
      const snap = m.policySnapshot()
      for (const entry of snap.modes) {
        const perms = m.effectivePermissions(entry.id)
        if (!perms) throw new Error(entry.id)
        const p = entry.permissions
        const all = [...p.allow, ...p.deny, ...p.match]
        expect(new Set(all).size).toBe(all.length)
        for (const tool of TOOLS) {
          const verdict = allows(entry, tool)
          const yes = isToolAllowedByPermissions(tool, withPredicates(perms, true))
          const no = isToolAllowedByPermissions(tool, withPredicates(perms, false))
          // match only where core's decision depends on the predicate.
          if (verdict === "match") {
            expect([entry.id, tool, yes, no]).toEqual([entry.id, tool, true, false])
          } else {
            expect([entry.id, tool, verdict, verdict]).toEqual([entry.id, tool, yes, no])
          }
        }
      }
    })
  }
})

describe("unknown initial mode fails closed", () => {
  function capture() {
    const events: LogEvent[] = []
    return { events, diagnostics: createDiagnostics({ emit: (e) => events.push(e) }) }
  }

  test("unknown id falls back to ask and warns", () => {
    const { events, diagnostics } = capture()
    const m = new ModeManager(
      [PLAN, ASK],
      "nope",
      undefined,
      undefined,
      undefined,
      undefined,
      diagnostics,
    )
    expect(m.active()?.id).toBe("ask")
    expect(events.map((e) => e.source)).toEqual(["modes.unknown-initial-mode"])
  })

  test("without ask, picks the most restrictive mode", () => {
    const { diagnostics } = capture()
    const m = new ModeManager(
      [GUARDED, PLAN, RO],
      "nope",
      undefined,
      undefined,
      undefined,
      undefined,
      diagnostics,
    )
    expect(m.active()?.id).toBe("ro")
  })

  test('"none", null and a known id do not warn', () => {
    const { events, diagnostics } = capture()
    expect(
      new ModeManager(
        [ASK],
        "none",
        undefined,
        undefined,
        undefined,
        undefined,
        diagnostics,
      ).active(),
    ).toBeNull()
    expect(
      new ModeManager(
        [ASK],
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        diagnostics,
      ).active(),
    ).toBeNull()
    expect(
      new ModeManager(
        [PLAN, ASK],
        "plan",
        undefined,
        undefined,
        undefined,
        undefined,
        diagnostics,
      ).active()?.id,
    ).toBe("plan")
    expect(events).toEqual([])
  })

  test("unknown id with no modes stays no mode", () => {
    const { events, diagnostics } = capture()
    expect(
      new ModeManager([], "nope", undefined, undefined, undefined, undefined, diagnostics).active(),
    ).toBeNull()
    expect(events.length).toBe(1)
  })
})

describe("ModeManager.policySnapshot", () => {
  test("no active mode and no tool policy", () => {
    const m = new ModeManager([ASK, PLAN])
    expect(m.policySnapshot()).toEqual({
      activeModeId: null,
      modes: [
        {
          id: "ask",
          label: "ASK",
          permissions: { allow: ["*"], deny: ["Edit", "Write"], match: [] },
        },
        { id: "plan", permissions: { allow: ["Read"], deny: [], match: ["Bash"] } },
      ],
      tools: { kind: "all" },
    })
  })

  test("reports the live active mode and the tool policy", () => {
    const m = new ModeManager([ASK, PLAN], "ask", undefined, undefined, undefined, {
      kind: "allow-list",
      tools: ["Read", "Grep"],
    })
    expect(m.policySnapshot().activeModeId).toBe("ask")
    expect(m.policySnapshot().tools).toEqual({ kind: "list", names: ["Read", "Grep"] })
    m.setMode("plan")
    expect(m.policySnapshot().activeModeId).toBe("plan")
  })

  test("deny-all maps to none", () => {
    const m = new ModeManager([], null, undefined, undefined, undefined, { kind: "deny-all" })
    expect(m.policySnapshot()).toEqual({ activeModeId: null, modes: [], tools: { kind: "none" } })
  })
})
