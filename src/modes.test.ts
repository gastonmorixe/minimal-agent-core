/**
 * Unit tests for {@link ModeManager}.
 *
 * Focus is on the post-v2.1.119 cache-friendly mode contract:
 *
 *   - {@link ModeManager.isToolAllowed} as the dispatch-time gate
 *     (replaces the old `filterTools` request-shape mutation).
 *   - {@link ModeManager.consumePendingAttachment} as the activation
 *     channel (a `<ma::agent::mode-change>` text block emitted on the next user
 *     turn after a toggle, idempotent thereafter).
 *   - Deprecation no-ops for {@link ModeManager.filterTools} and
 *     {@link ModeManager.systemPromptAddition}.
 *
 * The original cache-busting design (filter tools out of the request,
 * splice systemPromptAppend into sys[3]) is documented in
 * `work/2026-05-03T02:11:34-04:00-docs-plan-mode-design.md`.
 */

import { describe, expect, test } from "bun:test"

import { ModeManager } from "./modes.ts"
import type { ManifestMode } from "./plugins/types.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASK_MODE: ManifestMode = {
  id: "ask",
  label: "ASK",
  disallowedTools: ["Edit", "Write"],
  refusalHint: "Present the change as a unified diff in a code block.",
}

const PLAN_MODE: ManifestMode = {
  id: "plan",
  label: "PLAN",
  disallowedTools: ["Edit", "Write", "Bash"],
  // No refusalHint — exercise the no-hint refusal path.
}

const DEBUG_MODE: ManifestMode = {
  id: "debug",
  label: "DEBUG",
  // No disallowedTools — mode is purely a UX state, no dispatch refusals.
}

// Fixed wall-clock used by tests that assert on the literal `<ma::agent::mode-change … at="…" />`
// payload. The byte-stable timestamp lets us keep `.toEqual` instead of regex matchers.
const FIXED_AT = new Date("2026-05-22T20:43:12.000Z")
const FIXED_AT_ISO = FIXED_AT.toISOString()
const mkMgr = (modes: ManifestMode[], defaultId: string | null = null) =>
  new ModeManager(modes, defaultId, undefined, () => FIXED_AT)

// ---------------------------------------------------------------------------
// isToolAllowed (dispatch gate)
// ---------------------------------------------------------------------------

describe("ModeManager.isToolAllowed", () => {
  test("returns allowed:true when no mode is active", () => {
    const m = new ModeManager([ASK_MODE])
    expect(m.active()).toBeNull()
    expect(m.isToolAllowed("Edit")).toEqual({ allowed: true })
    expect(m.isToolAllowed("Read")).toEqual({ allowed: true })
  })

  test("returns allowed:true when active mode has no disallowedTools", () => {
    const m = new ModeManager([DEBUG_MODE], "debug")
    expect(m.activeId()).toBe("debug")
    expect(m.isToolAllowed("Edit")).toEqual({ allowed: true })
  })

  test("returns allowed:true for tools NOT on the deny list", () => {
    const m = new ModeManager([ASK_MODE], "ask")
    expect(m.isToolAllowed("Read")).toEqual({ allowed: true })
    expect(m.isToolAllowed("Bash")).toEqual({ allowed: true })
  })

  test("returns allowed:false with refusal message including label and hint", () => {
    const m = new ModeManager([ASK_MODE], "ask")
    const r = m.isToolAllowed("Edit")
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.message).toContain('Tool "Edit"')
      expect(r.message).toContain("ASK mode")
      expect(r.message).toContain(ASK_MODE.refusalHint ?? "")
    }
  })

  test("returns allowed:false WITHOUT trailing hint when refusalHint is absent", () => {
    const m = new ModeManager([PLAN_MODE], "plan")
    const r = m.isToolAllowed("Bash")
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.message).toBe('Tool "Bash" is not permitted in PLAN mode.')
    }
  })

  test("uses uppercased id when label is omitted", () => {
    const m = new ModeManager([{ id: "lockdown", disallowedTools: ["Bash"] }], "lockdown")
    const r = m.isToolAllowed("Bash")
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.message).toContain("LOCKDOWN mode")
  })
})

// ---------------------------------------------------------------------------
// consumePendingAttachment (activation channel)
// ---------------------------------------------------------------------------

