/**
 * End-to-end-ish integration test for the config overlay.
 *
 * Wires the REAL handlers (cmd_config, on_key, on_buffer_changed) to fakes
 * of the host's command / hook / event contexts, against a temp config file.
 * The FSM, model, runtime, view, and the comment-preserving writer all run as
 * in production. We assert against captured bus emits + the file on disk.
 *
 * @module config/integration.test
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import cmdConfig from "./handlers/cmd_config.ts"
import onKey from "./handlers/on_key.ts"
import { parseJsonc } from "./lib/mini-jsonc.ts"
import { stripSgr } from "./lib/palette.ts"
import { _resetForTests, getState } from "./lib/state.ts"

let DIR: string
let CONFIG: string

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "ma-config-"))
  CONFIG = join(DIR, "config.jsonc")
  _resetForTests()
})
afterEach(() => {
  _resetForTests()
  rmSync(DIR, { recursive: true, force: true })
})

interface Emit {
  ch: string
  p: unknown
}

/** A bus-capturing context fragment shared by all three handlers. */
function makeBus(emits: Emit[]) {
  return (ch: string, p?: unknown): void => {
    emits.push({ ch, p })
  }
}

const baseEnv = (): Record<string, string> =>
  ({
    ...process.env,
    MINIMAL_AGENT_CONFIG: CONFIG,
    // Point discovery at an empty dir so we don't pick up the repo's plugins
    // (keeps the field list deterministic = just the static schema).
    HOME: "/nonexistent-home-for-test",
  }) as Record<string, string>

function cmdCtx(emits: Emit[], argv = ""): Parameters<typeof cmdConfig>[0] {
  return {
    name: "config",
    argv,
    rawLine: `/config ${argv}`.trim(),
    cwd: "/nonexistent-cwd",
    env: baseEnv(),
    abort: new AbortController().signal,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
    emit: makeBus(emits),
    agent: { sessionId: "s", pid: 1, model: "m", version: "0" },
  }
}

function keyCtx(emits: Emit[]) {
  return {
    channel: "editor.key",
    packageDir: DIR,
    cwd: "/nonexistent-cwd",
    env: baseEnv(),
    abort: new AbortController().signal,
    priority: 80,
    emit: makeBus(emits),
    stderr: process.stderr,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
  }
}

function keyPayload(key: string) {
  return {
    key,
    buffer: "",
    cursor: { row: 0, col: 0, visualRow: 0, rowsInLogicalLine: 1, totalLines: 1 },
    result: {} as { halt?: boolean; buffer?: string },
  }
}

/** Type a run of characters via the modal char-key path. */
function typeText(emits: Emit[], text: string): void {
  for (const ch of text) onKey(keyPayload(ch), keyCtx(emits))
}

const lastFooter = (emits: Emit[]): string[] => {
  const f = [...emits].reverse().find((e) => e.ch === "editor.footer.set")
  return (f?.p as { lines?: string[] })?.lines ?? []
}

describe("config overlay — open", () => {
  it("/config opens the overlay and paints a footer", () => {
    writeFileSync(CONFIG, `{ "effort": "high" }`)
    const emits: Emit[] = []
    const r = cmdConfig(cmdCtx(emits))
    expect(r).toEqual({ kind: "none" })
    expect(getState().kind).toBe("open")
    const footer = lastFooter(emits).map(stripSgr).join("\n")
    expect(footer).toContain("config")
    expect(footer).toContain("effort")
    // It took MODAL ownership of the input line (hides prompt, blocks submit).
    expect(emits).toContainEqual({ ch: "editor.overlay.open", p: { owner: "config" } })
  })

  it("/config path is headless (no overlay)", () => {
    const emits: Emit[] = []
    const r = cmdConfig(cmdCtx(emits, "path"))
    expect(r).toEqual({ kind: "notice", lines: [CONFIG] })
    expect(getState().kind).toBe("closed")
  })

  it("/config get <id> prints the value without opening", () => {
    writeFileSync(CONFIG, `{ "effort": "high" }`)
    const r = cmdConfig(cmdCtx([], "get effort"))
    expect(r).toEqual({ kind: "notice", lines: ['effort = "high"'] })
  })
})

