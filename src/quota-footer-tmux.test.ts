/**
 * tmux smoke test for the live-area quota footer.
 *
 * Two regression guards:
 *
 * 1. The footer renders BELOW the editor prompt in a real terminal.
 * 2. The placeholder mechanism prevents the prompt from jumping up
 *    one row when the first invoke resolves — we capture the pane
 *    twice (placeholder phase, then data phase) and assert the
 *    prompt row index is identical between them.
 *
 * Skips when `tmux` or the gitignored driver `tmp/quota-footer-tmux-
 * driver.ts` is missing.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "bun:test"

function haveTmux(): boolean {
  return spawnSync("tmux", ["-V"]).status === 0
}

function indexOfLine(pane: string, needle: string): number {
  return pane.split("\n").findIndex((l) => l.includes(needle))
}

const DRIVER = resolve(__dirname, "..", "tmp", "quota-footer-tmux-driver.ts")

const desc = haveTmux() && existsSync(DRIVER) ? describe : describe.skip

desc("tmux smoke: quota-status live-area footer", () => {
  it("renders BELOW the editor prompt and the prompt does NOT jump when data lands", () => {
    const session = `quota-footer-${Date.now()}`
    // Driver hangs ~2.2s; total ~5.2s with the trailing sleep. We
    // capture twice: once early (placeholder phase) and once late
    // (real data phase) and compare prompt row positions to assert
    // the no-jump invariant.
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

    // ----- Phase 1: capture during placeholder (before invoke resolves) -----
    // Driver sleeps 800ms before resolving the first invoke; we poll for
    // the first frame that has BOTH the prompt AND `quota` BUT NOT
    // `5h` — that's the placeholder phase (real data renders `5h`).
    const placeholderDeadline = Date.now() + 1_500
    let early = ""
    while (Date.now() < placeholderDeadline) {
      const cap = spawnSync("tmux", ["capture-pane", "-t", session, "-p", "-S", "-100"])
      early = cap.stdout?.toString() ?? ""
      if (early.includes("❯") && early.includes("quota") && !early.includes("5h")) break
      Bun.sleepSync(100)
    }
    const earlyPromptIdx = indexOfLine(early, "❯")
    const earlyFooterIdx = indexOfLine(early, "quota")
    expect(earlyPromptIdx).toBeGreaterThanOrEqual(0)
    expect(earlyFooterIdx).toBeGreaterThan(earlyPromptIdx)

    // ----- Phase 2: capture after data lands -----
    const dataDeadline = Date.now() + 5_000
    let late = ""
    while (Date.now() < dataDeadline) {
      const cap = spawnSync("tmux", ["capture-pane", "-t", session, "-p", "-S", "-100"])
      late = cap.stdout?.toString() ?? ""
      if (late.includes("5h 12%")) break
      Bun.sleepSync(150)
    }
    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })

    const latePromptIdx = indexOfLine(late, "❯")
    const lateFooterIdx = indexOfLine(late, "quota")

    // Real data is present.
    expect(late).toContain("5h 12%")
    expect(late).toContain("overall 4%")
    // Footer is below prompt in the late frame too.
    expect(lateFooterIdx).toBeGreaterThan(latePromptIdx)

    // === The headline regression guard: NO JUMP. ===
    // The prompt row in the early (placeholder) frame must equal the
    // prompt row in the late (real-data) frame. If the live-area
    // height grew between the two frames, the prompt would have
    // shifted up — that's the bug the placeholder mechanism prevents.
    expect(latePromptIdx).toBe(earlyPromptIdx)

    // Sanity: the synchronous "checking..." spinner that the OLD
    // startup tree used to print MUST NOT appear — the whole point
    // of the plugin is to eliminate it.
    expect(late).not.toContain("checking...")
  })
})
