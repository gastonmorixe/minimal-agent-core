/**
 * Subprocess tool attachments, end to end: a real `PluginLoader` loads a
 * plugin whose tool handler is an `sh` script with `output: "json"`. The
 * script prints a `tool_result` with a tiny PNG as base64. The tool round
 * then sends `[text, image]` to a vision model, and the PNG is saved in the
 * session blob dir. Bad wire entries are dropped with a warning, and the
 * tool call does not fail. A module handler can send the same wire form.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import type { ContentBlock, ToolUseBlock } from "../llm/messages.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import { MAX_ATTACHMENT_BASE64_CHARS } from "../plugins/loader/attachment-wire.ts"
import { PluginLoader } from "../plugins/loader.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { BlobStore } from "../session/blob-store.ts"
import { fixtureSidebandOrNone } from "../test-utils/sideband-fixture.ts"
import { splitFlatManifest } from "../test-utils/split-manifest.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

const ROOT = join(import.meta.dirname, "..", "..", "tmp", `tool-round-subproc-${process.pid}`)
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
afterEach(() => clearModelRegistry())

/** A 10x10 PNG header: enough for the magic bytes and the size probe. */
function png(): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = 10
  b[23] = 10
  return b
}
const PNG_B64 = Buffer.from(png()).toString("base64")

function registerVisionModel(): void {
  registerModel({
    id: "vision-model",
    providerId: "testprov",
    surfaceId: "test-surface",
    displayName: "vision-model",
    capabilities: {
      ...defaultCapabilities(),
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
      modalities: { image: true, audio: false, pdf: false, video: false },
    },
    pricing: {
      inputUSD: 1,
      outputUSD: 1,
      cacheWriteUSD: 1,
      cacheReadUSD: 1,
      webSearchPerCallUSD: 0,
    },
  })
}

/** Write a plugin with one `Shot` tool and the given handler entry and files. */
function writePlugin(dir: string, handler: unknown, files: Record<string, string>): void {
  const pkg = join(dir, "plugins", "shot")
  mkdirSync(pkg, { recursive: true })
  const manifest = {
    id: "shot",
    name: "shot",
    version: "0.1.0",
    description: "test",
    tuis: [
      {
        id: "only",
        trigger: {
          type: "tool",
          tool: {
            name: "Shot",
            description: "Take a shot",
            input_schema: { type: "object", properties: {} },
            explicitName: true,
          },
        },
        handler,
        interactive: false,
      },
    ],
  }
  writeFileSync(join(pkg, "manifest.json"), JSON.stringify(splitFlatManifest(manifest)))
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(join(pkg, rel), body)
    if (rel.endsWith(".sh")) chmodSync(join(pkg, rel), 0o755)
  }
}

/** An `sh` handler that drains stdin, then prints `json` on stdout. */
function shHandler(json: unknown): string {
  return `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(json)}'\n`
}

async function load(dir: string, events: LogEvent[]): Promise<PluginLoader> {
  return PluginLoader.load({
    userDir: dir,
    roots: { project: [join(dir, "no-project")] },
    coreToolNames: new Set(["Bash", "Read"]),
    diagnostics: createDiagnostics({ emit: (e) => events.push(e) }),
    logger: () => {},
  })
}

function ctxFor(loader: PluginLoader, blobDir: string): ToolRoundContext {
  return {
    sidebandApi: fixtureSidebandOrNone(),
    loader,
    modeManager: null,
    blobStore: new BlobStore({ sid: "sid", dir: blobDir }),
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "vision-model",
    store: null,
    lifecycle: NOOP_LIFECYCLE,
    text: fixtureSyntheticTextResolver(),
  }
}

const shot = (id: string): ToolUseBlock => ({ type: "tool_use", id, name: "Shot", input: {} })

function expectTextThenImage(content: unknown, firstText: string): void {
  expect(Array.isArray(content)).toBe(true)
  const parts = content as ContentBlock[]
  expect(parts).toHaveLength(2)
  expect(parts[0]?.type).toBe("text")
  expect((parts[0] as { text: string }).text.startsWith(firstText)).toBe(true)
  expect(parts[1]).toMatchObject({
    type: "image",
    source: { type: "base64", media_type: "image/png" },
  })
}

const invalidWarns = (events: LogEvent[]) =>
  events.filter((e) => e.source === "tool-attachment.invalid").map((e) => e.structuredData)

