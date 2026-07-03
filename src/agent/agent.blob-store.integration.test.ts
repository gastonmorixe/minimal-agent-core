/**
 * Integration: Agent ↔ BlobStore ↔ SessionStore.
 *
 * Verifies that the agent's capture point (in `src/agent.ts`) actually
 * writes raw tool outputs to the per-session blob store, appends the
 * `[raw-output: …]` pointer footer to the model-visible `tool_result.content`,
 * and threads the blob metadata through to the JSONL record so session
 * resume / dump can later locate the bytes.
 *
 * The agent's tool dispatch goes through real `executeTool` (so the
 * universal clamp at 64KB / 1000L is exercised end-to-end); the
 * BlobStore points at a freshly-minted tmp directory; the SessionStore
 * points at the same tmp dir; the API is faked via `sendFn`. No real
 * network or `~/.minimal-agent/` involvement.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { SendOptions, StreamedResponse } from "../client/types.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import type { TUIResult } from "../plugins/types.ts"
import { BlobStore } from "../session/blob-store.ts"
import { SessionStore, type ToolResultRecord } from "../session/session-store.ts"
import { MAX_TOOL_OUTPUT_BYTES } from "../tools/truncation.ts"

import { Agent } from "./agent.ts"

let workDir: string
beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "ma-blob-int-"))
})
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const auth: AuthResult = { type: "api-key", token: "test-token" }

/**
 * Fixture: an agent wired to a fresh per-session blob+session store,
 * plus a fake `sendFn` that emits one Bash tool_use and then stops.
 * `command` is the actual shell command to run via the real `Bash`
 * executor; the test then inspects (a) the file under
 * `<sid>.blobs/<tool_use_id>.raw`, (b) the request body the agent
 * eventually sent back, and (c) the JSONL session file.
 */
