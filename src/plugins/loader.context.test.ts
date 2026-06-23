import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import {
  CORE_TOOLS,
  HOME,
  PROJECT,
  ROOT,
  TOOL_HANDLER_BODY,
  toolManifest,
  writePackage,
} from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

/**
 * Noop `PluginLogger` stand-in for ad-hoc `LiveAreaHandlerContext`
 * fixtures in this file. Production wiring uses `createPluginLogger`
 * from `src/diagnostic-bus.ts` (which fans events out to file +
 * scrollback + TUI surface); tests don't want that — they just need
 * the type to satisfy.
 */
function noopLogger(): import("../diagnostic-bus.ts").PluginLogger {
  const noop = () => {}
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

describe("PluginLoader / AgentContext threading", () => {
  // Handler that serializes `ctx.agent` + the four `MINIMAL_AGENT_*`
  // env vars into the tool_result content so the test can inspect both
  // the typed surface AND the env-var bridge.
  const AGENT_PROBE_HANDLER_BODY = `
export default async function handler(ctx) {
  const env = ctx.env ?? {}
  return {
    kind: "tool_result",
    content: JSON.stringify({
      agent: ctx.agent ?? null,
      env: {
        MINIMAL_AGENT_SESSION_ID: env.MINIMAL_AGENT_SESSION_ID ?? null,
        MINIMAL_AGENT_PID:        env.MINIMAL_AGENT_PID ?? null,
        MINIMAL_AGENT_MODEL:      env.MINIMAL_AGENT_MODEL ?? null,
        MINIMAL_AGENT_VERSION:    env.MINIMAL_AGENT_VERSION ?? null,
      },
    }),
  };
}
`
  const HOME_AC = join(ROOT, "home-ac")
  const TEST_AGENT = Object.freeze({
    sessionId: "ac-session-uuid",
    pid: 42,
    model: "test-model-1[1m]",
    version: "1.2.3",
  })

  beforeAll(() => {
    mkdirSync(HOME_AC, { recursive: true })
  })
  afterAll(() => {
    rmSync(HOME_AC, { recursive: true, force: true })
  })

  it("threads AgentContext into ctx.agent on a tool dispatch", async () => {
    writePackage(HOME_AC, "p1", toolManifest("p1", "agent_probe_1", "./h.ts"), {
      "h.ts": AGENT_PROBE_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME_AC,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      agent: TEST_AGENT,
    })
    const result = await loader.dispatch(
      { type: "tool", name: "agent_probe_1", input: {}, tool_use_id: "toolu_ac1" },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    const parsed = JSON.parse(result.content)
    expect(parsed.agent).toEqual(TEST_AGENT)
    expect(parsed.env.MINIMAL_AGENT_SESSION_ID).toBe("ac-session-uuid")
    expect(parsed.env.MINIMAL_AGENT_PID).toBe("42")
    expect(parsed.env.MINIMAL_AGENT_MODEL).toBe("test-model-1[1m]")
    expect(parsed.env.MINIMAL_AGENT_VERSION).toBe("1.2.3")
    rmSync(join(HOME_AC, "plugins", "p1"), { recursive: true })
  })

  it("synthesizes AgentContext from the deprecated `sessionId` option when `agent` is omitted", async () => {
    writePackage(HOME_AC, "p2", toolManifest("p2", "agent_probe_2", "./h.ts"), {
      "h.ts": AGENT_PROBE_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME_AC,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      sessionId: "legacy-session",
    })
    const result = await loader.dispatch(
      { type: "tool", name: "agent_probe_2", input: {}, tool_use_id: "toolu_ac2" },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    const parsed = JSON.parse(result.content)
    expect(parsed.agent.sessionId).toBe("legacy-session")
    expect(parsed.agent.pid).toBe(process.pid)
    // model and version are inherited from process.env (may be empty in tests)
    expect(typeof parsed.agent.model).toBe("string")
    expect(typeof parsed.agent.version).toBe("string")
    expect(parsed.env.MINIMAL_AGENT_SESSION_ID).toBe("legacy-session")
    expect(parsed.env.MINIMAL_AGENT_PID).toBe(String(process.pid))
    rmSync(join(HOME_AC, "plugins", "p2"), { recursive: true })
  })

  it("leaves ctx.agent undefined when neither `agent` nor `sessionId` is supplied (back-compat)", async () => {
    writePackage(HOME_AC, "p3", toolManifest("p3", "agent_probe_3", "./h.ts"), {
      "h.ts": AGENT_PROBE_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME_AC,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const result = await loader.dispatch(
      { type: "tool", name: "agent_probe_3", input: {}, tool_use_id: "toolu_ac3" },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    const parsed = JSON.parse(result.content)
    expect(parsed.agent).toBeNull()
    rmSync(join(HOME_AC, "plugins", "p3"), { recursive: true })
  })

  it("exposes the AgentContext via loader.agentContext() for sibling consumers", async () => {
    writePackage(HOME_AC, "p4", toolManifest("p4", "agent_probe_4", "./h.ts"), {
      "h.ts": AGENT_PROBE_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME_AC,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      agent: TEST_AGENT,
    })
    expect(loader.agentContext()).toEqual(TEST_AGENT)
    rmSync(join(HOME_AC, "plugins", "p4"), { recursive: true })
  })
})

describe("PluginLoader / liveAreaSlots", () => {
  it("resolves a module-handler slot, applies defaults, and exposes via getLiveAreaSlots()", async () => {
    writePackage(
      HOME,
      "la-mod",
      {
        id: "la-mod",
        name: "la-mod",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "ambient",
            handler: { type: "module", path: "./prov.ts", export: "default" },
            // No position / refreshMs / timeoutMs — exercise the defaults.
          },
        ],
      },
      {
        "prov.ts": `
          export default async function (ctx) {
            return "ambient@" + (ctx?.tick ?? -1)
          }
        `,
      },
    )

    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
    const slots = loader.getLiveAreaSlots()
    expect(slots).toHaveLength(1)
    expect(slots[0]!.pluginId).toBe("la-mod")
    expect(slots[0]!.definition.id).toBe("ambient")
    expect(slots[0]!.definition.position).toBe("footer")
    expect(slots[0]!.definition.refreshMs).toBe(60_000)
    expect(slots[0]!.definition.timeoutMs).toBe(5_000)
    // packageDir points at the actual package dir on disk.
    expect(slots[0]!.packageDir).toBe(join(HOME, "plugins", "la-mod"))
    // Invoke is callable and threads the tick through.
    const out = await slots[0]!.invoke({
      packageDir: slots[0]!.packageDir,
      cwd: process.cwd(),
      env: {},
      abort: new AbortController().signal,
      stderr: process.stderr,
      log: noopLogger(),
      tick: 0,
    })
    expect(out).toBe("ambient@0")

    rmSync(join(HOME, "plugins", "la-mod"), { recursive: true })
  })

  it("logs and skips a slot whose module handler is missing", async () => {
    const logs: string[] = []
    writePackage(HOME, "la-missing", {
      id: "la-missing",
      name: "la-missing",
      version: "0.1.0",
      description: "test",
      liveAreaSlots: [
        {
          id: "x",
          handler: { type: "module", path: "./nope.ts", export: "default" },
        },
      ],
    })
    const loader = await PluginLoader.load({ homeDir: HOME, logger: (m) => logs.push(m) })
    expect(loader.getLiveAreaSlots()).toEqual([])
    expect(logs.some((m) => /live-area slot handler module not found/.test(m))).toBe(true)
    rmSync(join(HOME, "plugins", "la-missing"), { recursive: true })
  })

  it("logs and skips a slot whose module handler has no default export", async () => {
    const logs: string[] = []
    writePackage(
      HOME,
      "la-noexport",
      {
        id: "la-noexport",
        name: "la-noexport",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "x",
            handler: { type: "module", path: "./prov.ts", export: "default" },
          },
        ],
      },
      {
        "prov.ts": "export const named = () => 'nope'",
      },
    )
    const loader = await PluginLoader.load({ homeDir: HOME, logger: (m) => logs.push(m) })
    expect(loader.getLiveAreaSlots()).toEqual([])
    expect(logs.some((m) => /no default export function/.test(m))).toBe(true)
    rmSync(join(HOME, "plugins", "la-noexport"), { recursive: true })
  })

  it("rejects a non-string return from a module handler", async () => {
    writePackage(
      HOME,
      "la-badreturn",
      {
        id: "la-badreturn",
        name: "la-badreturn",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "x",
            handler: { type: "module", path: "./prov.ts", export: "default" },
          },
        ],
      },
      {
        "prov.ts": "export default async function () { return 42 }",
      },
    )
    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
    const slots = loader.getLiveAreaSlots()
    expect(slots).toHaveLength(1)
    await expect(
      slots[0]!.invoke({
        packageDir: slots[0]!.packageDir,
        cwd: process.cwd(),
        env: {},
        abort: new AbortController().signal,
        stderr: process.stderr,
        log: noopLogger(),
        tick: 0,
      }),
    ).rejects.toThrow(/returned non-string/)
    rmSync(join(HOME, "plugins", "la-badreturn"), { recursive: true })
  })

  it("a slot does NOT count as a tool (separate accessors)", async () => {
    writePackage(
      HOME,
      "la-tool-and-slot",
      {
        id: "la-tool-and-slot",
        name: "la-tool-and-slot",
        version: "0.1.0",
        description: "test",
        tuis: [
          {
            id: "only",
            trigger: {
              type: "tool",
              tool: {
                name: "tool_x",
                description: "x",
                input_schema: { type: "object", properties: {} },
                explicitName: true,
              },
            },
            handler: { type: "module", path: "./h.ts", export: "default" },
            interactive: false,
          },
        ],
        liveAreaSlots: [
          {
            id: "ambient",
            handler: { type: "module", path: "./prov.ts", export: "default" },
          },
        ],
      },
      {
        "h.ts": TOOL_HANDLER_BODY,
        "prov.ts": "export default async () => 'hi'",
      },
    )
    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_x"])
    expect(loader.getLiveAreaSlots().map((s) => s.definition.id)).toEqual(["ambient"])
    rmSync(join(HOME, "plugins", "la-tool-and-slot"), { recursive: true })
  })

  it("disabledPluginIds removes the slot too", async () => {
    writePackage(
      HOME,
      "la-disabled",
      {
        id: "la-disabled",
        name: "la-disabled",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "x",
            handler: { type: "module", path: "./prov.ts", export: "default" },
          },
        ],
      },
      { "prov.ts": "export default async () => 'hi'" },
    )
    const loader = await PluginLoader.load({
      homeDir: HOME,
      logger: () => {},
      disabledPluginIds: new Set(["la-disabled"]),
    })
    expect(loader.getLiveAreaSlots()).toEqual([])
    rmSync(join(HOME, "plugins", "la-disabled"), { recursive: true })
  })
})

