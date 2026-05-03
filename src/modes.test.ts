/**
 * Unit tests for {@link ModeManager}.
 *
 * Focus is on the post-v2.1.119 cache-friendly mode contract:
 *
 *   - {@link ModeManager.isToolAllowed} as the dispatch-time gate
 *     (replaces the old `filterTools` request-shape mutation).
 *   - {@link ModeManager.consumePendingAttachment} as the activation
 *     channel (a `<mode-change>` text block emitted on the next user
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
      // Whole message is just the head line; no trailing space or hint.
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
    const m = new ModeManager([ASK_MODE])
    m.setMode("ask")
    const block = m.consumePendingAttachment()
    expect(block).not.toBeNull()
    expect(block).toEqual({
      type: "text",
      text: '<mode-change from="default" to="ask" />',
    })
  })

  test("is idempotent: second consume after the same toggle returns null", () => {
    const m = new ModeManager([ASK_MODE])
    m.setMode("ask")
    expect(m.consumePendingAttachment()).not.toBeNull()
    expect(m.consumePendingAttachment()).toBeNull()
  })

  test("emits <mode-change from='ask' to='default'> when exiting back to no-mode", () => {
    const m = new ModeManager([ASK_MODE])
    m.setMode("ask")
    m.consumePendingAttachment() // advertise ASK first
    m.setMode(null)
    const block = m.consumePendingAttachment()
    expect(block).toEqual({
      type: "text",
      text: '<mode-change from="ask" to="default" />',
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
    const m = new ModeManager([ASK_MODE, PLAN_MODE])
    m.setMode("ask")
    m.setMode("plan")
    const block = m.consumePendingAttachment()
    expect(block).toEqual({
      type: "text",
      text: '<mode-change from="default" to="plan" />',
    })
  })

  test("activeId() reflects current state independently of lastAdvertised", () => {
    const m = new ModeManager([ASK_MODE])
    m.setMode("ask")
    // Not consumed yet — lastAdvertised is still null, but active is "ask".
    expect(m.activeId()).toBe("ask")
  })

  test("cycleNext / cyclePrev populate prevModeId and produce attachments", () => {
    const m = new ModeManager([ASK_MODE, PLAN_MODE])
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
      text: '<mode-change from="default" to="ask" />',
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
