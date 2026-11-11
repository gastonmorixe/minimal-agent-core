/**
 * Smoke test: the session cluster of `./host/*` subpaths resolves and works
 * through the package name, the way an external consumer installing core
 * from git would import it — never a relative `src/...` path.
 *
 * @module host-public/session.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { queueFilePath } from "@minimal-agent/core/host/queue-store"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { inspectSessionArtifacts } from "@minimal-agent/core/host/session-artifacts"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { _resetSessionId, getSessionId } from "@minimal-agent/core/host/session-id"
// biome-ignore lint/correctness/noUndeclaredDependencies: see AGENTS.md "Public package".
import { livenessFromRecords } from "@minimal-agent/core/host/session-liveness"
// biome-ignore lint/correctness/noUndeclaredDependencies: see AGENTS.md "Public package".
import { foldRecords } from "@minimal-agent/core/host/session-restore"
// biome-ignore lint/correctness/noUndeclaredDependencies: see AGENTS.md "Public package".
import { computeSessionUsage, ZERO_SESSION_USAGE } from "@minimal-agent/core/host/session-usage"

describe("./host/* session cluster (public subpaths)", () => {
  it("./host/queue-store: computes the on-disk queue file path", () => {
    expect(queueFilePath("abc-123", "/tmp")).toBe("/tmp/abc-123.queue")
  })

  it("./host/session-artifacts: inspects a session's on-disk artifacts", () => {
    const manifest = inspectSessionArtifacts("abc123", {
      sessionsDir: "/tmp/does-not-exist-sessions",
      netDbgDir: "/tmp/does-not-exist-netdbg",
    })
    expect(manifest.sid).toBe("abc123")
    expect(manifest.artifacts.length).toBeGreaterThan(0)
  })

  it("./host/session-id: mints and caches a session id", () => {
    _resetSessionId()
    const id = getSessionId()
    expect(getSessionId()).toBe(id)
    _resetSessionId()
  })

  it("./host/session-liveness: resolves dead when the log never attached", () => {
    expect(livenessFromRecords([])).toEqual({ status: "dead", reason: "no-attach" })
  })

  it("./host/session-restore: folds zero records to zero messages", () => {
    expect(foldRecords([])).toEqual([])
  })

  it("./host/session-usage: zero usage for no assistant turns", () => {
    expect(computeSessionUsage([])).toEqual(ZERO_SESSION_USAGE)
  })
})
