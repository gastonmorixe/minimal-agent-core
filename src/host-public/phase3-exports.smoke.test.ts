/**
 * Smoke test for the S34 Phase 3 exports. These close the last export gaps
 * of the CLI entry point: the narrow model-info, turn-attachments, and
 * bash-cwd subpaths. It also checks `computeStartupHashes` from
 * `./host-kit/build-agent-core`.
 *
 * Each subpath is imported by package name, as the CLI does. The package
 * import and the core relative import must be the same module instance.
 * This gives one model registry, one turn-attachment registry, and one
 * Bash cwd listener. The snapshot builder must also answer for any model
 * id.
 *
 * @module host-public/phase3-exports.smoke.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { setBashCwdChangeListener } from "@minimal-agent/core/host/bash-cwd"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  buildModelInfoSnapshot,
  buildSubagentModelRecommendations,
} from "@minimal-agent/core/host/model-info"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  combineTurnDrains,
  instantiateTurnAttachments,
  type TurnContentDrain,
} from "@minimal-agent/core/host/turn-attachments"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { computeStartupHashes } from "@minimal-agent/core/host-kit/build-agent-core"

import {
  clearTurnAttachmentFactories,
  registerTurnAttachmentFactory,
} from "../agent/turn-attachments.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import { EventBus } from "../plugins/event-bus.ts"
import { executeTool } from "../tools/tools.ts"

afterEach(() => {
  clearModelRegistry()
  clearTurnAttachmentFactories()
  setBashCwdChangeListener(null)
})

describe("S34 Phase 3 exports: every subpath resolves", () => {
  it("./host/model-info answers for an unregistered id without throwing", () => {
    const snap = buildModelInfoSnapshot("no-such-model-xyz")
    expect(snap.resolved).toBe(false)
    expect(Array.isArray(buildSubagentModelRecommendations("no-such-model-xyz"))).toBe(true)
  })

  it("./host/model-info reads the registry that core's own module fills", () => {
    registerModel({
      id: "phase3-smoke-model",
      providerId: "phase3-smoke-prov",
      surfaceId: "test",
      displayName: "phase3-smoke-model",
      capabilities: defaultCapabilities(),
      pricing: {
        inputUSD: 0,
        outputUSD: 0,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
    })
    const snap = buildModelInfoSnapshot("phase3-smoke-model", "phase3-smoke-prov")
    expect(snap.resolved).toBe(true)
  })

  it("./host-kit/build-agent-core exports computeStartupHashes", () => {
    expect(typeof computeStartupHashes).toBe("function")
  })

  it("./host/turn-attachments sees factories registered through core's own module", async () => {
    registerTurnAttachmentFactory("phase3-smoke", () => ({
      consumeAll: () => [{ type: "text" as const, text: "echo" }],
    }))
    const seam = await instantiateTurnAttachments({ sessionId: "s", bus: new EventBus() })
    expect(seam.drains).toHaveLength(1)
    const combined: TurnContentDrain | null = combineTurnDrains(seam.drains)
    expect(combined?.consumeAll()).toEqual([{ type: "text", text: "echo" }])
  })

  it("./host/bash-cwd registers on the listener slot the Bash tool fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase3-bash-cwd-"))
    const seen: { from: string; to: string }[] = []
    setBashCwdChangeListener((from, to) => seen.push({ from, to }))
    await executeTool("Bash", { command: `cd ${JSON.stringify(dir)}` })
    expect(seen.map((s) => s.to)).toEqual([dir])
    // Set the sticky cwd back for later tests in this process.
    const before = seen[0]?.from
    if (before) await executeTool("Bash", { command: `cd ${JSON.stringify(before)}` })
    rmSync(dir, { recursive: true, force: true })
  })
})