describe("config overlay — cycle enum + save", () => {
  it("ArrowRight cycles effort, save writes it preserving comments", () => {
    writeFileSync(
      CONFIG,
      `{
  // my note
  "effort": "high"
}`,
    )
    const emits: Emit[] = []
    cmdConfig(cmdCtx(emits)) // open; selection at index 0 = "model" (first schema field)

    // Move to the "effort" field (index 1) and cycle it.
    onKey(keyPayload("ArrowDown"), keyCtx(emits))
    const cycle = keyPayload("ArrowRight")
    onKey(cycle, keyCtx(emits))
    expect(cycle.result.halt).toBe(true)
    // Footer now shows a dirty marker.
    expect(lastFooter(emits).map(stripSgr).join("\n")).toContain("unsaved")

    // Navigate to the Save action row and press Enter.
    // Rows: 13 fields (static schema) then save/revert/close. Walk down to Save.
    for (let i = 0; i < 40; i++) onKey(keyPayload("ArrowDown"), keyCtx(emits))
    // We overshot to the bottom (Close). Walk up to Save (2 above Close).
    onKey(keyPayload("ArrowUp"), keyCtx(emits)) // revert
    onKey(keyPayload("ArrowUp"), keyCtx(emits)) // save
    const save = keyPayload("Enter")
    onKey(save, keyCtx(emits))

    const written = readFileSync(CONFIG, "utf8")
    expect(written).toContain("// my note")
    // effort cycled high → unset (high is last choice after [unset,low,...,high]? no:
    // choices are [low,medium,high,xhigh,max]; from "high" +1 → "xhigh").
    expect(parseJsonc(written)).toMatchObject({ effort: "xhigh" })
  })
})

describe("config overlay — edit a string field", () => {
  it("Enter on a text field → type → Enter commits, save persists", () => {
    writeFileSync(CONFIG, `{}`)
    const emits: Emit[] = []
    cmdConfig(cmdCtx(emits)) // open at index 0 = "model" (string field)

    // Enter edit mode on "model".
    const enter = keyPayload("Enter")
    onKey(enter, keyCtx(emits))
    expect(getState().kind).toBe("open")
    // Edit mode halts the key; the overlay owns input (no prompt buffer write).
    expect(enter.result.halt).toBe(true)
    expect(enter.result.buffer).toBeUndefined()

    // User types — each printable arrives as an editor.key char and appends
    // to the FSM's internal draft (NOT the prompt buffer).
    typeText(emits, "claude-opus-4-8")

    // Commit with Enter.
    const commit = keyPayload("Enter")
    onKey(commit, keyCtx(emits))
    expect(commit.result.halt).toBe(true)
    expect(commit.result.buffer).toBeUndefined() // no prompt buffer involved

    // Save: walk to the Save row and Enter.
    for (let i = 0; i < 40; i++) onKey(keyPayload("ArrowDown"), keyCtx(emits))
    onKey(keyPayload("ArrowUp"), keyCtx(emits)) // revert
    onKey(keyPayload("ArrowUp"), keyCtx(emits)) // save
    onKey(keyPayload("Enter"), keyCtx(emits))

    expect(parseJsonc(readFileSync(CONFIG, "utf8"))).toEqual({ model: "claude-opus-4-8" })
  })
})

describe("config overlay — close", () => {
  it("Escape closes the overlay and clears the footer", () => {
    writeFileSync(CONFIG, `{}`)
    const emits: Emit[] = []
    cmdConfig(cmdCtx(emits))
    const esc = keyPayload("Escape")
    onKey(esc, keyCtx(emits))
    expect(esc.result.halt).toBe(true)
    expect(getState().kind).toBe("closed")
    expect(lastFooter(emits)).toEqual([])
    // Releases modal input ownership so the host restores the prompt + cursor.
    expect(emits).toContainEqual({ ch: "editor.overlay.close", p: { owner: "config" } })
  })

  it("keys are ignored once closed (clean pass-through)", () => {
    const emits: Emit[] = []
    const p = keyPayload("ArrowDown")
    onKey(p, keyCtx(emits)) // overlay never opened
    expect(p.result.halt).toBeUndefined()
  })
})