async function runOneBash(opts: {
  sid: string
  command: string
  config?: ConstructorParameters<typeof BlobStore>[0]["config"]
  toolName?: string
  toolInput?: Record<string, unknown>
}): Promise<{
  blobsDir: string
  sessionPath: string
  toolResultContent: string
  jsonl: ToolResultRecord[]
}> {
  const sid = opts.sid
  const sessionsDir = join(workDir, sid)
  const blobsDir = join(sessionsDir, `${sid}.blobs`)
  const store = SessionStore.open({
    sid,
    dir: sessionsDir,
    model: "test-model",
    cwd: "/tmp",
    systemHash: "deadbeef",
    toolsHash: "cafebabe",
    agentVersion: "test",
  })
  const blobStore = new BlobStore({
    sid,
    dir: blobsDir,
    config: { minBytesToPersist: 1024, ...(opts.config ?? {}) },
  })

  const captured: Array<Record<string, unknown>> = []
  let round = 0
  const sendFn = async function* (
    sendOpts: SendOptions,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    captured.push(JSON.parse(JSON.stringify({ messages: sendOpts.messages })))
    round++
    if (round === 1) {
      return {
        blocks: [
          {
            type: "tool_use" as const,
            id: "toolu_test123",
            name: opts.toolName ?? "Bash",
            input: opts.toolInput ?? { command: opts.command },
          },
        ],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    yield "done"
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
  }

  const agent = new Agent({ auth, model: "test-model", sendFn, store, blobStore })
  const gen = agent.run("go")
  while (true) {
    const { done } = await gen.next()
    if (done) break
  }

  // Round 2's user message carries the tool_result emitted by round 1.
  expect(captured.length).toBeGreaterThanOrEqual(2)
  const round2Msgs = captured[1].messages as Array<Record<string, unknown>>
  let toolResultContent = ""
  for (const msg of round2Msgs) {
    if (msg.role !== "user") continue
    const blocks = msg.content as Array<Record<string, unknown>>
    for (const b of blocks) {
      if (b.type === "tool_result") toolResultContent = String(b.content)
    }
  }
  // Parse JSONL records.
  const lines = readFileSync(store.path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
  const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  const jsonl = records.filter((r) => r.kind === "tool_result") as unknown as ToolResultRecord[]
  return { blobsDir: blobStore.dir, sessionPath: store.path, toolResultContent, jsonl }
}

describe("Agent → BlobStore: built-in path (Bash, universal clamp fires)", () => {
  it("writes a blob with the FULL pre-clamp body and appends the pointer footer", async () => {
    const r = await runOneBash({
      sid: "sid-clamp",
      // > 64KB → universal clamp fires → executeTool sets `_raw`
      command: `yes BIG | head -c ${MAX_TOOL_OUTPUT_BYTES * 2}`,
    })
    // a) tool_result.content has BOTH the truncation notice and the pointer footer
    expect(r.toolResultContent).toContain("[truncated:")
    expect(r.toolResultContent).toMatch(
      /<ma::agent::raw-output path="[^"]+\.raw" size="[^"]+" sha256="[0-9a-f]{16}" \/>/,
    )
    // b) Footer ordering: [truncated: …] appears BEFORE [raw-output: …]
    const truncatedIdx = r.toolResultContent.indexOf("[truncated:")
    const rawOutputIdx = r.toolResultContent.indexOf("<ma::agent::raw-output")
    expect(truncatedIdx).toBeGreaterThan(-1)
    expect(rawOutputIdx).toBeGreaterThan(truncatedIdx)
    // c) JSONL record carries rawPath/Bytes/Sha256
    expect(r.jsonl.length).toBe(1)
    expect(r.jsonl[0].rawPath).toMatch(/\.raw$/)
    expect(r.jsonl[0].rawBytes).toBeGreaterThanOrEqual(MAX_TOOL_OUTPUT_BYTES)
    expect(r.jsonl[0].rawSha256).toMatch(/^[0-9a-f]{16}$/)
    // d) The blob file on disk holds the FULL body (pre-clamp), bigger than
    //    the model-visible `content`.
    const blobBytes = readFileSync(r.jsonl[0].rawPath ?? "")
    expect(blobBytes.byteLength).toBeGreaterThanOrEqual(MAX_TOOL_OUTPUT_BYTES)
    expect(blobBytes.byteLength).toBeGreaterThan(r.toolResultContent.length)
    // e) The blob does NOT contain the [truncated:] notice (raw is pre-clamp)
    expect(blobBytes.toString("utf-8")).not.toContain("[truncated:")
    // f) C1: the TUI-elision <ma::agent::output-preview> annotation carries the
    //    blob's path as a machine-readable attribute (this run is > 64KB AND
    //    > 1000 lines, so the Bash 10-line preview budget is exceeded and a
    //    blob WAS written → the elision flag points at its own recovery
    //    destination instead of stranding the model). Capture the attr value
    //    and prove it both (i) equals the persisted blob path and (ii) is
    //    repeated inside the human-readable hint prose.
    const previewMatch = r.toolResultContent.match(
      /<ma::agent::output-preview shown="\d+" total="\d+" tool="Bash" path="([^"]+\.raw)">/,
    )
    expect(previewMatch).not.toBeNull()
    const previewPath = previewMatch![1]
    // Assert the JSONL recorded a blob path before comparing, so the
    // non-null assertion below is sound and a missing rawPath gives a clear
    // failure (rawPath is typed `string | undefined`).
    expect(r.jsonl[0].rawPath).toBeDefined()
    expect(previewPath).toBe(r.jsonl[0].rawPath!)
    // The same path appears in the hint body text, so a model reading only the
    // prose (not parsing the attr) still learns where the full output lives.
    const previewBlock = r.toolResultContent.slice(
      r.toolResultContent.indexOf("<ma::agent::output-preview"),
    )
    expect(previewBlock).toContain(previewPath)
    expect(previewBlock).toMatch(/Read that path/)
  })
})

describe("Agent → BlobStore: built-in path (no clamp, but body >= minBytes)", () => {
  it("persists the FULL `content` when body is above the size threshold", async () => {
    const r = await runOneBash({
      sid: "sid-medium",
      // 8 KB: above default minBytesToPersist (1024 in this fixture) but below clamp
      command: "printf 'x%.0s' $(seq 1 8192)",
    })
    expect(r.toolResultContent).not.toContain("[truncated:")
    expect(r.toolResultContent).toMatch(/<ma::agent::raw-output\b/)
    const rec = r.jsonl[0]
    expect(rec.rawPath).toBeDefined()
    expect(rec.rawBytes).toBeGreaterThanOrEqual(8192)
    // Blob bytes match the content bytes BEFORE the pointer footer was appended.
    const blobBody = readFileSync(rec.rawPath ?? "", "utf-8")
    expect(blobBody.length).toBe(rec.rawBytes ?? 0)
    // The blob doesn't contain the pointer footer (footer is added to
    // `content`, not to the blob).
    expect(blobBody).not.toMatch(/<ma::agent::raw-output\b/)
  })
})

describe("Agent → BlobStore: built-in path (body below minBytes)", () => {
  it("does NOT persist a blob nor emit the pointer footer for tiny output", async () => {
    const r = await runOneBash({
      sid: "sid-tiny",
      command: "echo hello",
    })
    expect(r.toolResultContent).not.toMatch(/<ma::agent::raw-output\b/)
    expect(r.jsonl[0].rawPath).toBeUndefined()
    expect(r.jsonl[0].rawBytes).toBeUndefined()
    expect(r.jsonl[0].rawSha256).toBeUndefined()
  })
})

describe("Agent → BlobStore: store disabled", () => {
  it("emits NO footer and writes NO blob when config.enabled is false", async () => {
    const r = await runOneBash({
      sid: "sid-disabled",
      command: `yes BIG | head -c ${MAX_TOOL_OUTPUT_BYTES * 2}`,
      config: { enabled: false, minBytesToPersist: 0 },
    })
    expect(r.toolResultContent).not.toMatch(/<ma::agent::raw-output\b/)
    expect(r.jsonl[0].rawPath).toBeUndefined()
  })
})

describe("Agent → BlobStore: Edit/Write path (display is set)", () => {
  it("does NOT persist a blob for Edit even when the new_string is large", async () => {
    // Edit returns a display-set tool result; the capture point skips it.
    const sid = "sid-edit"
    const target = join(workDir, `${sid}-edit-target.txt`)
    writeFileSyncSafe(target, "old content\n")
    const big = "x".repeat(10_000)
    const r = await runOneBash({
      sid,
      toolName: "Edit",
      toolInput: { file_path: target, old_string: "old content", new_string: big },
      command: "unused",
    })
    expect(r.toolResultContent).not.toMatch(/<ma::agent::raw-output\b/)
    expect(r.jsonl[0].rawPath).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Plugin-tool path (Fetch-like): output flows through `loader.dispatch`.
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link PluginLoader}-shaped stub the {@link Agent} can
 * route a `Fetch`-named tool_use through. We don't construct a real
 * `PluginLoader` (manifests, packages, hook bus), only the surface
 * the agent's run loop consumes.
 */
function makePluginLoaderStub(pluginResult: TUIResult): PluginLoader {
  // Minimum surface the agent's run loop calls on a loader: `hasTool`,
  // `dispatch`, `getExtraTools`, `getPromptBlockAsync`, `getToolAliases`,
  // `getPromptBlock`. We don't construct a real PluginLoader (manifests,
  // packages, hook bus), only enough for the agent's dispatch path.
  const stub = {
    hasTool: (name: string) => name === "Fetch",
    dispatch: async (_trigger: unknown, _cwd: string, _signal: AbortSignal) => pluginResult,
    getExtraTools: () => [],
    getPromptBlockAsync: async () => "",
    getPromptBlock: () => "",
    getToolAliases: () => new Map<string, string>(),
  }
  return stub as unknown as PluginLoader
}

async function runOnePluginTool(opts: {
  sid: string
  pluginResult: TUIResult
  /**
   * Override the agent's resolved `blobSkipTools` after construction.
   * The Agent reads `loadBlobStoreConfig().skipTools` once at
   * construction; tests that want to flip the list for a single run
   * patch the private field directly rather than going through the
   * cached config loader (which would leak between tests).
   */
  skipToolsOverride?: ReadonlySet<string>
}): Promise<{
  blobsDir: string
  toolResultContent: string
  jsonl: ToolResultRecord[]
}> {
  const sid = opts.sid
  const sessionsDir = join(workDir, sid)
  const blobsDir = join(sessionsDir, `${sid}.blobs`)
  const store = SessionStore.open({
    sid,
    dir: sessionsDir,
    model: "test-model",
    cwd: "/tmp",
    systemHash: "deadbeef",
    toolsHash: "cafebabe",
    agentVersion: "test",
  })
  const blobStore = new BlobStore({ sid, dir: blobsDir, config: { minBytesToPersist: 1024 } })
  const loader = makePluginLoaderStub(opts.pluginResult)

  const captured: Array<Record<string, unknown>> = []
  let round = 0
  const sendFn = async function* (
    sendOpts: SendOptions,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    captured.push(JSON.parse(JSON.stringify({ messages: sendOpts.messages })))
    round++
    if (round === 1) {
      return {
        blocks: [
          {
            type: "tool_use" as const,
            id: "toolu_plugin_42",
            name: "Fetch",
            input: { url: "https://example.com" },
          },
        ],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    yield "done"
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
  }

  const agent = new Agent({ auth, model: "test-model", sendFn, store, blobStore, loader })
  if (opts.skipToolsOverride !== undefined) {
    // Reach into the private `blobSkipTools` field. TS's `private`
    // marker is compile-time only; runtime bracket access is allowed
    // and keeps the production API surface clean (no public setter
    // exists for production code, which has no reason to flip the
    // list after construction).
    ;(agent as unknown as { blobSkipTools: ReadonlySet<string> }).blobSkipTools =
      opts.skipToolsOverride
  }
  const gen = agent.run("go")
  while (true) {
    const { done } = await gen.next()
    if (done) break
  }
  const round2Msgs = captured[1].messages as Array<Record<string, unknown>>
  let toolResultContent = ""
  for (const msg of round2Msgs) {
    if (msg.role !== "user") continue
    const blocks = msg.content as Array<Record<string, unknown>>
    for (const b of blocks) {
      if (b.type === "tool_result") toolResultContent = String(b.content)
    }
  }
  const lines = readFileSync(store.path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
  const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  const jsonl = records.filter((r) => r.kind === "tool_result") as unknown as ToolResultRecord[]
  return { blobsDir: blobStore.dir, toolResultContent, jsonl }
}

describe("Agent → BlobStore: plugin tool path (universal clamp applies)", () => {
  it("clamps a plugin tool whose content exceeds 64KB, persists raw, appends pointer footer", async () => {
    // Hand the plugin a body that's twice the byte cap so the clamp fires.
    // Plugin tools don't set `display` for the regular content path (only
    // Edit/Write-style diffs do), so the agent's new clamp branch should
    // trigger end-to-end.
    const giantBody = "X".repeat(MAX_TOOL_OUTPUT_BYTES * 2)
    const r = await runOnePluginTool({
      sid: "sid-plugin-clamp",
      pluginResult: {
        kind: "tool_result",
        content: giantBody,
        displayHeader: "https://example.com",
      },
    })
    expect(r.toolResultContent).toContain("[truncated:")
    expect(r.toolResultContent).toMatch(
      /<ma::agent::raw-output path="[^"]+\.raw" size="[^"]+" sha256="[0-9a-f]{16}" \/>/,
    )
    // Order: truncated before raw-output.
    const tIdx = r.toolResultContent.indexOf("[truncated:")
    const rIdx = r.toolResultContent.indexOf("<ma::agent::raw-output")
    expect(tIdx).toBeGreaterThan(-1)
    expect(rIdx).toBeGreaterThan(tIdx)
    // JSONL captures the raw blob metadata.
    expect(r.jsonl[0].rawPath).toMatch(/\.raw$/)
    expect(r.jsonl[0].rawBytes).toBeGreaterThanOrEqual(MAX_TOOL_OUTPUT_BYTES)
    // Disk blob carries the FULL pre-clamp body, byte-for-byte.
    const blob = readFileSync(r.jsonl[0].rawPath ?? "", "utf-8")
    expect(blob.length).toBe(giantBody.length)
    expect(blob).not.toContain("[truncated:")
  })

  it("plugin tool that sets `display` (Fetch-style) still gets the clamp + blob; only `skipTools` opts out", async () => {
    // Fetch (and any other plugin that wants a transcript preview)
    // sets `display` for the user but keeps the FULL body in `content`
    // for the model. The agent must still clamp + blob-persist that
    // body. The previous design accidentally gated both on
    // `!display`, which silently dropped Fetch from the feature. Now
    // the only opt-out is the `skipTools` list (tasks, ShowDiff,
    // LockStatus, MemoryTool — covered by a separate test).
    const giantBody = "Y".repeat(MAX_TOOL_OUTPUT_BYTES * 2)
    const r = await runOnePluginTool({
      sid: "sid-plugin-display-still-clamped",
      pluginResult: {
        kind: "tool_result",
        content: giantBody,
        display: "rendered ANSI preview here",
      },
    })
    expect(r.toolResultContent).toContain("[truncated:")
    expect(r.toolResultContent).toMatch(/<ma::agent::raw-output\b/)
    expect(r.jsonl[0].rawPath).toMatch(/\.raw$/)
    expect(r.jsonl[0].rawBytes).toBeGreaterThanOrEqual(MAX_TOOL_OUTPUT_BYTES)
  })

  it("plugin tools on the `skipTools` list bypass both clamp and blob even with huge content", async () => {
    // Task / MemoryTool / ShowDiff / LockStatus opt out of the agent's
    // post-hoc handling because they render audience-split bodies that
    // would be mangled by a clamp or pointer footer. We exercise this
    // by overriding the agent's resolved skipTools to include `Fetch`
    // (a tool that ordinarily IS clamped). The dispatch path still
    // fires; the agent leaves `content` alone.
    const giantBody = "Z".repeat(MAX_TOOL_OUTPUT_BYTES * 2)
    const r = await runOnePluginTool({
      sid: "sid-plugin-skiptools-bypass",
      pluginResult: { kind: "tool_result", content: giantBody, display: "preview" },
      // Patch the agent's skipTools to include Fetch for this run.
      skipToolsOverride: new Set(["Fetch"]),
    })
    expect(r.toolResultContent).not.toContain("[truncated:")
    expect(r.toolResultContent).not.toMatch(/<ma::agent::raw-output\b/)
    expect(r.jsonl[0].rawPath).toBeUndefined()
  })

  it("plugin tool below the clamp budget is left alone (no notice, but blob still persisted if above minBytes)", async () => {
    // 8 KB plugin output: above the test fixture's 1 KB minBytesToPersist
    // but well below the 64 KB clamp. Should NOT carry `[truncated: …]`,
    // SHOULD carry `[raw-output: …]` since the body is big enough to be
    // worth saving.
    const r = await runOnePluginTool({
      sid: "sid-plugin-medium",
      pluginResult: { kind: "tool_result", content: "Z".repeat(8192) },
    })
    expect(r.toolResultContent).not.toContain("[truncated:")
    expect(r.toolResultContent).toMatch(/<ma::agent::raw-output\b/)
    expect(r.jsonl[0].rawPath).toBeDefined()
    expect(r.jsonl[0].rawBytes).toBe(8192)
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function writeFileSyncSafe(p: string, body: string): void {
  // Avoid a top-level import dance; the Edit fixture only needs a one-shot write.
  require("node:fs").writeFileSync(p, body)
}
