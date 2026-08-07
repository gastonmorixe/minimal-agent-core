import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { FileTrackingStore } from "../session/file-tracking-store.ts"

import { buildFilesStatsReport, formatFilesStatsReport } from "./files-stats.ts"
import { executeTool } from "./tools.ts"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ma-files-stats-"))
  const present = join(dir, "present.txt")
  const changed = join(dir, "changed.txt")
  const missing = join(dir, "missing.txt")
  writeFileSync(present, "same")
  writeFileSync(changed, "before")
  const store = new FileTrackingStore({ sid: "sid", dir, cwd: dir })
  store.track(present)
  store.track(changed)
  store.track(missing)
  writeFileSync(changed, "after")
  return { dir, store, present, changed, missing }
}

describe("FilesStats report", () => {
  it("reports all statuses and counts", () => {
    const f = fixture()
    const report = buildFilesStatsReport(f.store)
    expect(report.files.map((file) => file.status)).toEqual(["present", "changed", "missing"])
    expect(report.counts).toEqual({ present: 1, missing: 1, changed: 1 })
    expect(formatFilesStatsReport(report)).toContain(`changed\t${f.changed}`)
    rmSync(f.dir, { recursive: true })
  })

  it("filters by status and path prefix", () => {
    const f = fixture()
    expect(buildFilesStatsReport(f.store, { status: "missing" }).files.map((x) => x.path)).toEqual([
      f.missing,
    ])
    expect(buildFilesStatsReport(f.store, { path: f.dir }).files).toHaveLength(3)
    expect(buildFilesStatsReport(f.store, { path: f.present }).files).toHaveLength(1)
    rmSync(f.dir, { recursive: true })
  })

  it("normalizes a relative path filter against the tracker cwd", () => {
    const f = fixture()
    // `present.txt` lives directly in the fixture dir, which is the tracker
    // cwd. A bare relative name must resolve to the same absolute path the
    // tracked files carry.
    expect(
      buildFilesStatsReport(f.store, { path: "present.txt" }).files.map((x) => x.path),
    ).toEqual([f.present])
    expect(buildFilesStatsReport(f.store, { path: "." }).files).toHaveLength(3)
    rmSync(f.dir, { recursive: true })
  })

  it("formats an empty filtered report", () => {
    const f = fixture()
    const text = formatFilesStatsReport(
      buildFilesStatsReport(f.store, { status: "present", path: f.missing }),
    )
    expect(text).toContain("No tracked files matched the filter.")
    expect(text).toContain("Totals: present=0 missing=0 changed=0")
    rmSync(f.dir, { recursive: true })
  })

  it("explains itself when nothing is tracked yet (no filters)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-files-stats-empty-"))
    const store = new FileTrackingStore({ sid: "empty", dir, cwd: dir })
    const text = formatFilesStatsReport(buildFilesStatsReport(store))
    expect(text).toContain("No files have been read or modified yet")
    expect(text).toContain("present")
    expect(text).toContain("changed")
    expect(text).toContain("missing")
    expect(text).toContain("Totals: present=0 missing=0 changed=0")
    rmSync(dir, { recursive: true })
  })
})

describe("FilesStats tool dispatch", () => {
  it("returns an actionable error without a tracker", async () => {
    const result = await executeTool("FilesStats", {})
    expect(result.is_error).toBe(true)
    expect(result.content).toContain("file tracking is not enabled in this host")
  })

  it("dispatches status and path filters through the tracker", async () => {
    const f = fixture()
    const result = await executeTool(
      "FilesStats",
      { status: "changed", path: f.dir },
      { fileTrackingStore: f.store },
    )
    expect(result.is_error).toBeUndefined()
    expect(result.content).toContain(`changed\t${f.changed}`)
    expect(result.content).not.toContain(f.present)
    rmSync(f.dir, { recursive: true })
  })
})
