/**
 * Smoke test: the utils cluster of `./host/*` subpaths resolves and works
 * through the package name.
 *
 * @module host-public/utils.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { AGENT_VERSION } from "@minimal-agent/core/host/build-info"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { buildFileDiff } from "@minimal-agent/core/host/diff"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { clampWithHint, truncHint } from "@minimal-agent/core/host/truncate-hint"

describe("./host/* utils cluster (public subpaths)", () => {
  it("./host/build-info: AGENT_VERSION is a non-empty semver-ish string", () => {
    expect(typeof AGENT_VERSION).toBe("string")
    expect(AGENT_VERSION.length).toBeGreaterThan(0)
  })

  it("./host/diff: builds a unified diff between two file bodies", () => {
    const diff = buildFileDiff("f.txt", "a\nb\n", "a\nc\n")
    expect(diff).toContain("@@")
  })

  it("./host/truncate-hint: the elision idiom", () => {
    expect(truncHint(0)).toBe("")
    expect(truncHint(5, "ch")).toBe("...(+5ch)")
    expect(clampWithHint("hello world", 5)).toBe("hello...(+6ch)")
  })
})