describe("PluginLoader / liveAreaSlots: placeholder + refreshOn", () => {
  it("threads placeholder through resolution; refreshOn defaults to []", async () => {
    writePackage(
      HOME,
      "la-pl",
      {
        id: "la-pl",
        name: "la-pl",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "x",
            handler: { type: "module", path: "./prov.ts", export: "default" },
            placeholder: "loading…",
          },
        ],
      },
      { "prov.ts": "export default async () => 'data'" },
    )
    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
    const slot = loader.getLiveAreaSlots()[0]!
    expect(slot.definition.placeholder).toBe("loading…")
    expect(slot.definition.refreshOn).toEqual([])
    rmSync(join(HOME, "plugins", "la-pl"), { recursive: true })
  })

  it("normalizes refreshOn", async () => {
    writePackage(
      HOME,
      "la-ro",
      {
        id: "la-ro",
        name: "la-ro",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "x",
            handler: { type: "module", path: "./prov.ts", export: "default" },
            refreshOn: ["a.b", "c.d"],
          },
        ],
      },
      { "prov.ts": "export default async () => 'data'" },
    )
    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
    const slot = loader.getLiveAreaSlots()[0]!
    expect(slot.definition.refreshOn).toEqual(["a.b", "c.d"])
    rmSync(join(HOME, "plugins", "la-ro"), { recursive: true })
  })
})

