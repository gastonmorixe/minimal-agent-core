/**
 * End-to-end integration tests for the memory plugin v0.3.
 *
 * These exercise the FULL closing-the-loop flow:
 *
 *   1. The save-echo bus seam is wired (the host's turn-attachment factory
 *      does this in production from `loader.bus()`; here we wire a local
 *      fake bus into the same `setSaveBus` pointer + a `SaveEchoCollector`).
 *   2. A `<ma::emit::memory>` inline-tag save is dispatched to the save
 *      handler → appends to disk via `MemoryStore` → emits on the bus →
 *      collector buffers.
 *   3. The collector's drained block carries the bullet's id.
 *   4. A subsequent `MemoryTool({action:"edit", id: <that id>, body: "…"})`
 *      dispatched to the tool handler updates the bullet on disk.
 *   5. A subsequent `MemoryTool({action:"read", id: <that id>})` returns
 *      the new body.
 *
 * This is the user-facing promise of v0.3: save by tag, learn the id via
 * the next-turn save-echo, then edit/remove by that id via the tool.
 *
 * Wave D-7 decoupling: the test used to drive the host's real
 * `PluginLoader` (a `src/` import). The plugin must compile and make sense
 * without the host repo, so the loader→dispatch path is replaced by
 * invoking the plugin's OWN handlers against structural-fake contexts. The
 * bus is a local fake matching the plugin's `EventBusSlice` + emit slices,
 * wired the same way the host's turn-attachment seam wires the real bus.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { TUIContext } from "@minimal-agent/plugin-api/types/plugin"

import memoryHandler from "./handlers/memory.ts"
import memoryToolHandler from "./handlers/memory_tool.ts"
import {
  type EventBusSlice,
  type EventContextSlice,
  SaveEchoCollector,
  setSaveBus,
  type Unsubscribe,
} from "./lib/save-echo.ts"
import { ShortTermSnapshot } from "./lib/short-term-snapshot.ts"
import { MemoryStore, projectMemoryPath, shortTermMemoryPath } from "./lib/store.ts"

/**
 * Minimal in-test event bus satisfying the plugin's structural slices.
 * Dispatches on the microtask tick like the host's real `EventBus`, so
 * the `await Promise.resolve()` boundary observes delivered events.
 */
class FakeBus implements EventBusSlice {
  private readonly listeners = new Map<string, Set<(ctx: EventContextSlice) => void>>()
  private disposed = false

  on(event: string, listener: (ctx: EventContextSlice) => void): Unsubscribe {
    if (this.disposed) return () => {}
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return () => set?.delete(listener)
  }

  emit(event: string, payload?: unknown): void {
    if (this.disposed) return
    for (const fn of [...(this.listeners.get(event) ?? [])]) {
      queueMicrotask(() => fn({ payload }))
    }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}

/** No-op `PluginLogger` stub (mirrors the real interface shape). */
function makeNoopLogger() {
  const noop = (
    _s: string,
    _m: string,
    _sd?: Readonly<Record<string, string | number | boolean>>,
  ) => {}
  return {
    emergency: noop,
    alert: noop,
    critical: noop,
    error: noop,
    warn: noop,
    notice: noop,
    info: noop,
    debug: noop,
  }
}

/** Build a structural-fake `TUIContext` for an inline-tag memory save. */
function makeSaveCtx(opts: {
  body: string
  attrs?: Record<string, string>
  cwd?: string
  env?: Record<string, string>
}): TUIContext {
  return {
    trigger: {
      type: "inline_tag",
      name: "memory",
      attrs: opts.attrs ?? {},
      body: opts.body,
      self_closing: false,
    },
    packageDir: resolvePluginDir(),
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? {},
    abort: new AbortController().signal,
    stdout: process.stdout as NodeJS.WriteStream,
    stdin: process.stdin as NodeJS.ReadStream,
    stderr: process.stderr as NodeJS.WriteStream,
    log: makeNoopLogger(),
  } as unknown as TUIContext
}

/** Build a structural-fake `TUIContext` for a MemoryTool call. */
function makeToolCtx(input: Record<string, unknown>, env?: Record<string, string>): TUIContext {
  return {
    trigger: { type: "tool", name: "MemoryTool", input, tool_use_id: "t1" },
    packageDir: resolvePluginDir(),
    cwd: process.cwd(),
    env: env ?? {},
    abort: new AbortController().signal,
    stdout: process.stdout as NodeJS.WriteStream,
    stdin: process.stdin as NodeJS.ReadStream,
    stderr: process.stderr as NodeJS.WriteStream,
    log: makeNoopLogger(),
  } as unknown as TUIContext
}

function resolvePluginDir(): string {
  return import.meta.dir
}

let tmpHome: string
let savedHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "memory-integration-test-"))
  savedHome = process.env.HOME
  process.env.HOME = tmpHome
  setSaveBus(null)
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(tmpHome, { recursive: true, force: true })
  setSaveBus(null)
})