describe("ModeManager.consumePendingAttachment", () => {
  test("returns null at startup with no mode and no toggle", () => {
    const m = new ModeManager([ASK_MODE])
    expect(m.consumePendingAttachment()).toBeNull()
  })

  test("returns null at startup when default mode equals lastAdvertised (both null)", () => {
    const m = new ModeManager([ASK_MODE]) // no defaultModeId
    expect(m.consumePendingAttachment()).toBeNull()
    // Calling again is still a no-op.
    expect(m.consumePendingAttachment()).toBeNull()
  })

  test("emits <mode-change from='default' to='ask'> after entering ASK", () => {
    const m = mkMgr([ASK_MODE])
    m.setMode("ask")
    const block = m.consumePendingAttachment()
    expect(block).not.toBeNull()
    expect(block).toEqual({
      type: "text",
      text: `<ma::agent::mode-change from="default" to="ask" at="${FIXED_AT_ISO}" />`,
    })
  })

  test("is idempotent: second consume after the same toggle returns null", () => {
    const m = new ModeManager([ASK_MODE])
    m.setMode("ask")
    expect(m.consumePendingAttachment()).not.toBeNull()
    expect(m.consumePendingAttachment()).toBeNull()
  })

  test("emits <mode-change from='ask' to='default'> when exiting back to no-mode", () => {
    const m = mkMgr([ASK_MODE])
    m.setMode("ask")
    m.consumePendingAttachment() // advertise ASK first
    m.setMode(null)
    const block = m.consumePendingAttachment()
    expect(block).toEqual({
      type: "text",
      text: `<ma::agent::mode-change from="ask" to="default" at="${FIXED_AT_ISO}" />`,
    })
  })

  test("collapses ask -> none -> ask (without intervening consume) into a no-op", () => {
    // The model was already told about ASK; if the user cycles through
    // none and back to ask before sending a message, the net state is
    // unchanged from what was last advertised — emit nothing.
    const m = new ModeManager([ASK_MODE])
    m.setMode("ask")
    m.consumePendingAttachment() // lastAdvertised = "ask"
    m.setMode(null)
    m.setMode("ask")
    expect(m.consumePendingAttachment()).toBeNull()
  })

  test("collapses two toggles into a single attachment when neither was consumed in between", () => {
    // User toggles ASK on then off before sending any message: the model
    // never heard about ASK, and now we're back to default. No attachment
    // needs to fire because lastAdvertised is still null and current is null.
    const m = new ModeManager([ASK_MODE])
    m.setMode("ask")
    m.setMode(null)
    expect(m.consumePendingAttachment()).toBeNull()
  })

  test("emits one attachment when toggled twice but only the final state matters", () => {
    // ask -> plan (with no consume in between). Net change: default -> plan.
    const m = mkMgr([ASK_MODE, PLAN_MODE])
    m.setMode("ask")
    m.setMode("plan")
    const block = m.consumePendingAttachment()
    expect(block).toEqual({
      type: "text",
      text: `<ma::agent::mode-change from="default" to="plan" at="${FIXED_AT_ISO}" />`,
    })
  })

  test("activeId() reflects current state independently of lastAdvertised", () => {
    const m = new ModeManager([ASK_MODE])
    m.setMode("ask")
    // Not consumed yet — lastAdvertised is still null, but active is "ask".
    expect(m.activeId()).toBe("ask")
  })

  test("cycleNext / cyclePrev populate prevModeId and produce attachments", () => {
    const m = mkMgr([ASK_MODE, PLAN_MODE])
    expect(m.previousModeId()).toBeNull()
    m.cycleNext() // -> ask
    expect(m.activeId()).toBe("ask")
    expect(m.previousModeId()).toBeNull()
    m.cycleNext() // ask -> plan
    expect(m.activeId()).toBe("plan")
    expect(m.previousModeId()).toBe("ask")
    m.cyclePrev() // plan -> ask
    expect(m.activeId()).toBe("ask")
    expect(m.previousModeId()).toBe("plan")

    // First consume reflects the *current* (= "ask") vs lastAdvertised (= null).
    expect(m.consumePendingAttachment()).toEqual({
      type: "text",
      text: `<ma::agent::mode-change from="default" to="ask" at="${FIXED_AT_ISO}" />`,
    })
  })
})

