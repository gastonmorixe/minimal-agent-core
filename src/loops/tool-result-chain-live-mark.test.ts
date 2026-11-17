/**
 * T5 (spec v6.1, M0): the live history keeps the sideband mark. The
 * `chain-probe` fixture plugin is loaded through `PluginLoader.load`. Its
 * stamp stage sets the registered kind `probe-mark`. After one tool round,
 * the `tool_result` block in `core.history()` has `sideband: {kind}`. The
 * canonical message keeps the mark too. The proof that the encoders drop it
 * is the tool_result case in `plugin-api/src/llm/sideband-block.test.ts`:
 * the provider ratchet (`architecture.provider-decoupling.test.ts`) does not
 * let a `src/` file call a provider encoder.
 */

import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { messageToCanonical } from "../llm/codec/message-codec.ts"
import type { Message, ToolResultBlock } from "../llm/messages.ts"
import type { SendOptions, StreamedResponse } from "../llm/transport/types.ts"
import {
  CHAIN_PROBE_CONTENT,
  CHAIN_PROBE_KIND,
  CHAIN_PROBE_PHASES,
  CHAIN_PROBE_PLUGINS_DIR,
  CHAIN_PROBE_TOOL,
  chainProbeLog,
  resetChainProbeLog,
  writeChainProbe,
} from "../plugins/loader.chain-probe.fixtures.ts"
import { PluginLoader } from "../plugins/loader.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const ROOT = resolve(__dirname, "../../tmp/tool-result-chain-live-mark-tests")
const NO_PROJECT = join(ROOT, "nope-project")

/** Round 1 calls ProbeTool. Round 2 ends the turn. Captures each request. */
function scriptedSend(captured: Message[][]) {
  let round = 0
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    captured.push(structuredClone(opts.messages))
    round++
    if (round === 1) {
      return {
        blocks: [{ type: "tool_use" as const, id: "call-1", name: CHAIN_PROBE_TOOL, input: {} }],
        text: "",
        stopReason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 3 },
      }
    }
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 4 },
    }
  }
}

async function runProbe(pluginsDir: string) {
  const loader = await PluginLoader.load({
    roots: { embedded: [pluginsDir], project: [NO_PROJECT] },
    disabledPluginIds: new Set(),
    logger: () => {},
  })
  const captured: Message[][] = []
  const core = await buildTestCore({ auth: AUTH, sendFn: scriptedSend(captured), loader })
  const gen = core.run("go")
  while (!(await gen.next()).done) {}
  return { core, captured }
}

function toolResultOf(history: readonly Message[]): ToolResultBlock | undefined {
  for (const m of history) {
    if (typeof m.content === "string") continue
    for (const b of m.content) if (b.type === "tool_result") return b
  }
  return undefined
}

describe("T5: live history keeps the sideband mark (spec v6.1 D1 item 5)", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
  })
  beforeEach(() => resetChainProbeLog())
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("the stamp stage marks the live tool_result", async () => {
    const { core, captured } = await runProbe(CHAIN_PROBE_PLUGINS_DIR)
    const block = toolResultOf(core.history())
    expect(block?.sideband).toEqual({ kind: CHAIN_PROBE_KIND })
    expect(block?.content).toBe(CHAIN_PROBE_CONTENT)
    expect(chainProbeLog()).toEqual([...CHAIN_PROBE_PHASES])

    // The second request carries the same tool_result content.
    expect(captured).toHaveLength(2)
    const sent = toolResultOf(captured[1] ?? [])
    expect(sent?.content).toBe(CHAIN_PROBE_CONTENT)

    // The canonical form (the encoder input) keeps the mark as metadata.
    const canonical = core.history().map(messageToCanonical)
    const canonicalResult = canonical
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result")
    expect(canonicalResult?.type === "tool_result" ? canonicalResult.sideband : undefined).toEqual({
      kind: CHAIN_PROBE_KIND,
    })
  })

  it("a stamp kind that is not registered gives no sideband key", async () => {
    const dir = join(ROOT, "unregistered")
    writeChainProbe(dir, {
      id: "chain-probe-unreg",
      entry: "./transforms-unreg.ts",
      stampKind: "not-registered",
    })
    const { core } = await runProbe(dir)
    const block = toolResultOf(core.history())
    expect(block?.content).toBe(CHAIN_PROBE_CONTENT)
    expect(block !== undefined && "sideband" in block).toBe(false)
    expect(chainProbeLog()).toEqual(CHAIN_PROBE_PHASES.map((p) => `chain-probe-unreg:${p}`))
  })
})
