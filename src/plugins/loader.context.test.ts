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
      roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
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
      roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
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
      roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
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
      roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
      coreToolNames: CORE_TOOLS,
      agent: TEST_AGENT,
    })
    expect(loader.agentContext()).toEqual(TEST_AGENT)
    rmSync(join(HOME_AC, "plugins", "p4"), { recursive: true })
  })
})

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
      roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
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
      roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
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
      roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
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
      roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
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
