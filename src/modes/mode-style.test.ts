/**
 * Unit tests for the host-neutral mode style resolver (`./mode-style.ts`)
 * and for the style data that {@link ModeManager} returns.
 *
 * Core returns color tokens, never terminal escape sequences (rule 14).
 * A host maps the tokens to its own output. The CLI maps them to SGR.
 */

import { describe, expect, test } from "bun:test"

import type { ManifestMode } from "../plugins/types.ts"

import {
  detectModeTheme,
  type ModeStyle,
  type ModeSurfaceStyle,
  resolveModeStyleTokens,
  styleFromLegacyColor,
} from "./mode-style.ts"
import { ModeManager } from "./modes.ts"

const NONE = { fg: null, bg: null, bold: false, dim: false }

describe("resolveModeStyleTokens", () => {
  test("maps a palette color name to a token", () => {
    expect(resolveModeStyleTokens({ label: { fg: "blue" } }, "dark")).toEqual({
      label: { fg: { token: "blue", hex: null, ansi256: null }, bg: null, bold: false, dim: false },
      arrow: NONE,
      status: NONE,
    })
  })

  test("keeps semantic tokens for the host to map", () => {
    const got = resolveModeStyleTokens(
      { label: { fg: "accent", bg: "brand" }, arrow: { fg: "danger" }, status: { fg: "muted" } },
      "dark",
    )
    expect(got.label.fg?.token).toBe("accent")
    expect(got.label.bg?.token).toBe("brand")
    expect(got.arrow.fg?.token).toBe("danger")
    expect(got.status.fg?.token).toBe("muted")
  })

  test("keeps a valid hex string and drops an invalid one", () => {
    const got = resolveModeStyleTokens({ label: { fg: "#ff8800" }, arrow: { fg: "#12" } }, "dark")
    expect(got.label.fg).toEqual({ token: null, hex: "#ff8800", ansi256: null })
    expect(got.arrow.fg).toBeNull()
  })

  test("keeps every form of an object request", () => {
    const got = resolveModeStyleTokens(
      { label: { fg: { hex: "#010203", ansi256: 42, token: "danger" } } },
      "dark",
    )
    expect(got.label.fg).toEqual({ token: "danger", hex: "#010203", ansi256: 42 })
  })

  test("drops an unknown token, `transparent`, and prototype keys", () => {
    const got = resolveModeStyleTokens(
      {
        label: { fg: "nope", bg: "transparent" },
        arrow: { fg: "constructor" },
        status: { fg: { token: "toString" } },
      },
      "dark",
    )
    expect(got.label.fg).toBeNull()
    expect(got.label.bg).toBeNull()
    expect(got.arrow.fg).toBeNull()
    expect(got.status.fg).toBeNull()
  })

  test("merges the active theme override per surface and per key", () => {
    const req = {
      label: { fg: "cyan", bold: true },
      theme: { light: { label: { fg: "purple", dim: true }, arrow: { fg: "lime" } } },
    }
    expect(resolveModeStyleTokens(req, "dark").label).toEqual({
      fg: { token: "cyan", hex: null, ansi256: null },
      bg: null,
      bold: true,
      dim: false,
    })
    const light = resolveModeStyleTokens(req, "light")
    expect(light.label).toEqual({
      fg: { token: "purple", hex: null, ansi256: null },
      bg: null,
      bold: true,
      dim: true,
    })
    expect(light.arrow.fg?.token).toBe("lime")
  })

  test("holds no terminal escape sequence", () => {
    const got = resolveModeStyleTokens(
      { label: { fg: "red", bg: { ansi256: 5 } }, arrow: { fg: "#abcdef" } },
      "dark",
    )
    expect(JSON.stringify(got)).not.toContain("\\u001b")
  })
})

describe("styleFromLegacyColor", () => {
  test("colors the label only, in bold", () => {
    expect(styleFromLegacyColor("magenta")).toEqual({ label: { fg: "magenta", bold: true } })
    expect(styleFromLegacyColor(null)).toBeNull()
    expect(styleFromLegacyColor("")).toBeNull()
  })
})

describe("detectModeTheme", () => {
  test("reads MINIMAL_AGENT_THEME and falls back to dark", () => {
    expect(detectModeTheme({ MINIMAL_AGENT_THEME: "light" })).toBe("light")
    expect(detectModeTheme({ MINIMAL_AGENT_THEME: "high-contrast" })).toBe("high-contrast")
    expect(detectModeTheme({ MINIMAL_AGENT_THEME: "neon" })).toBe("dark")
    expect(detectModeTheme({})).toBe("dark")
  })
})

describe("ModeManager style data", () => {
  const ASK: ManifestMode = {
    id: "ask",
    label: "ASK",
    style: { label: { fg: "blue" }, arrow: { fg: "blue" } },
  }
  const LEGACY: ManifestMode = { id: "legacy", color: "magenta" }
  const PLAIN: ManifestMode = { id: "plain" }

  test("resolved() returns tokens for the active mode", () => {
    const m = new ModeManager([ASK, LEGACY, PLAIN], "ask", "dark")
    const want: ModeStyle = {
      label: { fg: { token: "blue", hex: null, ansi256: null }, bg: null, bold: false, dim: false },
      arrow: { fg: { token: "blue", hex: null, ansi256: null }, bg: null, bold: false, dim: false },
      status: NONE,
    }
    expect(m.resolved()).toEqual(want)
    expect(m.statusStyle()).toEqual(NONE)
    m.setMode(null)
    expect(m.resolved()).toBeNull()
    expect(m.statusStyle()).toBeNull()
  })

  test("resolvedForId maps the legacy color, no style, unknown id, and the default", () => {
    const m = new ModeManager([ASK, LEGACY, PLAIN], null, "dark")
    expect(m.resolvedForId("legacy")?.label).toEqual({
      fg: { token: "magenta", hex: null, ansi256: null },
      bg: null,
      bold: true,
      dim: false,
    })
    expect(m.resolvedForId("plain")).toBeNull()
    expect(m.resolvedForId("missing")).toBeNull()
    const brand: ModeSurfaceStyle = {
      fg: { token: "brand", hex: null, ansi256: null },
      bg: null,
      bold: true,
      dim: false,
    }
    expect(m.resolvedForId(null)).toEqual({ label: brand, arrow: brand, status: NONE })
  })

  test("uses the theme it gets", () => {
    const themed: ManifestMode = {
      id: "t",
      style: { label: { fg: "cyan" }, theme: { light: { label: { fg: "purple" } } } },
    }
    expect(new ModeManager([themed], null, "light").resolvedForId("t")?.label.fg?.token).toBe(
      "purple",
    )
    expect(new ModeManager([themed], null, "dark").resolvedForId("t")?.label.fg?.token).toBe("cyan")
  })
})
