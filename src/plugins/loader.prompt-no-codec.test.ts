/**
 * Plugins change the system prompt with AND without a sideband codec.
 *
 * Owner rule: the plugin content of the system prompt is never dropped. With
 * no codec (or no declaration of a role kind) core sends the body text with
 * no wrapper; with the fixture codec the bytes do not change. Each test runs
 * one plugin path end to end (real `PluginLoader.load`, real `buildAgentCore`,
 * a recording transport) in both modes and reads the final request:
 *
 * - `PROMPT.md` role sections (`tool`, `context`) and `sessionContext`
 *   prompt fragments (the plugin block, order and separators);
 * - `afterInstructions` prompt fragments (plain block, no tag);
 * - the `systemPromptBase` provider (identity and instruction parts);
 * - the LLM provider preamble (`ProviderPlugin.resolveSystemPrompt`);
 * - the `message.willSend` hook: read and rewrite of the system prompt.
 *
 * @module plugins/loader.prompt-no-codec.test
 */

import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import { clearProviderPlugins, registerProviderPlugin } from "../llm/provider-plugin.ts"
import type { SendOptions, StreamedResponse } from "../llm/transport/types.ts"
import { buildAgentCore } from "../loops/assemble.ts"
import { sidebandFixturePresent, withSidebandCodec } from "../test-utils/sideband-fixture.ts"

import {
  CORE_TOOLS,
  TOOL_HANDLER_BODY,
  toolManifest,
  withHeadless,
  writePackage,
} from "./loader.fixtures.ts"
import { PluginLoader, type PluginLoaderOptions } from "./loader.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-prompt-no-codec")
const HOME = join(ROOT, "home")
const NO_PROJECT = join(ROOT, "nope-project")
const KEY = "__promptNoCodec"
const AUTH: AuthResult = { type: "api-key", token: "t" }
const MODEL = "prompt-no-codec-model"
const PROVIDER = "prompt-no-codec-prov"

const TOOL_BODY = "TOOL_SECTION_BODY uses the tool."
const BEH_BODY = "BEHAVIOR_SECTION_BODY rule."
const FRAG_SESSION = "FRAG_SESSION_CONTEXT_TEXT"
const FRAG_AFTER = "FRAG_AFTER_INSTRUCTIONS_TEXT"
const BASE_IDENTITY = "BASE_IDENTITY_TEXT"
const BASE_INSTRUCTIONS = "BASE_INSTRUCTIONS_TEXT"
const PREAMBLE = "PROVIDER_PREAMBLE_TEXT"
const REWRITE = "HOOK_REWRITE_TEXT"

/** The plugins: one for each system-prompt path. */
function writePlugins(): void {
  writePackage(HOME, "pa-tool", toolManifest("pa-tool", "PaTool", "./h.ts"), {
    "h.ts": TOOL_HANDLER_BODY,
    "PROMPT.md": TOOL_BODY,
  })
  writePackage(
    HOME,
    "pa-beh",
    {
      ...withHeadless(
        {
          id: "pa-beh",
          name: "Pa Beh",
          version: "0.1.0",
          description: "d",
          headless: { tools: [] },
        },
        {
          promptFragments: [
            { id: "s", handler: { type: "module", path: "./s.ts", export: "default" } },
            {
              id: "a",
              handler: { type: "module", path: "./a.ts", export: "default" },
              placement: "afterInstructions",
            },
          ],
          hooks: [
            {
              id: "send",
              channel: "message.willSend",
              handler: { type: "module", path: "./send.ts", export: "default" },
            },
          ],
        },
      ),
      permissions: ["hooks:message.willSend"],
    },
    {
      "PROMPT.md": `# Pa Rules\n\n${BEH_BODY}`,
      "s.ts": `export default () => ${JSON.stringify(FRAG_SESSION)}`,
      "a.ts": `export default () => ${JSON.stringify(FRAG_AFTER)}`,
      // Read the system prompt, then rewrite it: add one block at the end.
      "send.ts": `export default function handler(payload) {
  const sys = payload.system
  const blocks = typeof sys === "string" ? [{ type: "text", text: sys }] : sys
  ;(globalThis.${KEY} ??= []).push(blocks.map((b) => b.text).join("\\n"))
  return { payload: { ...payload, system: [...blocks, { type: "text", text: ${JSON.stringify(REWRITE)} }] } }
}`,
    },
  )
  writePackage(
    HOME,
    "pa-base",
    {
      id: "pa-base",
      name: "pa-base",
      version: "0.1.0",
      description: "d",
      systemPromptBase: { id: "spb", entry: "./spb.ts" },
    },
    {
      "spb.ts": `export default () => ({
  identity: () => ${JSON.stringify(BASE_IDENTITY)},
  instructionParts: () => [{ slot: "instructions", text: ${JSON.stringify(BASE_INSTRUCTIONS)} }],
})`,
    },
  )
}

/** The two modes: no codec (`NO_SIDEBAND`) and the fixture codec. */
const MODES: {
  name: string
  codec: boolean
  opts: (o: PluginLoaderOptions) => PluginLoaderOptions
}[] = [
  { name: "no codec (NO_SIDEBAND)", codec: false, opts: (o) => o },
  { name: "fixture codec", codec: true, opts: withSidebandCodec },
]