// ---------------------------------------------------------------------------
// Deprecated APIs — should be silent no-ops (with a one-shot stderr warn for
// systemPromptAddition when a mode declares the deprecated field).
// ---------------------------------------------------------------------------

describe("ModeManager deprecated surfaces", () => {
  test("filterTools is now a pass-through", () => {
    const m = new ModeManager([ASK_MODE], "ask")
    const tools = [{ name: "Edit" }, { name: "Read" }, { name: "Write" }]
    // ASK has Edit/Write on disallowedTools, but filterTools no longer
    // mutates the request shape — that's the dispatch gate's job now.
    expect(m.filterTools(tools)).toEqual(tools)
  })

  test("systemPromptAddition returns '' and warns once when a mode declares the deprecated field", () => {
    const legacyMode: ManifestMode = {
      id: "legacy",
      systemPromptAppend: "<mode>legacy stuff</mode>",
    }
    const m = new ModeManager([legacyMode], "legacy")

    // The deprecation warner uses `console.error`, which Bun routes to its
    // own stderr writer (not process.stderr.write directly). Capture via
    // console.error override so we observe the formatted message.
    const origConsoleError = console.error
    const captured: string[] = []
    console.error = (...args: unknown[]): void => {
      captured.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
    }
    try {
      // First call: returns "" and warns.
      expect(m.systemPromptAddition()).toBe("")
      // Second call: returns "" and DOES NOT warn again.
      expect(m.systemPromptAddition()).toBe("")
    } finally {
      console.error = origConsoleError
    }

    const blob = captured.join("\n")
    expect(blob).toContain("legacy")
    expect(blob).toContain("systemPromptAppend")
    // Only one warning per process.
    const warnings = captured.filter((s) => s.includes("systemPromptAppend"))
    expect(warnings.length).toBe(1)
  })

  test("systemPromptAddition stays silent when active mode has no systemPromptAppend", () => {
    const m = new ModeManager([ASK_MODE], "ask")
    const origConsoleError = console.error
    const captured: string[] = []
    console.error = (...args: unknown[]): void => {
      captured.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
    }
    try {
      expect(m.systemPromptAddition()).toBe("")
    } finally {
      console.error = origConsoleError
    }
    expect(captured.join("\n")).not.toContain("systemPromptAppend")
  })
})

// ---------------------------------------------------------------------------
// Permissions model (ToolPermission[], backward compat, user overlay)
// ---------------------------------------------------------------------------

