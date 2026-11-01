/**
 * Plugin diagnostics after `bootHost` (S20, WP-09d).
 *
 * Web runs many sessions on one booted host. A plugin hook or event handler
 * that throws during the run of session A must report to the log of A
 * only. Outside a run, the error goes to `host.diagnostics`. The loader
 * event bus and hooks use the loader logger, so the boot must give the
 * loader a logger that routes through the diagnostics relay.
 *
 * @module host-public/host-boot-diagnostics.test
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { bootHost } from "@minimal-agent/core/host-kit/host-boot"

import { createLifecyclePort } from "../adapters/lifecycle-port-adapter.ts"
import type { StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import {
  TOOL_HANDLER_BODY,
  toolManifest,
  withHeadless,
  writePackage,
} from "../plugins/loader.fixtures.ts"
import { createRuntime } from "../runtime/runtime.ts"
import type { SessionEntry } from "../runtime/session.ts"

const root = mkdtempSync(join(tmpdir(), "host-boot-diag-"))
const savedHome = process.env.MINIMAL_AGENT_HOME

afterAll(() => {
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(root, { recursive: true, force: true })
})

/** A plugin with a tool, a `tool.willInvoke` hook that throws, and an event handler that throws. */
function writeThrowingPlugin(home: string): void {
  const manifest = withHeadless(toolManifest("hb-diag", "hb_diag_tool", "./tool.ts"), {
    hooks: [
      {
        id: "throw-hook",
        channel: "tool.willInvoke",
        handler: { type: "module", path: "./hook.ts", export: "default" },
      },
    ],
    events: [
      {
        id: "throw-event",
        on: "hbdiag.probe",
        handler: { type: "module", path: "./event.ts", export: "default" },
      },
    ],
  })
  writePackage(
    home,
    "hb-diag",
    { ...manifest, permissions: ["hooks:tool.willInvoke"] },
    {
      "tool.ts": TOOL_HANDLER_BODY,
      "hook.ts": `export default function hook() { throw new Error("hbdiag hook failed") }\n`,
      "event.ts": `export default function onEvent() { throw new Error("hbdiag event failed") }\n`,
    },
  )
}

const TEXT_REPLY: StreamedResponse = {
  blocks: [{ type: "text", text: "done" }],
  text: "done",
  stopReason: "end_turn",
} as StreamedResponse

describe("bootHost plugin diagnostics", () => {
  it("routes a plugin hook or event error during a run to that session's log only", async () => {
    const home = join(root, "home")
    mkdirSync(home, { recursive: true })
    writeThrowingPlugin(home)
    const host = await bootHost({ home, pluginRoots: { user: [join(home, "plugins")] } })
    expect(host.plugins.map((p) => p.id)).toContain("hb-diag")
    const bootCount = host.diagnostics.length

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let waiting = 0
    // Session A calls the plugin tool (the hook throws) and emits the event
    // (the handler throws). Session B only answers text. Both runs overlap.
    const sendFor = (callsTool: boolean): TransportFn => {
      let calls = 0
      return async function* () {
        calls++
        if (calls === 1) {
          waiting++
          if (waiting === 2) release()
          await gate
        }
        if (callsTool && calls === 1) {
          host.loader.bus().emit("hbdiag.probe", {})
          await new Promise((resolve) => setTimeout(resolve, 5))
          yield ""
          return {
            blocks: [{ type: "tool_use", id: "toolu_hbdiag", name: "hb_diag_tool", input: {} }],
            text: "",
            stopReason: "tool_use",
          } as StreamedResponse
        }
        yield "done"
        return TEXT_REPLY
      }
    }
    const runtime = createRuntime()
    const open = (id: string, callsTool: boolean) =>
      runtime.openSession({
        id,
        model: "test-model",
        auth: { type: "api-key", token: "test-token" },
        sendFn: sendFor(callsTool),
        toolRegistry: host.toolRegistry,
        toolExecutor: host.toolExecutorFor("test-model"),
        lifecycle: createLifecyclePort(host.loader.hooks()),
      })
    const a = open("sid-hbdiag-a", true)
    const b = open("sid-hbdiag-b", false)
    const collect = async (run: AsyncIterable<SessionEntry>): Promise<string[]> => {
      const out: string[] = []
      for await (const entry of run) {
        const text = JSON.stringify(entry)
        if (entry.ch === "diag" && text.includes("hbdiag")) out.push(text)
      }
      return out
    }
    try {
      const [diagsA, diagsB] = await Promise.all([collect(a.run("go")), collect(b.run("go"))])
      expect(diagsA.some((d) => d.includes("hbdiag hook failed"))).toBe(true)
      expect(diagsA.some((d) => d.includes("hbdiag event failed"))).toBe(true)
      for (const d of diagsA) expect(d).toContain('"sessionId":"sid-hbdiag-a"')
      expect(diagsB).toEqual([])
      // The run errors are in the log of A, not in the host list.
      const hostText = JSON.stringify(host.diagnostics.slice(bootCount))
      expect(hostText).not.toContain("hbdiag")

      // Outside a run, the same error goes to host.diagnostics.
      host.loader.bus().emit("hbdiag.probe", {})
      await new Promise((resolve) => setTimeout(resolve, 20))
      const later = host.diagnostics.slice(bootCount)
      expect(
        later.some((d) => d.kind === "plugin-warning" && d.message.includes("hbdiag event failed")),
      ).toBe(true)
    } finally {
      runtime.close()
    }
  })
})