/** Load, run one turn, and give the system text of the request and the hook reads. */
async function runOnce(
  mode: (typeof MODES)[number],
): Promise<{ loader: PluginLoader; system: string; hookSaw: string[]; block: string | null }> {
  ;(globalThis as Record<string, unknown>)[KEY] = []
  const loader = await PluginLoader.load(
    mode.opts({
      userDir: HOME,
      roots: { project: [NO_PROJECT] },
      coreToolNames: CORE_TOOLS,
      logger: () => {},
    }),
  )
  const sent: SendOptions[] = []
  try {
    const core = await buildAgentCore({
      auth: AUTH,
      model: MODEL,
      sendFn: async function* (opts: SendOptions) {
        sent.push(opts)
        yield "ok"
        return {
          blocks: [{ type: "text", text: "ok" }],
          text: "ok",
          stopReason: "end_turn",
        } as StreamedResponse
      },
      loader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    const gen = core.run("go")
    for (;;) if ((await gen.next()).done) break
  } finally {
    loader.releaseSystemPromptBase()
  }
  const sys = sent[0]?.system
  const system = typeof sys === "string" ? sys : (sys ?? []).map((b) => b.text).join("\n---\n")
  const hookSaw = (globalThis as Record<string, unknown>)[KEY] as string[]
  return { loader, system, hookSaw, block: await loader.getPromptBlockAsync() }
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  writePlugins()
})
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>)[KEY]
})

for (const mode of MODES) {
  describe.skipIf(mode.codec && !sidebandFixturePresent())(
    `plugin system-prompt paths, ${mode.name}`,
    () => {
      beforeAll(() => {
        registerModel({
          id: MODEL,
          providerId: PROVIDER,
          surfaceId: "custom",
          displayName: MODEL,
          capabilities: defaultCapabilities(),
          pricing: {
            inputUSD: 0,
            outputUSD: 0,
            cacheWriteUSD: 0,
            cacheReadUSD: 0,
            webSearchPerCallUSD: 0,
          },
        })
        // The LLM provider preamble path: the provider adds its preamble
        // before the body that core gives it.
        registerProviderPlugin({
          id: PROVIDER,
          displayName: "P",
          shortCode: "pn",
          register() {},
          resolveSystemPrompt: (ctx) => [
            { type: "text", text: PREAMBLE },
            { type: "text", text: ctx.identity },
            ...ctx.body,
          ],
        })
      })
      afterAll(() => {
        clearProviderPlugins()
        clearModelRegistry()
      })

      it("PROMPT.md role sections and sessionContext fragments: the plugin block keeps the text", async () => {
        const { loader, block } = await runOnce(mode)
        expect(loader.sideband().ready).toBe(mode.codec)
        expect(block).not.toBeNull()
        const text = block ?? ""
        // Role order (tool before context) and the body of each section:
        // PROMPT.md, then its sessionContext fragment in the same section.
        expect(text.indexOf(TOOL_BODY)).toBeGreaterThanOrEqual(0)
        expect(text.indexOf(BEH_BODY)).toBeGreaterThan(text.indexOf(TOOL_BODY))
        expect(text.indexOf(FRAG_SESSION)).toBeGreaterThan(text.indexOf(BEH_BODY))
        if (mode.codec) {
          expect(text).toContain('name="pa-rules"')
        } else {
          // The body with no wrapper, same separator as with a codec.
          expect(text).toBe(`${TOOL_BODY}\n\n${BEH_BODY}\n\n${FRAG_SESSION}`)
        }
      })

      it("the final request system prompt has each plugin part, in order", async () => {
        const { system } = await runOnce(mode)
        const at = (s: string): number => system.indexOf(s)
        for (const s of [
          PREAMBLE,
          BASE_IDENTITY,
          BASE_INSTRUCTIONS,
          FRAG_AFTER,
          BEH_BODY,
          FRAG_SESSION,
          TOOL_BODY,
          REWRITE,
        ]) {
          expect(at(s)).toBeGreaterThanOrEqual(0)
        }
        // Provider preamble first, base identity, instructions, then the
        // afterInstructions block, then the plugin block, then the rewrite.
        expect(at(PREAMBLE)).toBeLessThan(at(BASE_IDENTITY))
        expect(at(BASE_IDENTITY)).toBeLessThan(at(BASE_INSTRUCTIONS))
        expect(at(BASE_INSTRUCTIONS)).toBeLessThan(at(FRAG_AFTER))
        expect(at(FRAG_AFTER)).toBeLessThan(at(TOOL_BODY))
        expect(at(TOOL_BODY)).toBeLessThan(at(BEH_BODY))
        expect(at(FRAG_SESSION)).toBeLessThan(at(REWRITE))
      })

      it("message.willSend reads the full system prompt and its rewrite reaches the request", async () => {
        const { system, hookSaw } = await runOnce(mode)
        expect(hookSaw).toHaveLength(1)
        for (const s of [
          PREAMBLE,
          BASE_IDENTITY,
          BASE_INSTRUCTIONS,
          FRAG_AFTER,
          BEH_BODY,
          TOOL_BODY,
        ]) {
          expect(hookSaw[0]).toContain(s)
        }
        expect(hookSaw[0]).not.toContain(REWRITE)
        expect(system.endsWith(REWRITE)).toBe(true)
      })
    },
  )
}
