/**
 * End-to-end integration test for the file-lock plugin.
 *
 * Asserts that a real `PluginLoader.load(...)` picks up the embedded
 * `plugins/file-lock/` manifest, advertises the `LockStatus` tool to
 * the model, and dispatches tool calls to the handler. This is the
 * loader-↔-plugin seam : the handler's logic itself is covered in
 * `handlers/lock_status.test.ts`.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { buildHolder, lockPathFor, serializeHolder } from "../infra/file-lock.ts"

import { PluginLoader } from "./loader.ts"

// The file-lock plugin now lives in the sibling `../minimal-agent-plugins/`
// repo (Wave G physical move), discovered via the loader's `siblingDirs` seam.
// Point the e2e loader at the sibling so this test exercises the real,
// migrated plugin from its new home.
const PROJECT_ROOT = resolve(__dirname, "..", "..")
const SIBLING_ROOT = resolve(PROJECT_ROOT, "..", "minimal-agent-plugins")

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-lock-integration-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("PluginLoader picks up plugins/file-lock/", () => {
  it("advertises LockStatus as a tool", async () => {
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      siblingDirs: [SIBLING_ROOT],
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: "test-session-flock",
    })
    const tools = loader.getExtraTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain("LockStatus")
    const lockStatus = tools.find((t) => t.name === "LockStatus")
    expect(lockStatus).toBeDefined()
    expect(lockStatus?.description).toMatch(/locked/)
    // Schema is sent to the model : make sure required fields are right.
    const schema = lockStatus?.input_schema as Record<string, unknown> | undefined
    expect(schema?.required).toEqual(["action"])
  })

  it("dispatch LockStatus action=list returns tool_result", async () => {
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      siblingDirs: [SIBLING_ROOT],
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: "test-session-flock-2",
    })
    // Plant a lock so the listing has at least one entry.
    const f = join(dir, "a.txt")
    writeFileSync(
      lockPathFor(f),
      serializeHolder(buildHolder({ sessionId: "owner", tool: "Edit", filePath: f })),
    )

    const result = await loader.dispatch(
      {
        type: "tool",
        name: "LockStatus",
        input: { action: "list", path: dir, format: "json" },
        tool_use_id: "tu-1",
      },
      dir,
    )
    expect(result).not.toBeNull()
    if (result?.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.is_error).toBeFalsy()
    const parsed = JSON.parse(result.content) as { count: number; root: string }
    expect(parsed.count).toBe(1)
    expect(parsed.root).toBe(dir)
  })

  it("dispatch LockStatus action=clear-stale prunes a stale lock", async () => {
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      siblingDirs: [SIBLING_ROOT],
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: "test-session-flock-3",
    })
    // Plant a corrupt lock (always considered stale).
    const f = join(dir, "corrupt.txt")
    writeFileSync(lockPathFor(f), "this is not json")
    expect(existsSync(lockPathFor(f))).toBe(true)

    const result = await loader.dispatch(
      {
        type: "tool",
        name: "LockStatus",
        input: { action: "clear-stale", path: dir, format: "json" },
        tool_use_id: "tu-2",
      },
      dir,
    )
    if (result?.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.is_error).toBeFalsy()
    expect(existsSync(lockPathFor(f))).toBe(false)
  })
})
