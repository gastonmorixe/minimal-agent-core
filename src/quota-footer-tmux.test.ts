/**
 * tmux smoke test: verifies the live-area FOOTER renders below the
 * editor prompt in a real terminal (not just in unit-test fixtures).
 *
 * This is the regression guard for the user-visible promise of the
 * `quota-status` plugin: "the live area shows up instantly; the
 * quota row populates a moment later, BELOW the prompt."
 *
 * Driver: `tmp/quota-footer-tmux-driver.ts` (gitignored — built-out
 * locally; the test skips when the driver is missing so a fresh
 * checkout doesn't fail).
 *
 * Pane layout we assert (after the scheduler's first tick lands):
 *
 *     status ready          ← scrollback banner
 *                           ← blank
 *     ❯                     ← interactive editor prompt
 *     quota 5h 12% · …      ← live-area footer (the new bit)
 *
 * The `quota` line MUST be BELOW the `❯` line — that's the whole point.
 */

import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

function haveTmux(): boolean {
  return spawnSync("tmux", ["-V"]).status === 0
}

const DRIVER = resolve(__dirname, "..", "tmp", "quota-footer-tmux-driver.ts")

const desc = haveTmux() && existsSync(DRIVER) ? describe : describe.skip

desc("tmux smoke: quota-status live-area footer", () => {
  it("renders the footer line BELOW the editor prompt in a real terminal", () => {
    const session = `quota-footer-${Date.now()}`
    // Keep the pane alive a moment after the driver self-exits so
    // capture-pane has time to read the buffer.
    const cmd = `bun run ${DRIVER}; sleep 3`

    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })
    const start = spawnSync("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "100",
      "-y",
      "20",
      cmd,
    ])
    expect(start.status).toBe(0)

    // Poll for the footer (driver self-exits ~1.5s; budget ~6s).
    const t0 = Date.now()
    let pane = ""
    while (Date.now() - t0 < 8_000) {
      const cap = spawnSync("tmux", ["capture-pane", "-t", session, "-p", "-S", "-100"])
      pane = cap.stdout?.toString() ?? ""
      if (pane.includes("quota") && pane.includes("%")) break
      Bun.sleepSync(150)
    }
    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })

    // Footer content is present at all.
    expect(pane).toContain("quota")
    expect(pane).toMatch(/5h 12%/)
    expect(pane).toMatch(/overall 4%/)

    // Crucial structural assertion: the quota line is BELOW the prompt
    // line in the rendered pane (i.e. higher line index = visually
    // lower since tmux paints top-to-bottom).
    const lines = pane.split("\n")
    const promptIdx = lines.findIndex((l) => l.includes("❯"))
    const quotaIdx = lines.findIndex((l) => l.includes("quota") && l.includes("%"))
    expect(promptIdx).toBeGreaterThanOrEqual(0)
    expect(quotaIdx).toBeGreaterThan(promptIdx)

    // Sanity: the synchronous "checking..." spinner that the OLD
    // startup tree used to print MUST NOT appear in this pane — the
    // whole point of the plugin is to skip it.
    expect(pane).not.toMatch(/checking\.\.\./)
  })
})
