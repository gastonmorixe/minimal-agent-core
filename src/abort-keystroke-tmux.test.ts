/**
 * tmux smoke: end-to-end regression guard for **Bug A + Bug B** (May 2026 -
 * see project memory `#abort-quit-fsm` and `src/abort-quit-keystroke.test.ts`).
 *
 * Spawns `tmp/abort-real-editor-tmux.ts` (which wires a REAL
 * `EditorController` into `runReplLiveArea`) inside a tmux pane, drives byte
 * sequences via `tmux paste-buffer` (which preserves the literal bytes - the
 * conventional `tmux send-keys` translates key names through tmux's input
 * keymap and would NOT deliver `\x1b[99;5u` verbatim), and asserts:
 *
 *   1. **Kitty CSI-u Ctrl+C while working** produces the `✘ ABORTED` echo +
 *      restored buffer + armed footer ("✘ Aborted.  ⌃C to quit · 10s · esc resume").
 *      Pre-fix this byte sequence bypassed the FSM via the legacy
 *      `consumeEscape() === "cancel"` path and silently exited the REPL.
 *
 *   2. **Kitty CSI-u ESC while working** produces the `✘ ABORTED` echo +
 *      restored buffer, and the agent stays alive (NO goodbye banner).
 *      Pre-fix this byte sequence fell through `parseModifiedKeySequence`
 *      to `"ignore"` and silently no-op'd.
 *
 * Why this lives alongside the unit-level tests (`abort-quit-keystroke.test.ts`):
 *   - Unit tests pin the state-machine + byte-decoding wiring.
 *   - tmux smoke validates the same path lands the right characters in the
 *     pane (compositor + interceptor + status bus all engaged). Bugs in
 *     transcript rendering would not surface at the unit level.
 *
 * The xterm modifyOtherKeys variant is covered by the unit tests; the kitty
 * variant suffices for tmux smoke because both go through the same
 * `parseModifiedKeySequence` branches.
 */

import { spawnSync } from "node:child_process"

import { describe, expect, it } from "bun:test"

function haveTmux(): boolean {
  return spawnSync("tmux", ["-V"]).status === 0
}

const desc = haveTmux() ? describe : describe.skip

function killSession(name: string): void {
  spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" })
}

/**
 * Atomically replace tmux's paste buffer with the given bytes, then paste
 * them into `session`. Used to deliver literal byte sequences (CSI-u kitty
 * keys, modifyOtherKeys, etc.) without going through tmux's key keymap.
 */
function pasteBytes(session: string, bytes: string): void {
  // `tmux load-buffer -` reads from stdin. We pipe the raw bytes in.
  const load = spawnSync("tmux", ["load-buffer", "-"], { input: bytes })
  expect(load.status).toBe(0)
  const paste = spawnSync("tmux", ["paste-buffer", "-t", session])
  expect(paste.status).toBe(0)
}

function captureAfter(session: string, ms: number): string {
  Bun.sleepSync(ms)
  const cap = spawnSync("tmux", ["capture-pane", "-t", session, "-p"])
  return cap.stdout?.toString() ?? ""
}

const TMUX_TIMEOUT = 15000

desc("tmux smoke: abort-keystroke - kitty/xterm encodings route through FSM", () => {
  it(
    "kitty CSI-u Ctrl+C (\\x1b[99;5u) while working → abort echo + armed footer (Bug A)",
    () => {
      const session = `abort-ctrl-c-${Date.now()}`
      killSession(session)
      const start = spawnSync("tmux", [
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "120",
        "-y",
        "30",
        "bun run tmp/abort-real-editor-tmux.ts; sleep 2",
      ])
      expect(start.status).toBe(0)

      try {
        // Wait for the REPL to come up.
        Bun.sleepSync(800)
        spawnSync("tmux", ["send-keys", "-t", session, "first prompt", "Enter"])
        Bun.sleepSync(600)
        pasteBytes(session, "\x1b[99;5u")
        const pane = captureAfter(session, 800)

        // Pre-fix this assertion FAILED - the path bypassed the FSM and the
        // REPL quit silently with no echo.
        expect(pane).toContain("✘ ABORTED")
        // Buffer was restored (not cleared, which was the legacy bug).
        expect(pane).toContain("first prompt")
        // Armed footer reflects post-abort source. `⌃C to quit` is the
        // post-abort verb (idle-confirm would say `⌃C confirm` instead),
        // so this substring is source-discriminating as well as
        // presence-asserting.
        expect(pane).toContain("⌃C to quit")
        // Did NOT print the goodbye banner: a single Ctrl+C never quits.
        expect(pane).not.toContain("thanks for using minimal-agent")
      } finally {
        killSession(session)
      }
    },
    TMUX_TIMEOUT,
  )

  it(
    "kitty CSI-u ESC (\\x1b[27u) while working → abort echo, NO banner, agent alive (Bug B)",
    () => {
      const session = `abort-esc-${Date.now()}`
      killSession(session)
      const start = spawnSync("tmux", [
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "120",
        "-y",
        "30",
        "bun run tmp/abort-real-editor-tmux.ts; sleep 2",
      ])
      expect(start.status).toBe(0)

      try {
        Bun.sleepSync(800)
        spawnSync("tmux", ["send-keys", "-t", session, "first prompt", "Enter"])
        Bun.sleepSync(600)
        pasteBytes(session, "\x1b[27u")
        const pane1 = captureAfter(session, 800)

        // ESC abort echo present, buffer restored.
        expect(pane1).toContain("✘ ABORTED")
        expect(pane1).toContain("first prompt")
        // ESC never arms (rule 4): no armed footer. We check for `⌃C` itself
        // (the only place it appears is the armed footer) rather than a verb
        // substring, so an accidental layout shift can't sneak past.
        expect(pane1).not.toContain("⌃C")
        // ESC never quits: no banner.
        expect(pane1).not.toContain("thanks for using minimal-agent")

        // Agent is still alive - submit a second prompt and verify it gets
        // processed.
        spawnSync("tmux", ["send-keys", "-t", session, " - second", "Enter"])
        const pane2 = captureAfter(session, 800)
        expect(pane2).toContain("working on: first prompt - second")
      } finally {
        killSession(session)
      }
    },
    TMUX_TIMEOUT,
  )

  it(
    "bare ESC (\\x1b) while working: same UX as kitty ESC (parity)",
    () => {
      const session = `abort-esc-bare-${Date.now()}`
      killSession(session)
      const start = spawnSync("tmux", [
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "120",
        "-y",
        "30",
        "bun run tmp/abort-real-editor-tmux.ts; sleep 2",
      ])
      expect(start.status).toBe(0)

      try {
        Bun.sleepSync(800)
        spawnSync("tmux", ["send-keys", "-t", session, "bare esc test", "Enter"])
        Bun.sleepSync(600)
        // tmux send-keys `Escape` literally sends the bare \x1b byte.
        spawnSync("tmux", ["send-keys", "-t", session, "Escape"])
        const pane = captureAfter(session, 800)

        expect(pane).toContain("✘ ABORTED")
        expect(pane).toContain("bare esc test")
        // No armed footer: same rationale as the kitty-ESC parity above.
        expect(pane).not.toContain("⌃C")
        expect(pane).not.toContain("thanks for using minimal-agent")
      } finally {
        killSession(session)
      }
    },
    TMUX_TIMEOUT,
  )
})
