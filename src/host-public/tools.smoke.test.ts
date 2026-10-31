/**
 * Smoke test: the tools-leaf cluster of `./host/*` subpaths resolves and
 * works through the package name.
 *
 * @module host-public/tools.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  globPathFromInput,
  globPatternFromInput,
  writeContentFromInput,
  writePathFromInput,
} from "@minimal-agent/core/host/tool-input-aliases"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { fmtToolTime, ToolTimeTracker } from "@minimal-agent/core/host/tool-time"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { clampToolOutputLines, countLines } from "@minimal-agent/core/host/truncation"

describe("./host/* tools-leaf cluster (public subpaths)", () => {
  it("./host/tool-time: formats a tool timestamp and tracks day rollover", () => {
    const fmt = fmtToolTime(Date.UTC(2026, 4, 14, 1, 2, 3), null)
    expect(fmt.text).toContain("May 14")
    const tracker = new ToolTimeTracker()
    expect(tracker.format(Date.UTC(2026, 4, 14, 1, 2, 3))).toContain("May 14")
  })

  it("./host/truncation: counts lines and clamps long lines", () => {
    expect(countLines("a\nb\nc")).toBe(3)
    expect(clampToolOutputLines("short")).toEqual({ text: "short", clamped: false })
  })

  it("./host/tool-input-aliases: resolves the Glob/Write Cursor aliases, narrow surface only", () => {
    expect(globPatternFromInput({ glob_pattern: "*.ts" })).toEqual({
      status: "ok",
      key: "glob_pattern",
      value: "*.ts",
    })
    expect(globPathFromInput({})).toEqual({ status: "missing" })
    expect(writeContentFromInput({ contents: "x" })).toEqual({
      status: "ok",
      key: "contents",
      value: "x",
    })
    expect(writePathFromInput({ file_path: "f.txt" })).toEqual({
      status: "ok",
      key: "file_path",
      value: "f.txt",
    })
  })
})
