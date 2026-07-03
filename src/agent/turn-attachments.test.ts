/**
 * Tests for the turn-attachment provider seam (Wave A unit A-1).
 *
 * Core must NOT statically import attachment/render libs from the
 * plugins tree (the I2 invariant — `src/index.ts` historically imported
 * `plugins/{memory,sub-agents,tasks}` directly). Instead:
 *
 *   1. Plugins declare `turnAttachments` entries in `manifest.json`;
 *      the loader resolves each module through its blessed
 *      runtime-discovery seam (computed dynamic import, exactly like
 *      `replayRenderers`) and registers the default-export FACTORY into
 *      the core registry in `src/agent/turn-attachments.ts`.
 *   2. The boot path (`src/index.ts`) consumes ONLY the registry:
 *      `instantiateTurnAttachments({sessionId, bus})` returns per-turn
 *      attachment producers (`toAttachment(): ContentBlock | null`) and
 *      content drains (`consumeAll(): ContentBlock[]`) that feed the
 *      Agent's existing `turnAttachments` / `saveEcho` params.
 *   3. Absent plugin = graceful degradation: an empty registry yields
 *      no producers and no drains, and the Agent runs unaffected.
 */

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { ContentBlock, SendOptions, StreamedResponse } from "../client/types.ts"
import { CORE_TOOLS, ROOT, toolManifest, writePackage } from "../plugins/loader.fixtures.ts"
import { PluginLoader } from "../plugins/loader.ts"

import { Agent } from "./agent.ts"
import {
  clearTurnAttachmentFactories,
  combineTurnDrains,
  instantiateTurnAttachments,
  parseReplaySidecarTasks,
  registerTurnAttachmentFactory,
  type TurnContentDrain,
} from "./turn-attachments.ts"

const auth: AuthResult = { type: "api-key", token: "test" }

const TA_HOME = join(ROOT, "turn-attach-home")
const TA_PROJECT = join(ROOT, "turn-attach-project")

/** Factory module body: producer echoing the factory ctx sessionId. */
const PRODUCER_FACTORY_BODY = `
export default function make(ctx) {
  return {
    toAttachment() {
      return { type: "text", text: "<ma::agent::fake sid=\\"" + (ctx.sessionId ?? "none") + "\\">F</ma::agent::fake>" };
    },
  };
}
`

/** Factory module body: drain contributing one block per consumeAll. */
const DRAIN_FACTORY_BODY = `
export default function make() {
  return {
    consumeAll() {
      return [{ type: "text", text: "<ma::agent::drained />" }];
    },
  };
}
`

const TOOL_HANDLER = `export default async () => ({ kind: "tool_result", content: "ok" });`

/** Minimal manifest with one tool + the given turnAttachments entries. */
function taManifest(
  id: string,
  toolName: string,
  entries: readonly unknown[],
): Record<string, unknown> {
  return {
    ...toolManifest(id, toolName, "./h.ts"),
    turnAttachments: entries,
  }
}

function makeTextSendFn(records: Array<Record<string, unknown>>) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

function firstMessageContent(records: Array<Record<string, unknown>>): ContentBlock[] {
  const messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
  return messages[0]?.content ?? []
}

// Clear on BOTH sides of every test: afterEach for hygiene within this
// file, beforeEach because other test files sharing this bun process may
// have registered factories (module-level registry) without cleaning up.
beforeEach(() => {
  clearTurnAttachmentFactories()
})

afterEach(() => {
  clearTurnAttachmentFactories()
})

// ---------------------------------------------------------------------------
// 1. Registry round-trip (pure, no loader)
// ---------------------------------------------------------------------------