// ---------------------------------------------------------------------------
// dispatch — external AbortSignal propagation
// ---------------------------------------------------------------------------
//
// REGRESSION GUARD (May 2026): the loader's `dispatch()` used to ignore the
// agent's per-turn AbortSignal entirely — its only abort source was an
// internal AbortController bounded by the handler's manifest `timeoutMs`.
// So when a user pressed Esc / Ctrl+C while a plugin tool (Fetch, WebSearch,
// …) was running, the abort fired on the agent's turn signal but never
// reached `ctx.abort`, leaving the plugin's headless-browser / subprocess
// hung until the manifest timeout (often minutes). User-visible symptom:
// "Running Fetch ⋯ stalled · last byte 15m ago" and Esc/Ctrl+C no-ops.
//
// Fix: `dispatch(trigger, agentCwd, externalSignal?)` accepts the caller's
// AbortSignal and OR-s it with the internal timeout controller, so either
// source aborts `ctx.abort`. Plugin handlers (ma-fetch's `lib/backend.ts`
// etc.) already listen on `ctx.abort` and do SIGTERM→SIGKILL on subprocs.
// ---------------------------------------------------------------------------

const HANGING_HANDLER_BODY = `
export default async function handler(ctx) {
  // Resolve only when ctx.abort fires; otherwise hang forever. This is
  // the canonical shape of plugin handlers that spawn long-running
  // subprocesses (ma-fetch obscura, ma-search browsers, etc.).
  await new Promise((resolve) => {
    if (ctx.abort.aborted) return resolve();
    ctx.abort.addEventListener("abort", () => resolve(), { once: true });
  });
  return {
    kind: "tool_result",
    content: "aborted-via-ctx",
    is_error: true,
  };
}
`

