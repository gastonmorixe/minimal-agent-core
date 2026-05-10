/**
 * End-to-end integration tests for the memory plugin v0.3.
 *
 * These exercise the FULL closing-the-loop flow:
 *
 *   1. Real `PluginLoader` loads the embedded memory plugin.
 *   2. `setGlobalEventBus(loader.bus())` wires the global bus pointer.
 *   3. `SaveEchoCollector.attach(loader.bus())` subscribes to MEMORY_SAVED.
 *   4. A `<tui::memory>` inline-tag save dispatched through the loader
 *      → handler appends to disk via `MemoryStore` → emits on bus →
 *      collector buffers.
 *   5. The collector's drained block carries the bullet's id.
 *   6. A subsequent `MemoryTool({action:"edit", id: <that id>, body: "…"})`
 *      dispatched through the loader updates the bullet on disk.
 *   7. A subsequent `MemoryTool({action:"read", id: <that id>})` returns
 *      the new body.
 *
 * This is the user-facing promise of v0.3: save by tag, learn the id
 * via the next-turn save-echo, then edit/remove by that id via the
 * tool. If any seam breaks, this test catches it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { setGlobalEventBus } from "../../src/global-bus.ts"
import { PluginLoader } from "../../src/plugins/loader.ts"

import { SaveEchoCollector } from "./lib/save-echo.ts"
import { MemoryStore, projectMemoryPath, shortTermMemoryPath } from "./lib/store.ts"
import { ShortTermSnapshot } from "./lib/short-term-snapshot.ts"

const PROJECT_ROOT = resolve(__dirname, "../..")

let tmpHome: string
let savedHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "memory-integration-test-"))
  savedHome = process.env.HOME
  process.env.HOME = tmpHome
  setGlobalEventBus(null)
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(tmpHome, { recursive: true, force: true })
  setGlobalEventBus(null)
})

describe("memory plugin v0.3 — closing-the-loop integration", () => {
  it("inline-tag save → save-echo → edit-by-id → read returns updated body (full flow)", async () => {
    const sid = "11111111-2222-3333-4444-555555555555"
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })
    setGlobalEventBus(loader.bus())
    const collector = SaveEchoCollector.attach(loader.bus())

    // --- 1. Inline-tag save ---
    await loader.dispatch(
      {
        type: "inline_tag",
        name: "memory",
        attrs: { scope: "project" },
        body: "tests live in src/*.test.ts",
        self_closing: false,
      },
      process.cwd(),
    )
    await Promise.resolve()

    // --- 2. Save-echo collector has the id ready for the next turn ---
    const echoes = collector.consumeAll()
    expect(echoes.length).toBe(1)
    expect(echoes[0]?.type).toBe("text")
    if (echoes[0]?.type !== "text") return
    const echoText = echoes[0].text

    // Extract the id from the <memory-saved scope="project" id="…">
    const idMatch = /id="([^"]+)"/.exec(echoText)
    expect(idMatch).not.toBeNull()
    const id = idMatch![1]
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-f]{4}$/)

    // --- 3. Edit by that id via MemoryTool ---
    const editResult = await loader.dispatch(
      {
        type: "tool",
        name: "MemoryTool",
        input: {
          action: "edit",
          scope: "project",
          id: id!,
          body: "tests live in src/**.test.ts (recursive)",
        },
        tool_use_id: "edit-1",
      },
      process.cwd(),
    )
    expect(editResult).not.toBeNull()
    if (editResult?.kind !== "tool_result") return
    expect(editResult.is_error).toBeFalsy()
    expect(editResult.content).toContain(`edited [project#${id}]`)

    // --- 4. Read by id returns the updated body ---
    const readResult = await loader.dispatch(
      {
        type: "tool",
        name: "MemoryTool",
        input: { action: "read", scope: "project", id: id! },
        tool_use_id: "read-1",
      },
      process.cwd(),
    )
    expect(readResult).not.toBeNull()
    if (readResult?.kind !== "tool_result") return
    expect(readResult.is_error).toBeFalsy()
    expect(readResult.content).toContain("recursive")

    collector.detach()
  })

  it("short-term save → snapshot attachment shows it on next turn", async () => {
    const sid = "22222222-3333-4444-5555-666666666666"
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })
    setGlobalEventBus(loader.bus())
    const snapshot = new ShortTermSnapshot(sid)

    // Initially empty — no attachment.
    expect(snapshot.toAttachment()).toBeNull()

    // Save via inline tag.
    await loader.dispatch(
      {
        type: "inline_tag",
        name: "memory",
        attrs: { scope: "short-term" },
        body: "active hypothesis: width 80",
        self_closing: false,
      },
      process.cwd(),
    )

    // Snapshot now reflects the new entry.
    const att = snapshot.toAttachment()
    expect(att).not.toBeNull()
    if (att?.type !== "text") return
    expect(att.text).toContain("<short-term-memory>")
    expect(att.text).toContain("[#1] active hypothesis: width 80")
    expect(att.text).toContain("</short-term-memory>")
  })

  it("short-term overflow surfaces evicted count in save-echo", async () => {
    const sid = "33333333-4444-5555-6666-777777777777"
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })
    setGlobalEventBus(loader.bus())
    const collector = SaveEchoCollector.attach(loader.bus())

    const { SHORT_TERM_CAP } = await import("./lib/store.ts")
    // Fill to the cap via the inline-tag handler (so we exercise the
    // real handler, not the store directly).
    for (let i = 1; i <= SHORT_TERM_CAP; i++) {
      await loader.dispatch(
        {
          type: "inline_tag",
          name: "memory",
          attrs: { scope: "short-term" },
          body: `entry ${i}`,
          self_closing: false,
        },
        process.cwd(),
      )
    }
    await Promise.resolve()
    collector.consumeAll() // drop fill-up echoes

    // One more push triggers eviction.
    await loader.dispatch(
      {
        type: "inline_tag",
        name: "memory",
        attrs: { scope: "short-term" },
        body: "overflow",
        self_closing: false,
      },
      process.cwd(),
    )
    await Promise.resolve()

    const echoes = collector.consumeAll()
    expect(echoes.length).toBe(1)
    if (echoes[0]?.type !== "text") return
    expect(echoes[0].text).toContain('evicted="1"')
    expect(echoes[0].text).toContain('id="' + (SHORT_TERM_CAP + 1) + '"')

    collector.detach()
  })

  it("MemoryTool.list and the inline-tag save share the same store", async () => {
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
    })
    setGlobalEventBus(loader.bus())

    // Save via tag.
    await loader.dispatch(
      {
        type: "inline_tag",
        name: "memory",
        attrs: { scope: "project" },
        body: "via tag",
        self_closing: false,
      },
      process.cwd(),
    )

    // Save via tool.
    await loader.dispatch(
      {
        type: "tool",
        name: "MemoryTool",
        input: { action: "add", scope: "project", body: "via tool" },
        tool_use_id: "add-via-tool",
      },
      process.cwd(),
    )

    // List should see both, in insertion order.
    const listResult = await loader.dispatch(
      {
        type: "tool",
        name: "MemoryTool",
        input: { action: "list", scope: "project", format: "json" },
        tool_use_id: "list-1",
      },
      process.cwd(),
    )
    if (listResult?.kind !== "tool_result") return
    const parsed = JSON.parse(listResult.content)
    expect(parsed.total).toBe(2)
    expect(parsed.bullets[0].body).toBe("via tag")
    expect(parsed.bullets[1].body).toBe("via tool")
  })

  it("MemoryTool.add does NOT emit on the bus (tool returns id directly; avoids double-echo)", async () => {
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
    })
    setGlobalEventBus(loader.bus())
    const collector = SaveEchoCollector.attach(loader.bus())

    await loader.dispatch(
      {
        type: "tool",
        name: "MemoryTool",
        input: { action: "add", scope: "project", body: "no echo expected" },
        tool_use_id: "add-no-echo",
      },
      process.cwd(),
    )
    await Promise.resolve()

    expect(collector.consumeAll().length).toBe(0)

    // Sanity check: file was still written.
    expect(MemoryStore.project(process.cwd(), { home: tmpHome }).list().length).toBe(1)

    collector.detach()
  })

  it("paths land in the configured tmpHome (not the user's real ~/.minimal-agent/)", async () => {
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: "sid-path-check",
    })

    await loader.dispatch(
      {
        type: "inline_tag",
        name: "memory",
        attrs: { scope: "project" },
        body: "path check",
        self_closing: false,
      },
      process.cwd(),
    )

    // The file must exist under tmpHome, not under the real home.
    expect(projectMemoryPath(process.cwd(), tmpHome).startsWith(tmpHome)).toBe(true)
    expect(MemoryStore.project(process.cwd(), { home: tmpHome }).list().length).toBe(1)
  })

  it("after dispatching a short-term save, the file is at sessions/<sid>.scratch.md", async () => {
    const sid = "44444444-5555-6666-7777-888888888888"
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })

    await loader.dispatch(
      {
        type: "inline_tag",
        name: "memory",
        attrs: { scope: "short-term" },
        body: "lives at the right path",
        self_closing: false,
      },
      process.cwd(),
    )

    const expected = shortTermMemoryPath(sid, { home: tmpHome })
    expect(MemoryStore.shortTerm(sid, { home: tmpHome }).path).toBe(expected)
    expect(MemoryStore.shortTerm(sid, { home: tmpHome }).list().length).toBe(1)
  })
})
