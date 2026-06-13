/**
 * tmux smoke: end-to-end regression guard for the abort-quit-FSM.
 *
 * Spawns `tmp/quit-confirm-tmux-driver.ts` inside a real tmux pane and
 * asserts the captured pane shows:
 *   - the goodbye banner heading ("bye")
 *   - the resume hint with a UUID-shaped session id
 *   - "thanks for using minimal-agent" (confirmed quit closer)
 *
 * The driver simulates the user pressing Ctrl+C, waiting 600ms, then
 * pressing Ctrl+C again — the FSM's armed → quit:confirmed transition.
 * (The escape-hatch path would close with "force-quit", which the driver
 * intentionally avoids by spacing the two Ctrl+Cs \> 500ms apart.)
 *
 * This guards the user-facing UX contract (#abort-quit-ux-spec):
 *   - Single Ctrl+C does NOT quit
 *   - Second Ctrl+C inside 10s DOES quit
 *   - Goodbye banner shows session id ready to copy/paste
 */

import { spawnSync } from "node:child_process"

import { describe, expect, it } from "bun:test"

function haveTmux(): boolean {
  return spawnSync("tmux", ["-V"]).status === 0
}

const desc = haveTmux() ? describe : describe.skip

desc("tmux smoke: abort-quit-fsm — confirmed quit prints goodbye banner", () => {
  it("Ctrl+C, wait, Ctrl+C → banner with session id and 'thanks' closer", () => {
    const session = `quit-${Date.now()}`
    const cmd = "bun run tmp/quit-confirm-tmux-driver.ts; sleep 5"
    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })
    const start = spawnSync("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "110",
      "-y",
      "40",
      cmd,
    ])
    expect(start.status).toBe(0)

    const t0 = Date.now()
    let pane = ""
    while (Date.now() - t0 < 10_000) {
      const cap = spawnSync("tmux", ["capture-pane", "-t", session, "-p"])
      pane = cap.stdout?.toString() ?? ""
      // We're done once the goodbye banner has fully landed.
      if (pane.includes("--resume") && pane.includes("bye")) break
      Bun.sleepSync(200)
    }
    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })

    // Banner heading is present.
    expect(pane).toContain("bye")
    // The resume hint is on its own row with the full command for double-
    // click copy-paste. Whitespace-normalize before matching so tmux's
    // pane-edge wrapping doesn't break the assertion.
    const flat = pane.replace(/\s+/g, "")
    expect(flat).toMatch(/minimal-agent--resume[0-9a-f-]{36}/)
    // Confirmed-quit closer (NOT "force-quit") — the driver spaces its
    // two Ctrl+Cs >500ms apart to avoid the escape-hatch path.
    expect(pane).toContain("thanks for using minimal-agent")
    expect(pane).not.toContain("force-quit")
    // The frame chrome from the goodbye banner should be intact.
    expect(pane).toContain("╭")
    expect(pane).toContain("╰")
  })
})
