/**
 * A plugin tool handler that throws gives an `is_error` tool_result that
 * names the error. The handler error text comes from the real turn-recovery
 * provider (loaded as a plugin package), not from a core fallback.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { SIBLING_REPO_ROOT } from "../test-utils/sibling-repo.ts"
import { textFixturesPresent } from "../test-utils/text-fixture-providers.ts"

import { CORE_TOOLS, toolManifest, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const THROWING_HANDLER_BODY = `export default async function handler(ctx) { throw new Error("boom"); }`

const ROOT = mkdtempSync(join(tmpdir(), "loader-handler-error-"))
const HOME = join(ROOT, "home")

/** A package whose synthetic text provider is the real turn-recovery provider. */
function writeTurnRecoveryTextPackage(): void {
  const entry = join(SIBLING_REPO_ROOT, "ma-turn-recovery-plugin", "provider.ts")
  writePackage(
    HOME,
    "turn-recovery-text",
    {
      id: "turn-recovery-text",
      name: "turn-recovery-text",
      version: "0.1.0",
      description: "test",
      syntheticText: [{ id: "p", entry: "./p.ts", export: "createTurnRecoveryProvider" }],
    },
    { "p.ts": `export { createTurnRecoveryProvider } from ${JSON.stringify(entry)}\n` },
  )
}

describe.skipIf(!textFixturesPresent())("PluginLoader handler error", () => {
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  it("returns is_error tool_result when the handler throws", async () => {
    writeTurnRecoveryTextPackage()
    writePackage(HOME, "d2", toolManifest("d2", "bomb", "./h.ts"), {
      "h.ts": THROWING_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      userDir: HOME,
      roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
      coreToolNames: CORE_TOOLS,
    })
    const result = await loader.dispatch(
      { type: "tool", name: "bomb", input: {}, tool_use_id: "toolu_2" },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.is_error).toBe(true)
    expect(result.content).toContain("boom")
  })
})
