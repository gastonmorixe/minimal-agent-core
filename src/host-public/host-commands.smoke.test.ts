/**
 * Smoke test: the `src/host/commands/*` + related cluster of `./host/*`
 * subpaths resolves and works through the package name. Note: this is the
 * only cluster whose real implementation currently sits under the
 * closure-forbidden `src/host/` root (see `public-closure-scan.ts`'s
 * `PUBLIC_CLOSURE_BASELINE`), pending the S34 physical move.
 *
 * @module host-public/host-commands.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { tryRecoverContextExceeded } from "@minimal-agent/core/host/context-exceeded-recovery"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { groupModelRowsByProvider } from "@minimal-agent/core/host/model-catalog"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { parseContextLengthExceededError } from "@minimal-agent/core/host/model-error"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { resolveLastSessionSid } from "@minimal-agent/core/host/session-index"

describe("./host/* host/commands cluster (public subpaths)", () => {
  it("./host/model-catalog: groups rows by provider", () => {
    const grouped = groupModelRowsByProvider([
      { id: "a", providerId: "p1" },
      { id: "b", providerId: "p2" },
    ])
    expect(grouped.get("p1")?.length).toBe(1)
    expect(grouped.get("p2")?.length).toBe(1)
  })

  it("./host/session-index: resolves 'last' against an empty index", () => {
    expect(resolveLastSessionSid([], "/cwd")).toBeNull()
  })

  it("./host/model-error: recognizes a context-length-exceeded message", () => {
    expect(parseContextLengthExceededError("context_length_exceeded: too long")).toBe(true)
    expect(parseContextLengthExceededError("some other error")).toBe(false)
  })

  it("./host/context-exceeded-recovery: no-op recovery for a non-context error", async () => {
    const result = await tryRecoverContextExceeded({}, "some other error")
    expect(result).toEqual({ shouldRetry: false, retryText: null, notices: [] })
  })
})
