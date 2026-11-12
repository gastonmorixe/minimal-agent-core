import { describe, expect, it } from "bun:test"

import { readLinuxProcStartTime, readProcessStartTime, readPsStartTime } from "./session-store.ts"

/** Build a fake procfs reader from a path → content map. */
function fakeProc(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const v = files[path]
    if (v === undefined) throw new Error(`ENOENT: ${path}`)
    return v
  }
}

/** A `/proc/<pid>/stat` line with `starttime` (field 22) set to `ticks`. */
function statLine(pid: number, comm: string, ticks: number): string {
  // Fields 3..21 are filler, field 22 is starttime, then a few trailing fields.
  const filler = Array.from({ length: 19 }, (_, i) => (i === 0 ? "S" : String(i)))
  return `${pid} (${comm}) ${[...filler, String(ticks), "0", "0"].join(" ")}\n`
}

const PROC_STAT = "cpu  1 2 3\nintr 9\nbtime 1700000000\nprocesses 5\n"

describe("readLinuxProcStartTime", () => {
  it("adds starttime ticks (USER_HZ 100) to btime, floored to seconds", () => {
    const read = fakeProc({
      "/proc/42/stat": statLine(42, "bun", 12_345),
      "/proc/stat": PROC_STAT,
    })
    // 12_345 ticks = 123.45 s → floor 123
    expect(readLinuxProcStartTime(42, read)).toBe(
      new Date((1_700_000_000 + 123) * 1000).toISOString(),
    )
  })

  it("handles a comm with spaces and parentheses", () => {
    const read = fakeProc({
      "/proc/7/stat": statLine(7, "we (ird) name", 500),
      "/proc/stat": PROC_STAT,
    })
    expect(readLinuxProcStartTime(7, read)).toBe(new Date((1_700_000_000 + 5) * 1000).toISOString())
  })

  it("returns null when the process is gone", () => {
    expect(readLinuxProcStartTime(1, fakeProc({ "/proc/stat": PROC_STAT }))).toBeNull()
  })

  it("returns null on malformed stat or missing btime", () => {
    expect(
      readLinuxProcStartTime(3, fakeProc({ "/proc/3/stat": "garbage", "/proc/stat": PROC_STAT })),
    ).toBeNull()
    expect(
      readLinuxProcStartTime(
        3,
        fakeProc({ "/proc/3/stat": statLine(3, "x", 10), "/proc/stat": "cpu 1\n" }),
      ),
    ).toBeNull()
  })
})

describe("readProcessStartTime", () => {
  it("returns a whole-second ISO time for our own pid", () => {
    const t = readProcessStartTime(process.pid)
    expect(t).not.toBeNull()
    const ms = new Date(t!).getTime()
    expect(ms % 1000).toBe(0)
    expect(ms).toBeLessThanOrEqual(Date.now())
  })

  it.skipIf(process.platform !== "linux")("procfs agrees with ps on Linux when ps exists", () => {
    const viaPs = readPsStartTime(process.pid)
    if (viaPs == null) return // slim image without procps
    const viaProc = readLinuxProcStartTime(process.pid)
    expect(viaProc).not.toBeNull()
    // Same second, or one apart when btime rounding straddles a second.
    expect(Math.abs(new Date(viaProc!).getTime() - new Date(viaPs).getTime())).toBeLessThanOrEqual(
      1000,
    )
  })

  it("returns null for a pid that does not exist", () => {
    expect(readProcessStartTime(2 ** 22 + 12_345)).toBeNull()
  })
})