describe("buildEffectiveModePermissions", () => {
  test("returns default wildcard when manifest is silent and no user override", async () => {
    const { buildEffectiveModePermissions } = await import("./modes.ts")
    const eff = buildEffectiveModePermissions({ id: "noop" })
    expect(eff.tools).toEqual([{ tool: "*", allow: true }])
    expect(eff.source).toBe("default")
  })

  test("reads new-style ToolPermission[] when set", async () => {
    const { buildEffectiveModePermissions } = await import("./modes.ts")
    const eff = buildEffectiveModePermissions({
      id: "ask",
      permissions: [
        { tool: "*", allow: true },
        { tool: "Edit", allow: false },
      ],
    })
    expect(eff.tools).toHaveLength(2)
    expect(eff.tools[0]).toEqual({ tool: "*", allow: true })
    expect(eff.tools[1]).toEqual({ tool: "Edit", allow: false })
    expect(eff.source).toBe("manifest")
  })

  test("converts old ModePermissions (allow/deny) to ToolPermission[]", async () => {
    const { buildEffectiveModePermissions } = await import("./modes.ts")
    const eff = buildEffectiveModePermissions({
      id: "ask",
      permissions: { allow: ["*"], deny: ["Edit", "Write"] } as any,
    })
    expect(eff.tools).toHaveLength(3)
    expect(eff.tools[0]).toEqual({ tool: "*", allow: true })
    expect(eff.tools[1]).toEqual({ tool: "Edit", allow: false })
    expect(eff.tools[2]).toEqual({ tool: "Write", allow: false })
    expect(eff.source).toBe("manifest")
  })

  test("legacy disallowedTools becomes ToolPermission deny rules", async () => {
    const { buildEffectiveModePermissions } = await import("./modes.ts")
    const eff = buildEffectiveModePermissions({
      id: "legacy",
      disallowedTools: ["Bash"],
    })
    expect(eff.tools).toHaveLength(2)
    expect(eff.tools[0]).toEqual({ tool: "*", allow: true })
    expect(eff.tools[1]).toEqual({ tool: "Bash", allow: false })
    expect(eff.source).toBe("manifest")
  })

  test("permissions (new array) wins over disallowedTools", async () => {
    const { buildEffectiveModePermissions } = await import("./modes.ts")
    const eff = buildEffectiveModePermissions({
      id: "both",
      permissions: [{ tool: "Read", allow: true }],
      disallowedTools: ["Bash"],
    })
    expect(eff.tools).toHaveLength(1)
    expect(eff.tools[0]).toEqual({ tool: "Read", allow: true })
  })

  test("user override of deny adds to manifest allow", async () => {
    const { buildEffectiveModePermissions } = await import("./modes.ts")
    const eff = buildEffectiveModePermissions(
      {
        id: "ask",
        permissions: [
          { tool: "*", allow: true },
          { tool: "Edit", allow: false },
        ],
      },
      { permissions: { deny: ["Edit", "Write", "Bash"] } },
    )
    // manifest allow wildcard is inherited, user deny rules are added
    expect(eff.tools).toHaveLength(4)
    expect(eff.tools[0]).toEqual({ tool: "*", allow: true })
    expect(eff.tools[1]).toEqual({ tool: "Edit", allow: false })
    expect(eff.tools[2]).toEqual({ tool: "Write", allow: false })
    expect(eff.tools[3]).toEqual({ tool: "Bash", allow: false })
    expect(eff.source).toBe("user-config")
  })

  test("user override of allow inherits manifest deny", async () => {
    const { buildEffectiveModePermissions } = await import("./modes.ts")
    const eff = buildEffectiveModePermissions(
      {
        id: "ask",
        permissions: [
          { tool: "*", allow: true },
          { tool: "Edit", allow: false },
        ],
      },
      { permissions: { allow: ["Read", "Glob"] } },
    )
    // user allow rules + manifest deny rule
    expect(eff.tools).toHaveLength(3)
    expect(eff.tools[0]).toEqual({ tool: "Read", allow: true })
    expect(eff.tools[1]).toEqual({ tool: "Glob", allow: true })
    expect(eff.tools[2]).toEqual({ tool: "Edit", allow: false })
  })
})

describe("isToolAllowedByPermissions", () => {
  test("deny wins over wildcard allow", async () => {
    const { isToolAllowedByPermissions } = await import("./modes.ts")
    const perms = {
      tools: [
        { tool: "*", allow: true },
        { tool: "Edit", allow: false },
      ],
      source: "manifest" as const,
    }
    expect(isToolAllowedByPermissions("Edit", perms)).toBe(false)
    expect(isToolAllowedByPermissions("Read", perms)).toBe(true)
  })

  test("wildcard allow permits anything not denied", async () => {
    const { isToolAllowedByPermissions } = await import("./modes.ts")
    const perms = {
      tools: [{ tool: "*", allow: true }],
      source: "default" as const,
    }
    expect(isToolAllowedByPermissions("AnythingAtAll", perms)).toBe(true)
  })

  test("whitelist mode: only listed tools pass", async () => {
    const { isToolAllowedByPermissions } = await import("./modes.ts")
    const perms = {
      tools: [
        { tool: "Read", allow: true },
        { tool: "Grep", allow: true },
      ],
      source: "manifest" as const,
    }
    expect(isToolAllowedByPermissions("Read", perms)).toBe(true)
    expect(isToolAllowedByPermissions("Grep", perms)).toBe(true)
    expect(isToolAllowedByPermissions("Bash", perms)).toBe(false)
    expect(isToolAllowedByPermissions("Edit", perms)).toBe(false)
  })

  test("first-match wins: earlier deny beats later allow", async () => {
    const { isToolAllowedByPermissions } = await import("./modes.ts")
    const perms = {
      tools: [
        { tool: "Bash", allow: false },
        { tool: "*", allow: true },
      ],
      source: "manifest" as const,
    }
    expect(isToolAllowedByPermissions("Bash", perms)).toBe(false)
    expect(isToolAllowedByPermissions("Read", perms)).toBe(true)
  })

  test("predicate match: allow when predicate returns true", async () => {
    const { isToolAllowedByPermissions } = await import("./modes.ts")
    const perms = {
      tools: [
        {
          tool: "Bash",
          allow: "match" as const,
          predicate: (input: Record<string, unknown>) => input.command === "ls",
        },
        { tool: "*", allow: true },
      ],
      source: "manifest" as const,
    }
    expect(isToolAllowedByPermissions("Bash", perms, { command: "ls" })).toBe(true)
    expect(isToolAllowedByPermissions("Bash", perms, { command: "rm -rf /" })).toBe(false)
  })

  test("no matching rule = denied", async () => {
    const { isToolAllowedByPermissions } = await import("./modes.ts")
    const perms = {
      tools: [{ tool: "Read", allow: true }],
      source: "manifest" as const,
    }
    expect(isToolAllowedByPermissions("Bash", perms)).toBe(false)
  })
})

