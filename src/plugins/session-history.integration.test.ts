/**
 * End-to-end: the REAL loader discovers the REAL session-history plugin,
 * builds its capability host from the manifest grants, and the
 * SessionHistory tool reads a REAL session store written by SessionStore.
 *
 * This is the drift guard for the plugin's local structural types
 * (lib/host-types.ts): if the host-side capability shapes change, this
 * test fails even though the plugin compiles in isolation.
 *
 * NOTE: this test file intentionally imports from src/ (it exercises the
 * host). The plugin's RUNTIME files (handlers/, lib/) must stay free of
 * src/ imports — enforced by src/architecture.plugin-decoupling.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { SessionStore } from "../session-store.ts"

import { PluginLoader } from "./loader.ts"

// The session-history plugin now lives in the sibling `../minimal-agent-plugins/`
// repo (Wave G physical move), discovered via the loader's `siblingDirs` seam —
// the same path production uses through the cloned `~/.minimal-agent/plugins`.
// Point the e2e loader at the sibling so this test exercises the real, migrated
// plugin from its new home.
const SIBLING_ROOT = resolve(import.meta.dirname, "..", "..", "..", "minimal-agent-plugins")

const sessionsDir = mkdtempSync(join(tmpdir(), "session-history-e2e-"))
afterAll(() => rmSync(sessionsDir, { recursive: true, force: true }))

let loader: PluginLoader

beforeAll(async () => {
  const store = SessionStore.open({
    sid: "e2e-sid",
    model: "test-model",
    cwd: process.cwd(),
    systemHash: "s",
    toolsHash: "t",
    agentVersion: "0.0.0",
    dir: sessionsDir,
  })
  for (let i = 0; i < 8; i++) {
    store.appendUser(`user prompt ${i}`)
    store.appendAssistant(
      [
        { type: "text", text: `assistant reply ${i}` },
        { type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: `echo ${i}` } },
      ],
      "tool_use",
    )
    store.appendToolResult({
      type: "tool_result",
      tool_use_id: `toolu_${i}`,
      content: `output ${i}`,
      is_error: false,
    })
  }

  loader = await PluginLoader.load({
    embeddedDir: resolve(import.meta.dirname, "..", ".."),
    siblingDirs: [SIBLING_ROOT],
    logger: () => {},
    hostOptions: { sessionsDir },
  })
})

async function callTool(input: Record<string, unknown>): Promise<{
  content: string
  is_error?: boolean
}> {
  const r = await loader.dispatch(
    { type: "tool", name: "SessionHistory", input, tool_use_id: "tu" },
    process.cwd(),
  )
  if (r.kind !== "tool_result") throw new Error(`expected tool_result, got ${r.kind}`)
  return r
}

describe("SessionHistory end-to-end through the real loader + store", () => {
  it("the tool is advertised from the manifest", () => {
    const tools = loader.getExtraTools()
    const tool = tools.find((t) => t.name === "SessionHistory")
    expect(tool).toBeDefined()
    expect(tool?.description).toContain("SessionInfo")
  })

  it("default call windows the latest 10 records of the last session", async () => {
    const r = await callTool({})
    expect(r.is_error).toBeFalsy()
    // 1 meta + 24 conversation records = 25 total; latest 10 = 15..24
    expect(r.content).toContain("records 15..24 of 25")
    expect(r.content).toContain("assistant reply 7")
  })

  it("meta summarizes the real store", async () => {
    const r = await callTool({ action: "meta", sid: "e2e-sid" })
    expect(r.content).toContain("Session: e2e-sid")
    expect(r.content).toContain("user=8")
    expect(r.content).toContain("First prompt: user prompt 0")
  })

  it("window from the start pages with stable indexes", async () => {
    const r = await callTool({ action: "window", sid: "e2e-sid", anchor: "start", limit: 3 })
    expect(r.content).toContain("[#0]")
    expect(r.content).toContain("meta · model test-model")
    expect(r.content).toContain(`{anchor:"start", offset:3}`)
  })

  it("tool_calls filters Bash invocations", async () => {
    const r = await callTool({ action: "tool_calls", sid: "e2e-sid", tool: "Bash", limit: 2 })
    expect(r.content).toContain("'Bash' calls")
    expect(r.content).toContain("echo 7")
  })

  it("search finds text inside the transcript", async () => {
    const r = await callTool({ action: "search", sid: "e2e-sid", query: "assistant reply 3" })
    expect(r.content).toContain("assistant reply 3")
    expect(r.is_error).toBeFalsy()
  })

  it("dump renders the --dump markdown shape", async () => {
    const r = await callTool({ action: "dump", sid: "e2e-sid" })
    expect(r.content).toContain("# Session: e2e-sid")
    expect(r.content).toContain("## User")
  })

  it("list shows the seeded session", async () => {
    const r = await callTool({ action: "list" })
    expect(r.content).toContain("e2e-sid")
  })

  it("unknown sid errors cleanly", async () => {
    const r = await callTool({ action: "meta", sid: "does-not-exist" })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("Unknown session id")
  })
})