describe.skipIf(!textFixturesPresent())("subprocess tool attachments", () => {
  test("an sh handler with output json sends a PNG: [text, image] and the file is saved", async () => {
    registerVisionModel()
    const dir = join(ROOT, "ok")
    const result = {
      kind: "tool_result",
      content: "Screenshot taken.",
      attachments: [{ base64: PNG_B64, mimeType: "image/png", label: "screenshot" }],
    }
    writePlugin(
      dir,
      { type: "subprocess", command: ["./h.sh"], output: "json" },
      {
        "h.sh": shHandler(result),
      },
    )
    const events: LogEvent[] = []
    const loader = await load(dir, events)
    expect(loader.hasTool("Shot")).toBe(true)
    const blobDir = join(dir, "sid.blobs")
    const block = await executeToolRound(shot("toolu_s1"), ctxFor(loader, blobDir))
    expectTextThenImage(block.content, "Screenshot taken.")
    expect(block.is_error).not.toBe(true)
    expect(existsSync(join(blobDir, "toolu_s1-1.png"))).toBe(true)
    expect(invalidWarns(events)).toEqual([])
  })

  test("JSON stdout over the 5 MiB stdout cap fails the call before any parse or decode", async () => {
    const dir = join(ROOT, "over-cap")
    // 6 MiB of base64 in the JSON: the drain stops at the cap.
    const sh = [
      "#!/bin/sh",
      "cat >/dev/null",
      `printf '{"content":"big","attachments":[{"base64":"'`,
      `head -c 6291456 /dev/zero | tr '\\0' 'A'`,
      `printf '"}]}'`,
    ].join("\n")
    writePlugin(dir, { type: "subprocess", command: ["./h.sh"], output: "json" }, { "h.sh": sh })
    const events: LogEvent[] = []
    const loader = await load(dir, events)
    const r = await loader.dispatch(
      { type: "tool", name: "Shot", input: {}, tool_use_id: "toolu_s2" },
      dir,
    )
    expect(r).toMatchObject({ kind: "tool_result", is_error: true })
    if (r.kind !== "tool_result") throw new Error("kind")
    expect(r.attachments).toBeUndefined()
    expect(invalidWarns(events)).toEqual([])
  })

  test("a too-long base64 string is dropped at dispatch with base64-too-long", async () => {
    const dir = join(ROOT, "too-long")
    const n = MAX_ATTACHMENT_BASE64_CHARS + 4
    const body = `export default async () => ({ kind: "tool_result", content: "Long.", attachments: [{ base64: "A".repeat(${n}) }] })\n`
    writePlugin(dir, { type: "module", path: "./h.ts", export: "default" }, { "h.ts": body })
    const events: LogEvent[] = []
    const loader = await load(dir, events)
    const r = await loader.dispatch(
      { type: "tool", name: "Shot", input: {}, tool_use_id: "toolu_s7" },
      dir,
    )
    expect(r).toMatchObject({ kind: "tool_result", content: "Long." })
    if (r.kind !== "tool_result") throw new Error("kind")
    expect(r.is_error).toBeUndefined()
    expect(r.attachments).toEqual([{ base64: "" }])
    expect(invalidWarns(events)).toEqual([
      { pluginId: "shot", tool: "Shot", index: 0, reason: "base64-too-long" },
    ])
  })

  test("a bad entry and a good entry: the bad one is dropped, the good one keeps number 2", async () => {
    registerVisionModel()
    const dir = join(ROOT, "mixed")
    const result = {
      content: "One bad, one good.",
      attachments: [{ base64: "not base64!" }, { base64: PNG_B64 }],
    }
    writePlugin(
      dir,
      { type: "subprocess", command: ["./h.sh"], output: "json" },
      {
        "h.sh": shHandler(result),
      },
    )
    const events: LogEvent[] = []
    const loader = await load(dir, events)
    const blobDir = join(dir, "sid.blobs")
    const block = await executeToolRound(shot("toolu_s3"), ctxFor(loader, blobDir))
    expectTextThenImage(block.content, "One bad, one good.")
    expect(block.is_error).not.toBe(true)
    expect(existsSync(join(blobDir, "toolu_s3-1.png"))).toBe(false)
    expect(existsSync(join(blobDir, "toolu_s3-2.png"))).toBe(true)
    expect(invalidWarns(events)).toEqual([
      { pluginId: "shot", tool: "Shot", index: 0, reason: "base64-invalid" },
    ])
  })

  test("stdout that is not a JSON result is the content, with is_error and a warning", async () => {
    const dir = join(ROOT, "notjson")
    writePlugin(
      dir,
      { type: "subprocess", command: ["./h.sh"], output: "json" },
      {
        "h.sh": "#!/bin/sh\ncat >/dev/null\nprintf 'plain text'\n",
      },
    )
    const events: LogEvent[] = []
    const loader = await load(dir, events)
    const r = await loader.dispatch(
      { type: "tool", name: "Shot", input: {}, tool_use_id: "toolu_s4" },
      dir,
    )
    expect(r).toEqual({ kind: "tool_result", content: "plain text", is_error: true })
    expect(events.some((e) => e.source === "subprocess.json-invalid")).toBe(true)
  })

  test("a text handler (no output field) keeps stdout as the content, as before", async () => {
    const dir = join(ROOT, "text")
    writePlugin(
      dir,
      { type: "subprocess", command: ["./h.sh"] },
      {
        "h.sh": shHandler({ content: "x", attachments: [{ base64: PNG_B64 }] }),
      },
    )
    const loader = await load(dir, [])
    const r = await loader.dispatch(
      { type: "tool", name: "Shot", input: {}, tool_use_id: "toolu_s5" },
      dir,
    )
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") throw new Error("kind")
    expect(JSON.parse(r.content)).toMatchObject({ content: "x" })
    expect(r.attachments).toBeUndefined()
  })

  test("a module handler can send the wire form too", async () => {
    registerVisionModel()
    const dir = join(ROOT, "module")
    const body = `export default async () => ({ kind: "tool_result", content: "Module shot.", attachments: [{ base64: "${PNG_B64}" }] })\n`
    writePlugin(dir, { type: "module", path: "./h.ts", export: "default" }, { "h.ts": body })
    const loader = await load(dir, [])
    const blobDir = join(dir, "sid.blobs")
    const block = await executeToolRound(shot("toolu_s6"), ctxFor(loader, blobDir))
    expectTextThenImage(block.content, "Module shot.")
    expect(existsSync(join(blobDir, "toolu_s6-1.png"))).toBe(true)
  })
})
