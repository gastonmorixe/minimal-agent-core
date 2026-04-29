import { describe, it, expect } from "bun:test"
import { spawnSync } from "node:child_process"

function haveTmux(): boolean {
  return spawnSync("tmux", ["-V"]).status === 0
}

const desc = haveTmux() ? describe : describe.skip

desc("tmux smoke: truncation notice renders inside the transcript block", () => {
  it("Read of a huge file shows [truncated: ...] in the captured pane", () => {
    const session = `trunc-${Date.now()}`
    // Keep the pane alive for a moment after the driver self-exits so we
    // have time to capture the buffer.
    const cmd = "bun run tmp/truncation-tmux-driver.ts; sleep 5"

    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })
    const start = spawnSync("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "120",
      "-y",
      "40",
      cmd,
    ])
    expect(start.status).toBe(0)

    // Poll for the notice (driver self-exits ~1s; budget ~6s).
    const t0 = Date.now()
    let pane = ""
    while (Date.now() - t0 < 8000) {
      const cap = spawnSync("tmux", [
        "capture-pane",
        "-t",
        session,
        "-p",
        "-S",
        "-200",
      ])
      pane = cap.stdout?.toString() ?? ""
      if (pane.includes("[truncated:")) break
      Bun.sleepSync(150)
    }
    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })

    // The structured notice must be present. tmux hard-wraps long lines at
    // the pane width, so collapse whitespace before matching the message
    // body — we only care that the structured fields rendered, not how
    // they were wrapped on the screen.
    expect(pane).toContain("[truncated:")
    // Strip ALL whitespace — tmux can wrap mid-word at the pane edge,
    // inserting spaces inside identifiers like `offset=1000`.
    const flat = pane.replace(/\s+/g, "")
    expect(flat).toMatch(/shown\d+of\d+bytes/)
    expect(flat).toMatch(/callReadwithoffset=\d+/)

    // Bordered block is well-formed — same number of opens and closes.
    const opens = (pane.match(/┌/g) ?? []).length
    const closes = (pane.match(/└/g) ?? []).length
    expect(opens).toBeGreaterThan(0)
    expect(opens).toBe(closes)

    // The notice must appear inside a bordered row (│ or └), not on a
    // bare line outside the block.
    const noticeLine = pane.split("\n").find((l) => l.includes("[truncated:"))
    expect(noticeLine).toBeDefined()
    expect(noticeLine!).toMatch(/[│└]/)
  })
})