describe("ModeManager.isToolAllowed via permissions overlay", () => {
  test("user override that adds a deny is enforced", () => {
    const m = new ModeManager(
      [
        {
          id: "ask",
          label: "ASK",
          permissions: [
            { tool: "*", allow: true },
            { tool: "Edit", allow: false },
          ],
        },
      ],
      "ask",
      undefined,
      undefined,
      () => ({ permissions: { deny: ["Edit", "Bash"] } }),
    )
    expect(m.isToolAllowed("Edit").allowed).toBe(false)
    expect(m.isToolAllowed("Bash").allowed).toBe(false)
    expect(m.isToolAllowed("Read").allowed).toBe(true)
  })

  test("whitelist override blocks everything not listed", () => {
    const m = new ModeManager([{ id: "ask", label: "ASK" }], "ask", undefined, undefined, () => ({
      permissions: { allow: ["Read", "Grep"] },
    }))
    expect(m.isToolAllowed("Read").allowed).toBe(true)
    expect(m.isToolAllowed("Bash").allowed).toBe(false)
    const r = m.isToolAllowed("Bash")
    if (!r.allowed) expect(r.message).toContain("not permitted")
  })

  test("invalidatePermissions clears the cache", () => {
    let override: { permissions: { deny: string[] } } | null = {
      permissions: { deny: ["Edit"] },
    }
    const m = new ModeManager(
      [{ id: "ask", label: "ASK" }],
      "ask",
      undefined,
      undefined,
      () => override,
    )
    expect(m.isToolAllowed("Edit").allowed).toBe(false)
    override = { permissions: { deny: [] } }
    expect(m.isToolAllowed("Edit").allowed).toBe(false)
    m.invalidatePermissions("ask")
    expect(m.isToolAllowed("Edit").allowed).toBe(true)
  })
})