describe("turn-attachment registry — round-trip", () => {
  it("instantiates registered factories and classifies producers vs drains", async () => {
    registerTurnAttachmentFactory("p1/prod", (ctx) => ({
      toAttachment: (): ContentBlock => ({ type: "text", text: `P:${ctx.sessionId}` }),
    }))
    registerTurnAttachmentFactory("p1/drain", () => ({
      consumeAll: (): ContentBlock[] => [{ type: "text", text: "D" }],
    }))
    const { producers, drains } = await instantiateTurnAttachments({ sessionId: "sid-1" })
    expect(producers.length).toBe(1)
    expect(drains.length).toBe(1)
    expect(producers[0]?.toAttachment()).toEqual({ type: "text", text: "P:sid-1" })
    expect(drains[0]?.consumeAll()).toEqual([{ type: "text", text: "D" }])
  })

  it("orders producers by (order, registration sequence)", async () => {
    registerTurnAttachmentFactory(
      "z/late",
      () => ({ toAttachment: (): ContentBlock => ({ type: "text", text: "late" }) }),
      { order: 30 },
    )
    registerTurnAttachmentFactory(
      "a/early",
      () => ({ toAttachment: (): ContentBlock => ({ type: "text", text: "early" }) }),
      { order: 10 },
    )
    // No explicit order → default 100, lands last.
    registerTurnAttachmentFactory("m/default", () => ({
      toAttachment: (): ContentBlock => ({ type: "text", text: "default" }),
    }))
    const { producers } = await instantiateTurnAttachments({ sessionId: null })
    expect(producers.map((p) => (p.toAttachment() as { text: string }).text)).toEqual([
      "early",
      "late",
      "default",
    ])
  })

  it("a throwing factory is logged and skipped (never poisons the boot)", async () => {
    registerTurnAttachmentFactory("bad/throws", () => {
      throw new Error("boom")
    })
    registerTurnAttachmentFactory("ok/prod", () => ({
      toAttachment: (): ContentBlock => ({ type: "text", text: "ok" }),
    }))
    const logs: string[] = []
    const { producers, drains } = await instantiateTurnAttachments({ sessionId: null }, (m) =>
      logs.push(m),
    )
    expect(producers.length).toBe(1)
    expect(drains.length).toBe(0)
    expect(logs.some((l) => l.includes("boom"))).toBe(true)
  })

  it("a factory returning null/non-conforming values contributes nothing", async () => {
    registerTurnAttachmentFactory("none/null", () => null)
    registerTurnAttachmentFactory("none/scalar", () => 42)
    registerTurnAttachmentFactory("none/empty-obj", () => ({}))
    const { producers, drains } = await instantiateTurnAttachments({ sessionId: null })
    expect(producers.length).toBe(0)
    expect(drains.length).toBe(0)
  })

  it("re-registering the same key replaces; unregister handle removes only the active one", async () => {
    const off = registerTurnAttachmentFactory("k/x", () => ({
      toAttachment: (): ContentBlock => ({ type: "text", text: "first" }),
    }))
    registerTurnAttachmentFactory("k/x", () => ({
      toAttachment: (): ContentBlock => ({ type: "text", text: "second" }),
    }))
    // `off` belongs to the replaced registration — must be a no-op now.
    off()
    const { producers } = await instantiateTurnAttachments({ sessionId: null })
    expect(producers.length).toBe(1)
    expect((producers[0]?.toAttachment() as { text: string } | undefined)?.text).toBe("second")
  })

  it("async factories are awaited", async () => {
    registerTurnAttachmentFactory("async/prod", async () => ({
      toAttachment: (): ContentBlock => ({ type: "text", text: "async" }),
    }))
    const { producers } = await instantiateTurnAttachments({ sessionId: null })
    expect(producers.length).toBe(1)
  })
})

describe("combineTurnDrains", () => {
  it("returns null for an empty list (Agent gets saveEcho: null)", () => {
    expect(combineTurnDrains([])).toBeNull()
  })

  it("concatenates multiple drains in order", () => {
    const a: TurnContentDrain = { consumeAll: () => [{ type: "text", text: "a" }] }
    const b: TurnContentDrain = { consumeAll: () => [{ type: "text", text: "b" }] }
    const combined = combineTurnDrains([a, b])
    expect(combined?.consumeAll().map((x) => (x as { text: string }).text)).toEqual(["a", "b"])
  })
})

// ---------------------------------------------------------------------------
// 2. Loader seam — manifest-declared factories via a fake plugin dir
// ---------------------------------------------------------------------------

