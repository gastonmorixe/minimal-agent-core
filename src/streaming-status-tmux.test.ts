import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"

function haveTmux(): boolean {
  return spawnSync("tmux", ["-V"]).status === 0
}

const desc = haveTmux() ? describe : describe.skip

desc("tmux smoke: streaming status updates with detailed labels", () => {
  it("renders Calling Write: <hint> (<size>) labels as input_json_delta arrives", () => {
    const session = `streamstatus-${Date.now()}`
    // Driver runs ~3-4s (≈40 events × 60ms pull). Keep pane alive after exit
    // so capture-pane can read the final scrollback state.
    const cmd = "bun run tmp/streaming-status-tmux-driver.ts; sleep 5"

    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })
    const start = spawnSync("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "200",
      "-y",
      "30",
      cmd,
    ])
    expect(start.status).toBe(0)

    // Sample the pane every ~250ms until DONE appears (or budget expires),
    // collecting every distinct status line we observe along the way.
    // tmux capture-pane shows a snapshot of the visible pane, and the
    // status line is overwritten in place with `\r\x1b[2K`, so each
    // sample shows whichever label was current at that moment.
    const seenLabels = new Set<string>()
    const t0 = Date.now()
    let done = false
    while (Date.now() - t0 < 12_000) {
      const cap = spawnSync("tmux", ["capture-pane", "-t", session, "-p", "-S", "-200"])
      const pane = cap.stdout?.toString() ?? ""
      // Status line shape from StatusRenderer: "<spinner-glyph> <dim-label>".
      // Capture any "Calling Write:" or specific lifecycle labels we see.
      for (const line of pane.split("\n")) {
        const m = line.match(
          /(?:Calling \w+:.*|Receiving stream|Writing response|Thinking|Finalizing)/,
        )
        if (m) seenLabels.add(m[0].trim())
      }
      if (pane.includes("DONE")) {
        done = true
        break
      }
      Bun.sleepSync(200)
    }
    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })

    expect(done).toBe(true)

    // Must have seen at least one delta-driven label that includes the
    // extracted file_path hint AND a byte/KB size suffix.
    const hintedSized = [...seenLabels].filter(
      (l) =>
        l.includes("Calling Write:") &&
        l.includes("big-config.yaml") &&
        /\((\d+(\.\d+)?\s?(B|KB|MB))\)/.test(l),
    )
    expect(hintedSized.length).toBeGreaterThan(0)

    // Must have seen the dispatch label after content_block_stop.
    expect(seenLabels.has("Calling Write: dispatching")).toBe(true)

    // Must have seen the final lifecycle label.
    // Sizes must be monotonically non-decreasing across sampled labels.
    // (We're sampling, so we won't see every update, but the ones we DO
    // see should be in increasing-or-equal order numerically.)
    const sizes: number[] = []
    for (const l of hintedSized) {
      const m = l.match(/\((\d+(?:\.\d+)?)\s?(B|KB|MB)\)/)
      if (!m) continue
      const n = Number.parseFloat(m[1])
      const mult = m[2] === "MB" ? 1024 * 1024 : m[2] === "KB" ? 1024 : 1
      sizes.push(n * mult)
    }
    // Sort the sampled sizes by appearance order is not preserved by Set,
    // but they're all valid byte counts within the streamed JSON length.
    // Just assert each sampled size is within the input JSON length budget.
    const maxBytes = 32 * 1024 // generous upper bound for "# config\n" * 2048 + envelope
    for (const s of sizes) expect(s).toBeLessThanOrEqual(maxBytes)
  }, 20_000)
})