describe("PluginLoader / dispatch external AbortSignal", () => {
  beforeAll(() => {
    mkdirSync(HOME, { recursive: true })
    mkdirSync(PROJECT, { recursive: true })
  })
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  it("aborts an in-flight plugin handler when externalSignal fires", async () => {
    writePackage(HOME, "abrt1", toolManifest("abrt1", "hang_tool", "./h.ts"), {
      "h.ts": HANGING_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const ctrl = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ctrl.abort(), 30)
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "hang_tool",
        input: {},
        tool_use_id: "toolu_abrt1",
      },
      process.cwd(),
      ctrl.signal,
    )
    const elapsed = Date.now() - t0
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toBe("aborted-via-ctx")
    // Should resolve within a small window after the 30ms abort fires.
    // Generous upper bound (500ms) to avoid CI flake; the bug had this
    // hang for minutes.
    expect(elapsed).toBeLessThan(500)
    rmSync(join(HOME, "plugins", "abrt1"), { recursive: true })
  })

  it("does not crash when externalSignal is omitted (back-compat)", async () => {
    writePackage(HOME, "abrt2", toolManifest("abrt2", "echo_tool2", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    // No third argument — pre-existing callers must keep working.
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "echo_tool2",
        input: { msg: "hi" },
        tool_use_id: "toolu_abrt2",
      },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toContain("hi")
    rmSync(join(HOME, "plugins", "abrt2"), { recursive: true })
  })

  it("aborts immediately when externalSignal is already aborted on entry", async () => {
    writePackage(HOME, "abrt3", toolManifest("abrt3", "hang_tool3", "./h.ts"), {
      "h.ts": HANGING_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const ctrl = new AbortController()
    ctrl.abort() // pre-aborted
    const t0 = Date.now()
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "hang_tool3",
        input: {},
        tool_use_id: "toolu_abrt3",
      },
      process.cwd(),
      ctrl.signal,
    )
    const elapsed = Date.now() - t0
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toBe("aborted-via-ctx")
    expect(elapsed).toBeLessThan(150)
    rmSync(join(HOME, "plugins", "abrt3"), { recursive: true })
  })

  it("internal timeoutMs still works independent of externalSignal", async () => {
    writePackage(HOME, "abrt4", toolManifest("abrt4", "hang_tool4", "./h.ts"), {
      "h.ts": HANGING_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      timeoutMs: 80,
    })
    // No externalSignal — should still abort via the internal timeout.
    const t0 = Date.now()
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "hang_tool4",
        input: {},
        tool_use_id: "toolu_abrt4",
      },
      process.cwd(),
    )
    const elapsed = Date.now() - t0
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toBe("aborted-via-ctx")
    expect(elapsed).toBeGreaterThanOrEqual(60)
    expect(elapsed).toBeLessThan(400)
    rmSync(join(HOME, "plugins", "abrt4"), { recursive: true })
  })
})
