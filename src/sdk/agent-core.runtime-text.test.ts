/**
 * End to end: a stub synthetic text provider on the core reaches the mode
 * refusal, the reflection checkpoint and the media rejection texts
 * (core-prompts decouple P1.5). The ModeManager gets the core's one
 * resolver from `buildAgentCore`, and the media resolver gets it per call.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import type {
  SyntheticKind,
  SyntheticTextProvider,
} from "../../plugin-api/src/types/synthetic-text.ts"
import { createSyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../client/types.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  registerModel,
  registerProvider,
} from "../llm/model-registry.ts"
import type { ProviderAdapter } from "../llm/provider.ts"
import type { TransportFn } from "../llm/transport/types.ts"
import { mediaPasteInterceptor } from "../media/paste-intercept.ts"
import { createMediaRegistry } from "../media/registry.ts"
import { getSessionMediaRegistry, resetSessionMediaRegistry } from "../media/session-registry.ts"
import { formatMediaToken } from "../media/token.ts"
import { ModeManager } from "../modes/modes.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

const auth: AuthResult = { type: "api-key", token: "test-token" }

/** One tool_use round for `tool`, then a plain end_turn. */
function toolThenDone(tool: string, input: Record<string, unknown>): TransportFn {
  let round = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [{ type: "tool_use" as const, id: "t1", name: tool, input }],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

const done: TransportFn = async function* () {
  return {
    blocks: [{ type: "text" as const, text: "done" }],
    text: "done",
    stopReason: "end_turn",
  } as StreamedResponse
}

/** A stub provider for one kind that records the facts it got. */
function stub(kind: SyntheticKind): {
  provider: SyntheticTextProvider
  facts: Array<Readonly<Record<string, unknown>>>
} {
  const facts: Array<Readonly<Record<string, unknown>>> = []
  return {
    provider: {
      kinds: [kind],
      text: (_k, f) => {
        facts.push(f)
        return `STUB ${kind} ${JSON.stringify(f)}`
      },
    },
    facts,
  }
}

/** Every text and tool_result string the core sent in user messages. */
function userTexts(messages: unknown[]): string[] {
  const out: string[] = []
  for (const m of messages as Array<{ role: string; content: unknown }>) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b.type === "text") out.push(String(b.text))
      if (b.type === "tool_result") out.push(String(b.content))
    }
  }
  return out
}

afterEach(() => resetSessionMediaRegistry())

describe("AgentCore runtime texts from a stub provider", () => {
  it("mode refusal: the ModeManager uses the core's resolver", async () => {
    const s = stub("mode.refusal")
    const modeManager = new ModeManager(
      [{ id: "ask", label: "ASK", disallowedTools: ["Edit"], refusalHint: "Show a diff." }],
      "ask",
    )
    const core = await buildTestCore({
      auth,
      sendFn: toolThenDone("Edit", { file_path: "/x", old_string: "a", new_string: "b" }),
      modeManager,
      syntheticTextProviders: [s.provider],
    })
    const gen = core.run("go")
    while (!(await gen.next()).done) {}
    const hit = userTexts(core.messages).find((t) => t.startsWith("STUB mode.refusal"))
    expect(hit).toBeDefined()
    expect(s.facts).toEqual([{ tool: "Edit", modeId: "ask", label: "ASK", hint: "Show a diff." }])
  })

  it("mode refusal: a resolver passed to the constructor wins", async () => {
    const s = stub("mode.refusal")
    const own = createSyntheticTextResolver([s.provider], createDiagnostics({ emit: () => {} }))
    const mgr = new ModeManager(
      [{ id: "plan", label: "PLAN", disallowedTools: ["Write"] }],
      "plan",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      own,
    )
    mgr.bindSyntheticText(createSyntheticTextResolver([], createDiagnostics({ emit: () => {} })))
    const r = mgr.isToolAllowed("Write", {})
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.message.startsWith("STUB mode.refusal")).toBe(true)
  })

  it("reflection checkpoint: the attachment comes from the provider", async () => {
    const s = stub("runtime.reflection_checkpoint")
    const core = await buildTestCore({
      auth,
      sendFn: toolThenDone("Glob", { pattern: "zz-no-such-*" }),
      reflectionInterval: 1,
      reflectionCooldownMs: 0,
      syntheticTextProviders: [s.provider],
    })
    const gen = core.run("go")
    while (!(await gen.next()).done) {}
    const hit = userTexts(core.messages).find((t) =>
      t.startsWith("STUB runtime.reflection_checkpoint"),
    )
    expect(hit).toBeDefined()
    expect(s.facts).toEqual([{ round: 1, cooldownSec: 0 }])
  })

  it("media rejection: the user turn marker comes from the provider", async () => {
    const s = stub("user_media.rejected")
    // Unknown bytes sniff as application/octet-stream: not an accepted type.
    const item = await getSessionMediaRegistry().registerBytes(
      new Uint8Array([1, 2, 3, 4]),
      "clipboard",
    )
    const core = await buildTestCore({
      auth,
      sendFn: done,
      syntheticTextProviders: [s.provider],
    })
    const gen = core.run(`look ${formatMediaToken(item)}`)
    while (!(await gen.next()).done) {}
    const text = userTexts(core.messages).join("\n")
    expect(text).toContain('STUB user_media.rejected {"reason":"unsupported-type"')
    expect(text).toContain('"site":"marker"')
    const sites = s.facts.map((f) => f.site)
    expect(sites).toEqual(["check", "marker"])
    expect(s.facts[1]).toMatchObject({ reason: "unsupported-type", kind: "document" })
  })
})

describe("paste diagnostic uses the resolved rejection text", () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
    clearModelRegistry()
    clearProviderRegistry()
  })

  /** Paste gates the type only with a resolved model (no model: size floor only). */
  function registerPasteModel(id: string): void {
    registerModel({
      id,
      providerId: "paste-prov",
      surfaceId: "paste-surface",
      displayName: id,
      capabilities: {
        ...defaultCapabilities(),
        modalities: { image: true, audio: false, pdf: true, video: false },
      },
      pricing: {
        inputUSD: 0,
        outputUSD: 0,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
    })
    registerProvider({
      id: "paste-prov",
      displayName: "Paste",
      surfaces: ["paste-surface"],
      validate: () => ({ ok: true, errors: [] }),
      run: async function* () {},
    } as unknown as ProviderAdapter)
  }

  it("warns with the provider text (site check)", () => {
    dir = mkdtempSync(join(tmpdir(), "ma-paste-"))
    const path = join(dir, "x.pdf")
    writeFileSync(path, new Uint8Array([1, 2, 3, 4]))
    const s = stub("user_media.rejected")
    const text = createSyntheticTextResolver([s.provider], createDiagnostics({ emit: () => {} }))
    const warnings: string[] = []
    const diagnostics = createDiagnostics({
      emit: (e) => {
        if (e.source === "media.rejected") warnings.push(e.message)
      },
    })
    registerPasteModel("paste-model")
    const out = mediaPasteInterceptor(path, createMediaRegistry(), diagnostics, text, "paste-model")
    expect(out).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.startsWith("STUB user_media.rejected")).toBe(true)
    expect(s.facts[0]).toMatchObject({ site: "check", reason: "unsupported-type" })
  })
})
