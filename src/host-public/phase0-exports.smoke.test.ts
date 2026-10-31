/**
 * Smoke test for the S34 exports-gap Phase 0 cluster (the 11 Bucket C
 * misses agents Y1-Y4 left unassigned, closed by `s34-move-plan.md`'s
 * Phase 0 step 1): agent-identity, runtime-attachments, compact-contract
 * (narrow), session-replay-sidecar (narrow), binaries, provider-plugin,
 * event-bus, sessions-read, tool-catalog (narrow), plus the
 * `resolveSiblingPluginRoots` named re-export folded into the existing
 * `./host-kit/plugin-loader` barrel.
 *
 * Imports each subpath by package name — the way an external consumer
 * installing core from git would, never a relative `src/...` path — and
 * asserts the symbols the brief named actually resolve through the package
 * `exports` map. Deeper behavior of each real module is already covered by
 * that module's own test file; this only confirms importability.
 *
 * @module host-public/phase0-exports.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { autoName, resolveAgentName } from "@minimal-agent/core/host/agent-identity"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { BinaryStore, defaultBinDir } from "@minimal-agent/core/host/binaries"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  type CompactRequestOpts,
  type CompactStats,
  DEFAULT_KEEP_TAIL,
  parseCompactArgs,
} from "@minimal-agent/core/host/compact-contract"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { EventBus } from "@minimal-agent/core/host/event-bus"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  canonicalProviderId,
  findProviderPlugin,
  listProviderPlugins,
  registerProviderPlugin,
} from "@minimal-agent/core/host/provider-plugin"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { isRuntimeAttachmentText } from "@minimal-agent/core/host/runtime-attachments"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { parseReplaySidecarTasks } from "@minimal-agent/core/host/session-replay-sidecar"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { createSessionsReadApi } from "@minimal-agent/core/host/sessions-read"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { TOOL_DEFINITIONS } from "@minimal-agent/core/host/tool-catalog"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { PluginLoader, resolveSiblingPluginRoots } from "@minimal-agent/core/host-kit/plugin-loader"

describe("S34 Phase 0 exports-gap cluster: every subpath resolves", () => {
  it("./host/agent-identity", () => {
    expect(typeof resolveAgentName).toBe("function")
    expect(typeof autoName("seed")).toBe("string")
  })

  it("./host/runtime-attachments", () => {
    expect(isRuntimeAttachmentText("<ma::agent::tasks>")).toBe(true)
    expect(isRuntimeAttachmentText("plain user text")).toBe(false)
  })

  it("./host/compact-contract (narrow: CompactRequestOpts/CompactStats/DEFAULT_KEEP_TAIL/parseCompactArgs only)", () => {
    expect(DEFAULT_KEEP_TAIL).toBeGreaterThan(0)
    expect(parseCompactArgs("tail=3")).toEqual({ keepTail: 3 })
    const opts: CompactRequestOpts = { reason: "manual" }
    const stats: CompactStats = {
      reason: "manual",
      kind: "local",
      messagesBefore: 1,
      messagesAfter: 1,
    }
    expect(opts.reason).toBe("manual")
    expect(stats.kind).toBe("local")
  })

  it("./host/session-replay-sidecar (narrow: parseReplaySidecarTasks only)", () => {
    expect(parseReplaySidecarTasks("")).toEqual([])
  })

  it("./host/binaries", () => {
    expect(typeof BinaryStore).toBe("function")
    expect(typeof defaultBinDir).toBe("function")
  })

  it("./host/provider-plugin", () => {
    expect(typeof registerProviderPlugin).toBe("function")
    expect(typeof listProviderPlugins).toBe("function")
    expect(typeof findProviderPlugin).toBe("function")
    expect(typeof canonicalProviderId).toBe("function")
    expect(Array.isArray(listProviderPlugins())).toBe(true)
  })

  it("./host/event-bus (pairs with ./host/global-bus)", () => {
    expect(typeof EventBus).toBe("function")
    const bus = new EventBus()
    expect(typeof bus.on).toBe("function")
  })

  it("./host/sessions-read", () => {
    expect(typeof createSessionsReadApi).toBe("function")
    const api = createSessionsReadApi({ dir: "/nonexistent-smoke-test-dir" })
    expect(typeof api.list).toBe("function")
  })

  it("./host/tool-catalog (narrow: TOOL_DEFINITIONS only)", () => {
    expect(Array.isArray(TOOL_DEFINITIONS)).toBe(true)
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(0)
    for (const def of TOOL_DEFINITIONS) {
      expect(typeof def.name).toBe("string")
      expect(typeof def.description).toBe("string")
    }
  })

  it("./host-kit/plugin-loader (plus the folded resolveSiblingPluginRoots)", () => {
    expect(typeof PluginLoader).toBe("function")
    expect(typeof PluginLoader.load).toBe("function")
    expect(typeof resolveSiblingPluginRoots).toBe("function")
    expect(resolveSiblingPluginRoots("/nonexistent-smoke-test-embedded-dir")).toEqual([])
  })
})