describe("memory plugin v0.3 — closing-the-loop integration", () => {
  it("inline-tag save → save-echo → edit-by-id → read returns updated body (full flow)", async () => {
    const sid = "11111111-2222-3333-4444-555555555555"
    const env = { MINIMAL_AGENT_SESSION_ID: sid, HOME: tmpHome }
    const bus = new FakeBus()
    setSaveBus(bus)
    const collector = SaveEchoCollector.attach(bus)

    // --- 1. Inline-tag save ---
    await memoryHandler(
      makeSaveCtx({ body: "tests live in src/*.test.ts", attrs: { scope: "project" }, env }),
    )
    await Promise.resolve()

    // --- 2. Save-echo collector has the id ready for the next turn ---
    const echoes = collector.consumeAll()
    expect(echoes.length).toBe(1)
    expect(echoes[0]?.type).toBe("text")
    if (echoes[0]?.type !== "text") return
    const echoText = echoes[0].text

    const idMatch = /id="([^"]+)"/.exec(echoText)
    expect(idMatch).not.toBeNull()
    const id = idMatch![1]
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-f]{4}$/)

    // --- 3. Edit by that id via MemoryTool ---
    const editResult = await memoryToolHandler(
      makeToolCtx(
        {
          action: "edit",
          scope: "project",
          id: id!,
          body: "tests live in src/**.test.ts (recursive)",
        },
        env,
      ),
    )
    if (editResult.kind !== "tool_result") return
    expect(editResult.is_error).toBeFalsy()
    expect(editResult.content).toContain(`edited [project#${id}]`)

    // --- 4. Read by id returns the updated body ---
    const readResult = await memoryToolHandler(
      makeToolCtx({ action: "read", scope: "project", id: id! }, env),
    )
    if (readResult.kind !== "tool_result") return
    expect(readResult.is_error).toBeFalsy()
    expect(readResult.content).toContain("recursive")

    collector.detach()
    bus.dispose()
  })

  it("short-term save → snapshot attachment shows it on next turn", async () => {
    const sid = "22222222-3333-4444-5555-666666666666"
    const env = { MINIMAL_AGENT_SESSION_ID: sid, HOME: tmpHome }
    const snapshot = new ShortTermSnapshot(sid, { home: tmpHome })

    // Initially empty — no attachment.
    expect(snapshot.toAttachment()).toBeNull()

    // Save via inline tag.
    await memoryHandler(
      makeSaveCtx({
        body: "active hypothesis: width 80",
        attrs: { scope: "short-term" },
        env,
      }),
    )

    // Snapshot now reflects the new entry.
    const att = snapshot.toAttachment()
    expect(att).not.toBeNull()
    if (att?.type !== "text") return
    expect(att.text).toContain("<ma::agent::short-term-memory>")
    expect(att.text).toContain("[#1] active hypothesis: width 80")
    expect(att.text).toContain("</ma::agent::short-term-memory>")
  })

  it("short-term overflow surfaces evicted count in save-echo", async () => {
    const sid = "33333333-4444-5555-6666-777777777777"
    const env = { MINIMAL_AGENT_SESSION_ID: sid, HOME: tmpHome }
    const bus = new FakeBus()
    setSaveBus(bus)
    const collector = SaveEchoCollector.attach(bus)

    const { SHORT_TERM_CAP } = await import("./lib/store.ts")
    // Fill to the cap via the inline-tag handler.
    for (let i = 1; i <= SHORT_TERM_CAP; i++) {
      await memoryHandler(makeSaveCtx({ body: `entry ${i}`, attrs: { scope: "short-term" }, env }))
    }
    await Promise.resolve()
    collector.consumeAll() // drop fill-up echoes

    // One more push triggers eviction.
    await memoryHandler(makeSaveCtx({ body: "overflow", attrs: { scope: "short-term" }, env }))
    await Promise.resolve()

    const echoes = collector.consumeAll()
    expect(echoes.length).toBe(1)
    if (echoes[0]?.type !== "text") return
    expect(echoes[0].text).toContain('evicted="1"')
    expect(echoes[0].text).toContain('id="' + (SHORT_TERM_CAP + 1) + '"')

    collector.detach()
    bus.dispose()
  })

  it("MemoryTool.list and the inline-tag save share the same store", async () => {
    const env = { HOME: tmpHome }

    // Save via tag.
    await memoryHandler(makeSaveCtx({ body: "via tag", attrs: { scope: "project" }, env }))

    // Save via tool.
    await memoryToolHandler(makeToolCtx({ action: "add", scope: "project", body: "via tool" }, env))

    // List should see both, in insertion order.
    const listResult = await memoryToolHandler(
      makeToolCtx({ action: "list", scope: "project", format: "json" }, env),
    )
    if (listResult.kind !== "tool_result") return
    const parsed = JSON.parse(listResult.content)
    expect(parsed.total).toBe(2)
    expect(parsed.bullets[0].body).toBe("via tag")
    expect(parsed.bullets[1].body).toBe("via tool")
  })

  it("MemoryTool.add does NOT emit on the bus (tool returns id directly; avoids double-echo)", async () => {
    const env = { HOME: tmpHome }
    const bus = new FakeBus()
    setSaveBus(bus)
    const collector = SaveEchoCollector.attach(bus)

    await memoryToolHandler(
      makeToolCtx({ action: "add", scope: "project", body: "no echo expected" }, env),
    )
    await Promise.resolve()

    expect(collector.consumeAll().length).toBe(0)

    // Sanity check: file was still written.
    expect(MemoryStore.project(process.cwd(), { home: tmpHome }).list().length).toBe(1)

    collector.detach()
    bus.dispose()
  })

  it("paths land in the configured tmpHome (not the user's real ~/.minimal-agent/)", async () => {
    const env = { MINIMAL_AGENT_SESSION_ID: "sid-path-check", HOME: tmpHome }
    await memoryHandler(makeSaveCtx({ body: "path check", attrs: { scope: "project" }, env }))

    // The file must exist under tmpHome, not under the real home.
    expect(projectMemoryPath(process.cwd(), { home: tmpHome }).startsWith(tmpHome)).toBe(true)
    expect(MemoryStore.project(process.cwd(), { home: tmpHome }).list().length).toBe(1)
  })

  it("after dispatching a short-term save, the file is at sessions/<sid>.scratch.md", async () => {
    const sid = "44444444-5555-6666-7777-888888888888"
    const env = { MINIMAL_AGENT_SESSION_ID: sid, HOME: tmpHome }

    await memoryHandler(
      makeSaveCtx({ body: "lives at the right path", attrs: { scope: "short-term" }, env }),
    )

    const expected = shortTermMemoryPath(sid, { home: tmpHome })
    expect(MemoryStore.shortTerm(sid, { home: tmpHome }).path).toBe(expected)
    expect(MemoryStore.shortTerm(sid, { home: tmpHome }).list().length).toBe(1)
  })
})