describe("isToolAllowed (ASK fixture keeps disallowedTools for backward compat)", () => {
  test("Edit is denied in ASK mode via legacy disallowedTools", () => {
    const m = new ModeManager([ASK_MODE], "ask")
    const r = m.isToolAllowed("Edit")
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.message).toContain('Tool "Edit"')
      expect(r.message).toContain("ASK")
      expect(r.message).toContain("Present the change")
    }
  })

  test("Read is allowed in ASK mode", () => {
    const m = new ModeManager([ASK_MODE], "ask")
    expect(m.isToolAllowed("Read").allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildActiveModeStamp (envelope on tool_results)
// ---------------------------------------------------------------------------

describe("ModeManager.buildActiveModeStamp", () => {
  test("returns null when no mode active", () => {
    const m = mkMgr([ASK_MODE])
    expect(m.buildActiveModeStamp()).toBeNull()
  })

  test("returns the self-closing tag when a mode is active", () => {
    const m = mkMgr([ASK_MODE], "ask")
    const stamp = m.buildActiveModeStamp()
    expect(stamp).toBe(`<ma::agent::mode-active id="ask" since="${FIXED_AT_ISO}" />`)
  })

  test("since reflects the most recent transition, not the constructor time", () => {
    let now = new Date("2026-01-01T00:00:00.000Z")
    const m = new ModeManager([ASK_MODE], null, undefined, () => now)
    expect(m.buildActiveModeStamp()).toBeNull()
    now = new Date("2026-01-01T00:01:00.000Z")
    m.setMode("ask")
    expect(m.buildActiveModeStamp()).toBe(
      `<ma::agent::mode-active id="ask" since="2026-01-01T00:01:00.000Z" />`,
    )
  })
})

// ---------------------------------------------------------------------------
// lastAdvertisedModeFromHistory (resume rehydration)
// ---------------------------------------------------------------------------

describe("lastAdvertisedModeFromHistory", () => {
  test("returns null on empty history", async () => {
    const { lastAdvertisedModeFromHistory } = await import("./modes.ts")
    expect(lastAdvertisedModeFromHistory([])).toBeNull()
  })

  test("returns null when no mode-change blocks present", async () => {
    const { lastAdvertisedModeFromHistory } = await import("./modes.ts")
    expect(
      lastAdvertisedModeFromHistory([
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ]),
    ).toBeNull()
  })

  test("captures `to=` from the new <ma::agent::mode-change> tag", async () => {
    const { lastAdvertisedModeFromHistory } = await import("./modes.ts")
    expect(
      lastAdvertisedModeFromHistory([
        {
          role: "user",
          content: [
            { type: "text", text: '<ma::agent::mode-change from="default" to="ask" at="x" />' },
            { type: "text", text: "ask this" },
          ],
        },
      ]),
    ).toBe("ask")
  })

  test("captures `to=` from the legacy <mode-change> tag", async () => {
    const { lastAdvertisedModeFromHistory } = await import("./modes.ts")
    expect(
      lastAdvertisedModeFromHistory([
        {
          role: "user",
          content: [{ type: "text", text: '<mode-change from="default" to="plan" />' }],
        },
      ]),
    ).toBe("plan")
  })

  test("returns null when the most recent to= is `default`", async () => {
    const { lastAdvertisedModeFromHistory } = await import("./modes.ts")
    expect(
      lastAdvertisedModeFromHistory([
        {
          role: "user",
          content: [
            { type: "text", text: '<ma::agent::mode-change from="ask" to="default" at="x" />' },
          ],
        },
      ]),
    ).toBeNull()
  })

  test("returns the LAST advertisement when several are present", async () => {
    const { lastAdvertisedModeFromHistory } = await import("./modes.ts")
    expect(
      lastAdvertisedModeFromHistory([
        {
          role: "user",
          content: [
            { type: "text", text: '<ma::agent::mode-change from="default" to="ask" at="t1" />' },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        {
          role: "user",
          content: [
            { type: "text", text: '<ma::agent::mode-change from="ask" to="plan" at="t2" />' },
          ],
        },
      ]),
    ).toBe("plan")
  })

  test("ignores assistant-role text blocks", async () => {
    const { lastAdvertisedModeFromHistory } = await import("./modes.ts")
    expect(
      lastAdvertisedModeFromHistory([
        {
          role: "assistant",
          content: [{ type: "text", text: '<ma::agent::mode-change from="default" to="ask" />' }],
        },
      ]),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// primeLastAdvertised
// ---------------------------------------------------------------------------

describe("ModeManager.primeLastAdvertised", () => {
  test("prevents redundant first-consume after resume", () => {
    // Process starts with ASK active (CLI flag, say) AND the persisted
    // history's last `<ma::agent::mode-change to="ask">` already informed the
    // model. Without priming, the first consume would re-emit
    // `from="default" to="ask"`. With priming, it returns null.
    const m = mkMgr([ASK_MODE], "ask")
    m.primeLastAdvertised("ask")
    expect(m.consumePendingAttachment()).toBeNull()
  })

  test("prime to null is the explicit no-mode case", () => {
    const m = mkMgr([ASK_MODE], "ask")
    m.primeLastAdvertised(null)
    // History said "default" was last announced; active is "ask"; expect a real attachment.
    const block = m.consumePendingAttachment()
    expect(block).not.toBeNull()
    if (block && block.type === "text") {
      expect(block.text).toContain('from="default"')
      expect(block.text).toContain('to="ask"')
    }
  })
})