describe("PluginLoader — turnAttachments seam", () => {
  beforeAll(() => {
    rmSync(TA_HOME, { recursive: true, force: true })
    rmSync(TA_PROJECT, { recursive: true, force: true })
    mkdirSync(TA_HOME, { recursive: true })
    mkdirSync(TA_PROJECT, { recursive: true })
  })

  afterEach(() => {
    clearTurnAttachmentFactories()
    rmSync(join(TA_HOME, "plugins"), { recursive: true, force: true })
    rmSync(join(TA_PROJECT, ".agents"), { recursive: true, force: true })
  })

  it("registers a manifest-declared factory (full round-trip through the registry)", async () => {
    writePackage(
      TA_HOME,
      "ta-alpha",
      taManifest("ta-alpha", "ta_tool_a", [
        { id: "fake", order: 10, handler: { type: "module", path: "./attach.ts" } },
      ]),
      { "h.ts": TOOL_HANDLER, "attach.ts": PRODUCER_FACTORY_BODY },
    )
    const logs: string[] = []
    await PluginLoader.load({
      homeDir: TA_HOME,
      projectDir: join(ROOT, "ta-nope"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    const { producers } = await instantiateTurnAttachments({ sessionId: "boot-sid" })
    expect(producers.length).toBe(1)
    expect((producers[0]?.toAttachment() as { text: string } | undefined)?.text).toBe(
      '<ma::agent::fake sid="boot-sid">F</ma::agent::fake>',
    )
  })

  it("a missing factory module is logged and skipped (plugin keeps its tools)", async () => {
    writePackage(
      TA_HOME,
      "ta-beta",
      taManifest("ta-beta", "ta_tool_b", [
        { id: "fake", handler: { type: "module", path: "./nope.ts" } },
      ]),
      { "h.ts": TOOL_HANDLER },
    )
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: TA_HOME,
      projectDir: join(ROOT, "ta-nope"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.hasTool("ta_tool_b")).toBe(true)
    const { producers, drains } = await instantiateTurnAttachments({ sessionId: null })
    expect(producers.length).toBe(0)
    expect(drains.length).toBe(0)
    expect(logs.some((l) => l.includes("turn attachment"))).toBe(true)
  })

  it("a non-function default export is logged and skipped", async () => {
    writePackage(
      TA_HOME,
      "ta-gamma",
      taManifest("ta-gamma", "ta_tool_c", [
        { id: "fake", handler: { type: "module", path: "./attach.ts" } },
      ]),
      { "h.ts": TOOL_HANDLER, "attach.ts": "export default 42;" },
    )
    const logs: string[] = []
    await PluginLoader.load({
      homeDir: TA_HOME,
      projectDir: join(ROOT, "ta-nope"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    const { producers } = await instantiateTurnAttachments({ sessionId: null })
    expect(producers.length).toBe(0)
    expect(logs.some((l) => l.includes("turn attachment"))).toBe(true)
  })

  it("malformed turnAttachments entries are skipped without poisoning the package", async () => {
    writePackage(
      TA_HOME,
      "ta-delta",
      taManifest("ta-delta", "ta_tool_d", [
        "not-an-object",
        { handler: { type: "module", path: "./attach.ts" } }, // no id
        { id: "bad-type", handler: { type: "subprocess", command: ["x"] } },
      ]),
      { "h.ts": TOOL_HANDLER, "attach.ts": PRODUCER_FACTORY_BODY },
    )
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: TA_HOME,
      projectDir: join(ROOT, "ta-nope"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.hasTool("ta_tool_d")).toBe(true)
    const { producers } = await instantiateTurnAttachments({ sessionId: null })
    expect(producers.length).toBe(0)
  })

  it("first-wins when the same plugin id exists in two roots (project shadows home)", async () => {
    writePackage(
      TA_PROJECT,
      "ta-dup",
      taManifest("ta-dup", "ta_tool_p", [
        { id: "who", handler: { type: "module", path: "./attach.ts" } },
      ]),
      {
        "h.ts": TOOL_HANDLER,
        "attach.ts": `export default () => ({ toAttachment: () => ({ type: "text", text: "FROM PROJECT" }) });`,
      },
      ".agents/plugins",
    )
    writePackage(
      TA_HOME,
      "ta-dup",
      taManifest("ta-dup", "ta_tool_h", [
        { id: "who", handler: { type: "module", path: "./attach.ts" } },
      ]),
      {
        "h.ts": TOOL_HANDLER,
        "attach.ts": `export default () => ({ toAttachment: () => ({ type: "text", text: "FROM HOME" }) });`,
      },
    )
    const logs: string[] = []
    await PluginLoader.load({
      homeDir: TA_HOME,
      projectDir: TA_PROJECT,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    const { producers } = await instantiateTurnAttachments({ sessionId: null })
    expect(producers.length).toBe(1)
    expect((producers[0]?.toAttachment() as { text: string } | undefined)?.text).toBe(
      "FROM PROJECT",
    )
  })

  // -------------------------------------------------------------------------
  // 3. Boot path: loader → registry → Agent (what src/index.ts composes)
  // -------------------------------------------------------------------------

  it("boot path: producers + drains from a fake plugin reach the Agent's first user message", async () => {
    writePackage(
      TA_HOME,
      "ta-boot",
      taManifest("ta-boot", "ta_tool_e", [
        { id: "prod", order: 10, handler: { type: "module", path: "./attach.ts" } },
        { id: "drain", order: 90, handler: { type: "module", path: "./drain.ts" } },
      ]),
      { "h.ts": TOOL_HANDLER, "attach.ts": PRODUCER_FACTORY_BODY, "drain.ts": DRAIN_FACTORY_BODY },
    )
    await PluginLoader.load({
      homeDir: TA_HOME,
      projectDir: join(ROOT, "ta-nope"),
      coreToolNames: CORE_TOOLS,
      logger: () => {},
    })
    const { producers, drains } = await instantiateTurnAttachments({ sessionId: "boot-sid" })

    const records: Array<Record<string, unknown>> = []
    const agent = new Agent({
      auth,
      model: "test-model-1",
      sendFn: makeTextSendFn(records),
      turnAttachments: producers,
      saveEcho: combineTurnDrains(drains),
    })
    for await (const _ of agent.run("hi")) {
      // drain
    }
    const content = firstMessageContent(records)
    expect(content.length).toBe(3)
    expect((content[0] as { text: string }).text).toContain("<ma::agent::fake")
    expect((content[1] as { text: string }).text).toContain("<ma::agent::drained")
    expect((content[2] as { text: string }).text).toBe("hi")
  })

  it("absent plugin: empty registry degrades gracefully (Agent sees only user text)", async () => {
    await PluginLoader.load({
      homeDir: join(ROOT, "ta-empty-home"),
      projectDir: join(ROOT, "ta-empty-project"),
      coreToolNames: CORE_TOOLS,
      logger: () => {},
    })
    const { producers, drains } = await instantiateTurnAttachments({ sessionId: "boot-sid" })
    expect(producers.length).toBe(0)
    expect(drains.length).toBe(0)

    const records: Array<Record<string, unknown>> = []
    const agent = new Agent({
      auth,
      model: "test-model-1",
      sendFn: makeTextSendFn(records),
      turnAttachments: producers,
      saveEcho: combineTurnDrains(drains),
    })
    for await (const _ of agent.run("hi")) {
      // drain
    }
    const content = firstMessageContent(records)
    expect(content.length).toBe(1)
    expect((content[0] as { text: string }).text).toBe("hi")
  })
})

// ---------------------------------------------------------------------------
// 4. Replay sidecar parsing (the 6th index.ts plugin import — parse.ts)
// ---------------------------------------------------------------------------

describe("parseReplaySidecarTasks", () => {
  const V2_LINE = JSON.stringify({
    v: 2,
    id: "a7b3c4",
    parent: null,
    status: "doing",
    title: "do the thing",
    created_at: "2026-06-10T10:00:00-04:00",
    done_at: null,
    reason: null,
    started_at: "2026-06-10T10:05:00-04:00",
    last_resumed_at: "2026-06-10T10:05:00-04:00",
    active_ms: 1500,
  })
  const V1_LINE = JSON.stringify({
    v: 1,
    id: "a7b3c4a",
    parent: "a7b3c4",
    status: "done",
    title: "subtask",
    created_at: "2026-06-10T09:00:00-04:00",
    done_at: "2026-06-10T09:30:00-04:00",
    reason: null,
  })

  it("parses well-formed JSONL lines (v2 + v1 forward-compat defaults)", () => {
    const tasks = parseReplaySidecarTasks(`${V2_LINE}\n${V1_LINE}\n`)
    expect(tasks.length).toBe(2)
    expect(tasks[0]?.id).toBe("a7b3c4")
    expect(tasks[0]?.status).toBe("doing")
    expect(tasks[0]?.active_ms).toBe(1500)
    // v1 line: v2 fields default to null / 0.
    expect(tasks[1]?.id).toBe("a7b3c4a")
    expect(tasks[1]?.parent).toBe("a7b3c4")
    expect(tasks[1]?.started_at).toBeNull()
    expect(tasks[1]?.last_resumed_at).toBeNull()
    expect(tasks[1]?.active_ms).toBe(0)
  })

  it("drops corrupt / blank / non-task lines silently", () => {
    const text = ["not json", "", V2_LINE, JSON.stringify({ id: "zzzzzz!" }), "[1,2]"].join("\n")
    const tasks = parseReplaySidecarTasks(text)
    expect(tasks.length).toBe(1)
    expect(tasks[0]?.id).toBe("a7b3c4")
  })

  it("returns [] for empty input", () => {
    expect(parseReplaySidecarTasks("")).toEqual([])
  })
})
