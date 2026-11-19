/**
 * End-to-end probe: can a real manifest plugin (`toolResultTransforms`) rewrite
 * a plugin tool's output before it becomes the `tool_result` block?
 *
 * Path: `PluginLoader.load`, then `loader.toolResultChain()`, then `executeToolRound`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import type { ToolViewEvent } from "../agent/tool-view-port.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { writeChainProbe } from "../plugins/loader.chain-probe.fixtures.ts"
import { PluginLoader } from "../plugins/loader.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

const ROOT = mkdtempSync(join(tmpdir(), "ma-chain-redact-"))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const SECRET = "sk-abcdefgh12345678"

const REDACT_SOURCE = (phase: string) => `
const RE = /\\bsk-[A-Za-z0-9_-]{8,}\\b/g
export default [
  {
    phase: ${JSON.stringify(phase)},
    order: 0,
    transform: (s) => ({ ...s, body: { ...s.body, text: s.body.text.replace(RE, "sk-[REDACTED]") } }),
  },
]
`

async function setup(id: string, phase: string, transformsSource: string = REDACT_SOURCE(phase)) {
  const plugins = join(ROOT, id)
  const dir = writeChainProbe(plugins, {
    id,
    // New entry name per plugin: Bun caches modules by path.
    entry: `t-${id}.ts`,
    transformsSource,
    sidebandKinds: [],
  })
  writeFileSync(
    join(dir, "h.ts"),
    `export default async () => ({ kind: "tool_result", content: "token=${SECRET} done" })\n`,
  )
  const loader = await PluginLoader.load({
    roots: { embedded: [plugins], project: [join(ROOT, "no-project")] },
    disabledPluginIds: new Set(),
    logger: () => {},
  })
  return loader
}

function ctx(loader: PluginLoader, over: Partial<ToolRoundContext> = {}): ToolRoundContext {
  return {
    loader,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    store: null,
    lifecycle: NOOP_LIFECYCLE,
    toolResultChain: loader.toolResultChain(),
    ...over,
  }
}

const tool = (name: string): ToolUseBlock => ({
  type: "tool_use",
  id: "tu_redact",
  name,
  input: {},
})

describe("toolResultTransforms redacts a plugin tool result (loader -> tool round)", () => {
  test("control: with no chain the secret reaches the content", async () => {
    const loader = await setup("redact-control", "post-blob")
    const out = await executeToolRound(tool("ProbeTool"), ctx(loader, { toolResultChain: [] }))
    expect(String(out.content)).toContain(SECRET)
  })

  for (const phase of ["pre-outcome", "post-blob"] as const) {
    test(`a ${phase} stage from a manifest plugin redacts the content`, async () => {
      const loader = await setup(`redact-${phase}`, phase)
      expect(loader.toolResultChain().map((e) => e.decl.phase)).toEqual([phase])
      const out = await executeToolRound(tool("ProbeTool"), ctx(loader))
      expect(String(out.content)).toBe("token=sk-[REDACTED] done")
      expect(String(out.content)).not.toContain(SECRET)
    })
  }

  test("a final stage cannot change body.text (D4 table): the secret stays", async () => {
    const loader = await setup("redact-final", "final")
    const out = await executeToolRound(tool("ProbeTool"), ctx(loader))
    expect(String(out.content)).toContain(SECRET)
  })

  test("a throwing stage fails open: the original text goes through", async () => {
    const loader = await setup(
      "redact-throw",
      "post-blob",
      `export default [{ phase: "post-blob", order: 0, transform: () => { throw new Error("boom") } }]\n`,
    )
    const out = await executeToolRound(tool("ProbeTool"), ctx(loader))
    expect(String(out.content)).toContain(SECRET)
  })

  for (const phase of ["pre-outcome", "post-blob"] as const) {
    test(`a ${phase} stage can attach body.data next to the redacted text`, async () => {
      const loader = await setup(
        `redact-data-${phase}`,
        phase,
        `export default [{
          phase: ${JSON.stringify(phase)}, order: 0,
          transform: (s) => ({ ...s, body: { text: s.body.text.replace(/sk-\\S+/, "sk-[REDACTED]"), data: { redacted: 1 } } }),
        }]\n`,
      )
      const events: ToolViewEvent[] = []
      const out = await executeToolRound(
        tool("ProbeTool"),
        ctx(loader, { toolView: { onToolEvent: (e) => void events.push(e) } }),
      )
      // The model text is the redacted text, never the data.
      expect(String(out.content)).toBe("token=sk-[REDACTED] done")
      // The persisted block outcome always carries the data.
      expect(out.outcome?.data).toEqual({ redacted: 1 })
      // The host view event is built BEFORE post-blob (tool-round.ts), so it
      // only sees data from pre-outcome and earlier.
      const done = events.find((e) => e.type === "outcome")
      const viewData = done?.type === "outcome" ? done.outcome.outcome?.data : "no outcome event"
      expect(viewData).toEqual(phase === "pre-outcome" ? { redacted: 1 } : undefined)
    })
  }
})
