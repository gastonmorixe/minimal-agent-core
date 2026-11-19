/**
 * C5: event handler contexts get `ctx.host` (opt-in per sub, module handlers
 * only, capability-scoped) and `ctx.run` (run-mode fact; sub-agent wins).
 * Handlers stay not awaited: a throwing or slow handler does not block the
 * bus.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type {
  EventHandlerContext,
  ResolvedEventSub,
  RunModeFact,
} from "@minimal-agent/core/plugin-api/types/plugin"

import { splitFlatManifest } from "../../test-utils/split-manifest.ts"
import { EventBus } from "../event-bus.ts"
import { Hooks } from "../hooks/hooks.ts"
import type { PluginHost } from "../host/capabilities.ts"
import { PluginLoader } from "../loader.ts"

import { registerEventSub, resolveRunModeFact } from "./event-subs.ts"

type SubOpts = { host?: boolean; on?: string; subprocess?: boolean }

function sub(invoke: ResolvedEventSub["invoke"], o: SubOpts = {}): ResolvedEventSub {
  const handler = o.subprocess
    ? { type: "subprocess" as const, command: ["./h.sh"] }
    : { type: "module" as const, path: "./h.ts" }
  const definition = {
    id: "h",
    on: o.on ?? "prompt.submitted",
    handler,
    ...(o.host !== undefined ? { host: o.host } : {}),
  } as ResolvedEventSub["definition"]
  return { definition, entryAbsolute: "/pkg/h.ts", invoke }
}

async function flush(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

const FAKE_HOST = Object.freeze({ clock: { now: () => 1, iso: () => "x" } }) as PluginHost
const REPL: RunModeFact = { mode: "repl", interactive: true }
const NO_SUBAGENT_ENV: NodeJS.ProcessEnv = {}

function setup(o: SubOpts, hostOpts: Parameters<typeof registerEventSub>[10] = {}) {
  const bus = new EventBus(() => {})
  const hooks = new Hooks({ logger: () => {} })
  const seen: EventHandlerContext[] = []
  const logs: string[] = []
  registerEventSub(
    bus,
    hooks,
    "/pkg",
    sub(async (ctx) => {
      seen.push(ctx)
    }, o),
    (m) => logs.push(m),
    "p",
    undefined,
    undefined,
    undefined,
    undefined,
    { env: NO_SUBAGENT_ENV, ...hostOpts },
  )
  return { bus, seen, logs }
}

describe("registerEventSub / ctx.host opt-in", () => {
  test("no host:true gives no ctx.host", async () => {
    let calls = 0
    const { bus, seen } = setup({}, { hostFor: () => (calls++, FAKE_HOST) })
    bus.emit("prompt.submitted", {})
    await flush()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.host).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("host:false gives no ctx.host", async () => {
    const { bus, seen } = setup({ host: false }, { hostFor: () => FAKE_HOST })
    bus.emit("prompt.submitted", {})
    await flush()
    expect(seen[0]?.host).toBeUndefined()
  })

  test("host:true on a module handler gives the plugin host", async () => {
    const { bus, seen, logs } = setup({ host: true }, { hostFor: () => FAKE_HOST })
    bus.emit("prompt.submitted", {})
    await flush()
    expect(seen[0]?.host).toBe(FAKE_HOST)
    expect(logs).toEqual([])
  })

  test("host:true with no capabilities (hostFor gives undefined) gives no host", async () => {
    const { bus, seen } = setup({ host: true }, { hostFor: () => undefined })
    bus.emit("prompt.submitted", {})
    await flush()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.host).toBeUndefined()
  })

  test("host:true on a subprocess handler gives no host and logs", async () => {
    const { bus, seen, logs } = setup(
      { host: true, subprocess: true },
      { hostFor: () => FAKE_HOST },
    )
    bus.emit("prompt.submitted", {})
    await flush()
    expect(seen[0]?.host).toBeUndefined()
    expect(logs.join("\n")).toContain("subprocess")
  })

  test("host:true on a high-frequency channel logs a warning", () => {
    for (const on of ["editor.key", "editor.buffer.changed", "message.tokens"]) {
      const { logs } = setup({ host: true, on }, { hostFor: () => FAKE_HOST })
      expect(logs.join("\n")).toContain("high-frequency")
    }
    const quiet = setup({ host: true }, { hostFor: () => FAKE_HOST })
    expect(quiet.logs).toEqual([])
  })
})

describe("registerEventSub / ctx.run", () => {
  test("ctx.run is the getter value, read at event time", async () => {
    let fact: RunModeFact = REPL
    const { bus, seen } = setup({}, { runMode: () => fact })
    bus.emit("prompt.submitted", {})
    await flush()
    fact = { mode: "one-shot", interactive: false }
    bus.emit("prompt.submitted", {})
    await flush()
    expect(seen[0]?.run).toEqual(REPL)
    expect(seen[1]?.run?.mode).toBe("one-shot")
  })

  test("no getter and no sub-agent env gives no ctx.run", async () => {
    const { bus, seen } = setup({})
    bus.emit("prompt.submitted", {})
    await flush()
    expect(seen[0]?.run).toBeUndefined()
  })

  test("a sub-agent env wins over the host fact", async () => {
    const env = { MINIMAL_AGENT_SUBAGENT_ID: "A3", MINIMAL_AGENT_SUBAGENT_ROLE: "worker" }
    const { bus, seen } = setup({}, { runMode: () => REPL, env })
    bus.emit("prompt.submitted", {})
    await flush()
    expect(seen[0]?.run?.mode).toBe("subagent")
    expect(seen[0]?.run?.interactive).toBe(false)
    expect(seen[0]?.run?.subagent).toEqual({ id: "A3", role: "worker" })
  })
})

describe("resolveRunModeFact", () => {
  test("SID env alone also gives subagent", () => {
    const r = resolveRunModeFact(() => ({ mode: "stream-json", interactive: false }), {
      MINIMAL_AGENT_SUBAGENT_SID: "s-1",
      MINIMAL_AGENT_SUBAGENT_LEAD: "lead-1",
    })
    expect(r).toEqual({
      mode: "subagent",
      interactive: false,
      subagent: { id: "s-1", leadSid: "lead-1" },
    })
  })

  test("sub-agent env with no getter still gives subagent", () => {
    expect(resolveRunModeFact(undefined, { MINIMAL_AGENT_SUBAGENT_ID: "A1" })?.mode).toBe(
      "subagent",
    )
  })

  test("keeps the other host fields (dryRun, providerId)", () => {
    const r = resolveRunModeFact(
      () => ({ mode: "repl", interactive: true, dryRun: true, providerId: "p" }),
      { MINIMAL_AGENT_SUBAGENT_ID: "A1" },
    )
    expect(r?.dryRun).toBe(true)
    expect(r?.providerId).toBe("p")
  })

  test("a throwing getter gives undefined, not a throw", () => {
    const boom = (): RunModeFact => {
      throw new Error("x")
    }
    expect(resolveRunModeFact(boom, {})).toBeUndefined()
  })

  test("blank env values do not count", () => {
    expect(resolveRunModeFact(() => REPL, { MINIMAL_AGENT_SUBAGENT_ID: "  " })).toEqual(REPL)
  })
})

describe("registerEventSub / handlers are not awaited", () => {
  test("a throwing or slow handler does not block the bus", async () => {
    const bus = new EventBus(() => {})
    const hooks = new Hooks({ logger: () => {} })
    const logs: string[] = []
    const args = [undefined, undefined, undefined, undefined, { env: NO_SUBAGENT_ENV }] as const
    // A handler that never settles.
    registerEventSub(
      bus,
      hooks,
      "/pkg",
      sub(() => new Promise<void>(() => {})),
      () => {},
      "slow",
      ...args,
    )
    // A handler that throws synchronously.
    const thrower = sub((): never => {
      throw new Error("sync boom")
    })
    registerEventSub(bus, hooks, "/pkg", thrower, (m) => logs.push(m), "throw", ...args)
    // A handler that rejects.
    const rejecter = sub(() => Promise.reject(new Error("async boom")))
    registerEventSub(bus, hooks, "/pkg", rejecter, () => {}, "reject", ...args)
    let fast = 0
    registerEventSub(
      bus,
      hooks,
      "/pkg",
      sub(async () => void fast++),
      () => {},
      "fast",
      ...args,
    )

    const t0 = performance.now()
    bus.emit("prompt.submitted", {})
    bus.emit("prompt.submitted", {})
    expect(performance.now() - t0).toBeLessThan(50)
    await flush(10)
    expect(fast).toBe(2)
    expect(logs.join("\n")).toContain("sync boom")
  })
})

describe("PluginLoader / event ctx.host end to end", () => {
  let root = ""
  let prevHome: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "c5-event-host-"))
    prevHome = process.env.MINIMAL_AGENT_HOME
    process.env.MINIMAL_AGENT_HOME = join(root, ".minimal-agent")
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  })

  function writePlugin(id: string, capabilities: string[], host?: boolean): void {
    const dir = join(root, "plugins", id)
    mkdirSync(dir, { recursive: true })
    const manifest = {
      id,
      name: id,
      version: "0.1.0",
      description: "test",
      ...(capabilities.length > 0 ? { capabilities } : {}),
      events: [
        {
          id: "seen",
          on: `c5.${id}`,
          handler: { type: "module", path: "./h.ts" },
          ...(host !== undefined ? { host } : {}),
        },
      ],
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(splitFlatManifest(manifest), null, 2))
    writeFileSync(
      join(dir, "h.ts"),
      `export default function (ctx) {
        const g = globalThis
        g.__c5 = g.__c5 ?? {}
        g.__c5[${JSON.stringify(id)}] = { host: ctx.host, run: ctx.run }
      }\n`,
    )
  }

  type Seen = Record<string, { host?: Record<string, unknown>; run?: RunModeFact }>
  const seen = (): Seen => ((globalThis as { __c5?: Seen }).__c5 ??= {})

  test("opt-in gives a host with only the declared capabilities; no opt-in gives none", async () => {
    writePlugin("c5-in", ["clock"], true)
    writePlugin("c5-out", ["clock"])
    writePlugin("c5-nocap", [], true)
    const bus = new EventBus(() => {})
    const loader = await PluginLoader.load({
      userDir: root,
      logger: () => {},
      bus,
      runMode: () => ({ mode: "repl", interactive: true }),
    })
    try {
      for (const id of ["c5-in", "c5-out", "c5-nocap"]) bus.emit(`c5.${id}`, {})
      await flush(20)
      const s = seen()
      const host = s["c5-in"]?.host
      expect(host).toBeDefined()
      expect(host).toBe(loader.capabilityHostFor("c5-in") as unknown as Record<string, unknown>)
      expect(typeof (host?.clock as { now?: unknown })?.now).toBe("function")
      expect(host?.llm).toBeUndefined()
      expect(host?.sessionMeta).toBeUndefined()
      expect(host?.sessions).toBeUndefined()
      expect(s["c5-out"]?.host).toBeUndefined()
      expect(s["c5-nocap"]?.host).toBeUndefined()
      // Run fact is present for each handler (env may carry a sub-agent id).
      for (const id of ["c5-in", "c5-out"]) expect(s[id]?.run?.mode).toBeDefined()
    } finally {
      bus.dispose()
      delete (globalThis as { __c5?: Seen }).__c5
    }
  })
})
