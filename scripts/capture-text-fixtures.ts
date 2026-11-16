// Captures today's core prompt texts as JSON parity fixtures (core-prompts decouple, step P1.0).
// The plugins that take over these texts compare their output against the fixtures.
// Run: bun run scripts/capture-text-fixtures.ts (from minimal-agent-core). Inputs are fixed, so output is stable.
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import * as agentPrompts from "../src/agent/PROMPTS.ts"
import { continueText, placeholderText } from "../src/agent/synthetic-fallbacks.ts"
import { FALLBACK_SYNTHETIC_TEXT } from "../src/agent/synthetic-text.ts"
import type { ModalitySupport } from "../src/llm/capabilities.ts"
import { buildInstructionsBlockParts, DEFAULT_INSTRUCTIONS } from "../src/llm/instructions-block.ts"
import { NEUTRAL_IDENTITY } from "../src/llm/system-prompt.ts"
import * as mediaPrompts from "../src/media/PROMPTS.ts"
import type { MediaRegistry } from "../src/media/registry.ts"
import { resolveMediaTurn } from "../src/media/resolve.ts"
import type { MediaItem, MediaKind } from "../src/media/types.ts"
import * as modesPrompts from "../src/modes/PROMPTS.ts"
import * as loaderPrompts from "../src/plugins/loader/PROMPTS.ts"
import * as toolsPrompts from "../src/tools/PROMPTS.ts"
import { TOOL_DEFINITIONS } from "../src/tools/tool-definitions.ts"

const OUT = resolve(import.meta.dir, "../../minimal-agent-plugins/tests/text-parity/fixtures")
const AGENT_HOME = "~/.minimal-agent"

type Fn = (...args: never[]) => string
type Case = { args: unknown[] }
type Spec = { proposedKind: string; cases: unknown[][] }

function write(name: string, data: unknown): void {
  writeFileSync(join(OUT, name), `${JSON.stringify(data, null, 2)}\n`)
}

// tools.json: exact TOOL_DEFINITIONS bytes plus a per-tool text map.
function collectParams(
  props: unknown,
  prefix: string,
  out: Record<string, string>,
): Record<string, string> {
  if (props === null || typeof props !== "object") return out
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue
    const v = value as Record<string, unknown>
    const path = prefix === "" ? key : `${prefix}.${key}`
    if (typeof v.description === "string") out[path] = v.description
    collectParams(v.properties, path, out)
    const items = v.items as Record<string, unknown> | undefined
    if (items !== undefined) collectParams(items.properties, `${path}[]`, out)
  }
  return out
}

function captureTools(): void {
  const perTool: Record<string, { description: string; params: Record<string, string> }> = {}
  for (const def of TOOL_DEFINITIONS) {
    perTool[def.name] = {
      description: def.description,
      params: collectParams(def.input_schema.properties, "", {}),
    }
  }
  write("tools.json", {
    toolDefinitionsJson: JSON.stringify(TOOL_DEFINITIONS, null, 2),
    tools: perTool,
  })
}

// system.json: identity plus each instructions-block slot over the fact grid.
function captureSystem(): void {
  const grid = []
  for (const reflectionInterval of [0, 50]) {
    for (const reflectionCooldownMs of [0, 60000]) {
      for (const blobStoreEnabled of [true, false]) {
        const parts = buildInstructionsBlockParts({
          reflectionInterval,
          reflectionCooldownMs,
          blobStoreEnabled,
          agentHome: AGENT_HOME,
        })
        const slot = (name: string): string | null =>
          parts.find((p) => p.slot === name)?.text ?? null
        grid.push({
          ctx: {
            reflectionInterval,
            reflectionCooldownMs,
            blobStoreEnabled,
            agentHome: AGENT_HOME,
          },
          instructions: slot("instructions"),
          loopSafety: slot("loopSafety"),
          toolOutputConventions: slot("toolOutputConventions"),
          blockText: parts.map((p) => p.text).join("\n\n"),
        })
      }
    }
  }
  write("system.json", {
    identity: NEUTRAL_IDENTITY,
    instructionsTemplate: DEFAULT_INSTRUCTIONS,
    grid,
  })
}

// synthetic.json: every exported text function, with arg sets that hit each branch.
const RAW = "/s/abc.blobs/toolu_1.raw"

const TOOLS_SPECS: Record<string, Spec> = {
  toolAbortedByUserResult: { proposedKind: "tool_result.aborted{site:runtime}", cases: [[]] },
  unknownToolResult: { proposedKind: "tool_result.unknown_tool", cases: [["Foo"]] },
  modeToolDispatcherBugResult: { proposedKind: "tool_result.no_executor{name:Mode}", cases: [[]] },
  reflectionAckToolResult: { proposedKind: "runtime.reflection_ack_result", cases: [[]] },
  lockTimeoutResult: {
    proposedKind: "tool_result.lock_timeout",
    cases: [["Edit", "lock held by session abc for 30000ms"]],
  },
  lockAcquireFailedResult: {
    proposedKind: "tool_result.lock_failed",
    cases: [["Write", "EACCES: permission denied"]],
  },
  cdNoSuchDirectoryResult: { proposedKind: "tool_text.Bash.cd_no_dir", cases: [["/no/such"]] },
  bashOutputCapMarker: { proposedKind: "tool_text.Bash.output_cap", cases: [[1048576]] },
  bashTimedOutMarker: { proposedKind: "tool_text.Bash.timed_out", cases: [[120000]] },
  bashExitCodeResult: { proposedKind: "tool_text.Bash.exit_code", cases: [[1], [0], [null]] },
  bashErrorResult: { proposedKind: "tool_text.Bash.error", cases: [["spawn ENOENT"]] },
  whitespaceResolvedNote: {
    proposedKind: "tool_text.Read.whitespace_resolved",
    cases: [["/a/My File.txt"]],
  },
  readTooLargeResult: { proposedKind: "tool_text.Read.too_large", cases: [["12.5", 10]] },
  readErrorResult: { proposedKind: "tool_text.Read.error", cases: [["ENOENT: no such file"]] },
  fileWrittenResult: { proposedKind: "tool_text.Write.written", cases: [["/a/b.ts"]] },
  writeErrorResult: { proposedKind: "tool_text.Write.error", cases: [["EISDIR"]] },
  writeMissingPathResult: { proposedKind: "tool_text.Write.missing_path", cases: [[]] },
  writeMissingContentResult: { proposedKind: "tool_text.Write.missing_content", cases: [[]] },
  writeArgNotStringResult: {
    proposedKind: "tool_text.Write.arg_not_string",
    cases: [
      ["file_path", "number"],
      ["content", "object"],
    ],
  },
  editOldStringNotFoundResult: { proposedKind: "tool_text.Edit.not_found", cases: [["/a/b.ts"]] },
  editOldStringMultipleMatchesResult: {
    proposedKind: "tool_text.Edit.multiple",
    cases: [[3, "/a/b.ts"]],
  },
  fileEditedResult: {
    proposedKind: "tool_text.Edit.edited",
    cases: [
      ["/a/b.ts", 1],
      ["/a/b.ts", 4],
    ],
  },
  editErrorResult: { proposedKind: "tool_text.Edit.error", cases: [["EACCES"]] },
  noFilesMatchedResult: { proposedKind: "tool_text.Glob.no_files", cases: [[]] },
  globMissingPatternResult: { proposedKind: "tool_text.Glob.missing_pattern", cases: [[]] },
  globArgNotStringResult: {
    proposedKind: "tool_text.Glob.arg_not_string",
    cases: [
      ["pattern", "number"],
      ["glob_pattern", "array"],
    ],
  },
  globErrorResult: { proposedKind: "tool_text.Glob.error", cases: [["EPERM"]] },
  globTimeoutNotice: {
    proposedKind: "tool_text.Glob.timeout",
    cases: [
      [5000, 0],
      [5000, 1],
      [5000, 3],
    ],
  },
  globSkippedDirsNotice: { proposedKind: "tool_text.Glob.skipped_dirs", cases: [[1], [2]] },
  grepErrorResult: { proposedKind: "tool_text.Grep.error", cases: [["rg exited 2"]] },
  noMatchesFoundResult: { proposedKind: "tool_text.Grep.no_matches", cases: [[]] },
  outputPreviewAnnotation: {
    proposedKind: "tool_output.preview",
    cases: [
      [{ content: "line1\nline2", shown: 10, total: 49, tool: "Read", path: RAW, hint: "HINT" }],
      [{ content: "out", shown: 10, total: 1000, tool: "Bash", hint: "HINT" }],
      [{ content: "x", shown: 5, total: 7, tool: "Grep", path: "", hint: "" }],
    ],
  },
  truncatedOutputNotice: {
    proposedKind: "tool_output.truncated",
    cases: [
      [
        {
          kept: "kept body",
          shownBytes: 65536,
          totalBytes: "200000",
          shownLines: 1000,
          totalLines: "3000",
          cutLine: 1001,
          hint: "to continue, call Read with offset=1001 (and limit as needed).",
        },
      ],
      [
        {
          kept: "",
          shownBytes: 10,
          totalBytes: "unknown",
          shownLines: 1,
          totalLines: "unknown",
          cutLine: 2,
          hint: "",
        },
      ],
    ],
  },
  truncationHint: {
    proposedKind: "tool_output.truncated",
    cases: [
      ["Read", 1001, 65536],
      ["Grep", 1, 65536],
      ["Bash", 1, 65536],
      ["Glob", 1, 65536],
      ["Fetch", 1, 65536],
      ["WebSearch", 1, 65536],
      ["Other", 1, 65536],
      [undefined, 1, 65536],
    ],
  },
  streakNote: {
    proposedKind: "tool_output.streak",
    cases: [
      ["Read", 3],
      ["Grep", 3],
      ["Bash", 3],
      ["Glob", 3],
      ["Fetch", 3],
    ],
  },
  tuiPreviewHint: {
    proposedKind: "tool_output.preview",
    cases: [["Read"], ["Read", RAW], ["Bash"], ["Bash", RAW], ["Read", ""]],
  },
}

const AGENT_SPECS: Record<string, Spec> = {
  turnAbortedAttachmentText: { proposedKind: "runtime.turn_aborted", cases: [[]] },
  outputTruncatedAttachmentText: { proposedKind: "continue.max_tokens", cases: [[]] },
  sessionResumedAttachmentText: { proposedKind: "runtime.session_resumed", cases: [[]] },
  streamInterruptedAttachmentText: { proposedKind: "runtime.stream_interrupted", cases: [[]] },
  streamInterruptedContinueAttachmentText: {
    proposedKind: "continue.stream_interrupted",
    cases: [[]],
  },
  responseTruncatedPlaceholderText: { proposedKind: "assistant.placeholder", cases: [[]] },
  reflectionCheckpointAttachmentText: {
    proposedKind: "runtime.reflection_checkpoint",
    cases: [
      [50, 60],
      [100, 0],
    ],
  },
  toolExecutionAbortedBeforeCompletionResult: {
    proposedKind: "tool_result.aborted{site:orphan}",
    cases: [[]],
  },
  toolCallInterruptedByStopResult: { proposedKind: "tool_result.interrupted_by_stop", cases: [[]] },
}

const MODES_SPECS: Record<string, Spec> = {
  modeToolRefusalMessage: {
    proposedKind: "mode.refusal",
    cases: [
      [{ toolName: "Edit", label: "Ask", refusalHint: "Present changes as a diff." }],
      [{ toolName: "Write", label: "Plan" }],
      [{ toolName: "Bash", label: "Ask", refusalHint: "" }],
    ],
  },
  activeModeStamp: { proposedKind: "mode.active_stamp", cases: [["ask", "2026-11-15T10:00:00Z"]] },
  modeChangeAttachment: {
    proposedKind: "mode.change",
    cases: [[{ from: "default", to: "ask", at: "2026-11-15T10:00:00Z" }]],
  },
}

const LOADER_SPECS: Record<string, Spec> = {
  unknownPluginToolResult: {
    proposedKind: "tool_result.unknown_tool{plugin:true}",
    cases: [["FooTool"]],
  },
  pluginHandlerErrorResult: { proposedKind: "tool_result.handler_error", cases: [["boom"]] },
  subprocessOutputExceededResult: {
    proposedKind: "tool_result.subprocess_overflow",
    cases: [[10485760, "maxBuffer length exceeded"]],
  },
}

const MEDIA_SPECS: Record<string, Spec> = {
  unsupportedModalityMessage: {
    proposedKind: "user_media.rejected",
    cases: [
      ["model-x", "image"],
      ["model-x", "audio"],
      ["model-x", "video"],
      ["model-x", "document"],
    ],
  },
  unsupportedTypeMessage: {
    proposedKind: "user_media.rejected",
    cases: [["image/tiff", "model-x"]],
  },
  mediaTooLargeMessage: {
    proposedKind: "user_media.rejected",
    cases: [
      [{ rawBytes: 6000000, encodedBytes: 8000000, limitBytes: 5242880, modelId: "model-x" }],
      [{ rawBytes: 900, encodedBytes: 1200, limitBytes: 1024, modelId: "model-x" }],
    ],
  },
  mediaDimensionsTooLargeMessage: {
    proposedKind: "user_media.rejected",
    cases: [[{ width: 9000, height: 4000, maxDimension: 8000, modelId: "model-x" }]],
  },
  tooManyAttachmentsMessage: { proposedKind: "user_media.rejected", cases: [[20, "model-x"]] },
  requestTooLargeMessage: { proposedKind: "user_media.rejected", cases: [[33554432, "model-x"]] },
  binaryDocumentRejectedMessage: {
    proposedKind: "tool_text.Read.binary_rejected",
    cases: [[{ mimeType: "application/pdf", sizeBytes: 123456 }]],
  },
  unsupportedEmbeddingMessage: {
    proposedKind: "tool_text.Read.unsupported_embedding",
    cases: [[{ mimeType: "audio/mpeg", sizeBytes: 2048 }]],
  },
  unsupportedImageModalityMessage: {
    proposedKind: "tool_text.Read.unsupported_image_modality",
    cases: [[{ modelId: "model-x", mimeType: "image/png", sizeBytes: 512 }]],
  },
  fittedImageTooLargeMessage: {
    proposedKind: "tool_text.Read.image_too_large",
    cases: [[{ sizeBytes: 7000000, limitBytes: 5242880, modelId: "model-x" }]],
  },
  imageSummaryMessage: {
    proposedKind: "tool_text.Read.image_summary",
    cases: [
      [
        {
          subtype: "png",
          sizeBytes: 204800,
          dimensions: { width: 800, height: 600 },
          fittedStrategy: null,
        },
      ],
      [{ subtype: "jpeg", sizeBytes: 50, dimensions: null, fittedStrategy: null }],
      [
        {
          subtype: "png",
          sizeBytes: 3000000,
          dimensions: { width: 1568, height: 1176 },
          fittedStrategy: "downscale",
        },
      ],
    ],
  },
}

const FILES: Array<[string, Record<string, unknown>, Record<string, Spec>]> = [
  ["src/tools/PROMPTS.ts", toolsPrompts, TOOLS_SPECS],
  ["src/agent/PROMPTS.ts", agentPrompts, AGENT_SPECS],
  ["src/modes/PROMPTS.ts", modesPrompts, MODES_SPECS],
  ["src/plugins/loader/PROMPTS.ts", loaderPrompts, LOADER_SPECS],
  ["src/media/PROMPTS.ts", mediaPrompts, MEDIA_SPECS],
]

// Inline texts outside the PROMPTS.ts files (follow-up F1): the media marker
// wrappers of media/resolve.ts and the synthetic-fallbacks.ts helpers. These
// entries carry the file of the call site and a descriptive fn name.

/** One media marker scenario: an item and the model limits it meets. */
interface MediaMarkerScenario {
  kind: MediaKind
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  modelId?: string
  modalities: Array<keyof ModalitySupport>
  acceptedMimeTypes: string[]
  maxBytesPerItem: number
  maxRequestBytes: number
  maxItemsPerRequest: number
  maxDimension: number | null
}

const MEDIA_ID = "0000000a"
const TOKEN_WORD: Record<MediaKind, string> = {
  image: "Image",
  audio: "Audio",
  video: "Video",
  document: "File",
}

/** The residual text of a one-token prompt whose item the limits reject. */
async function mediaMarkerText(s: MediaMarkerScenario): Promise<string> {
  const item: MediaItem = {
    id: MEDIA_ID,
    kind: s.kind,
    mimeType: s.mimeType,
    origin: "drop",
    path: null,
    sizeBytes: s.sizeBytes,
    sha256: "",
    dimensions: s.width !== undefined ? { width: s.width, height: s.height ?? 0 } : null,
    durationSec: null,
    state: "registered",
    // No bytes: an oversize image is not refit, so it is rejected.
    bytes: () => Promise.reject(new Error("no bytes")),
    prepared: {},
    createdAt: 0,
  }
  const registry = { get: (id: string) => (id === MEDIA_ID ? item : undefined) }
  const modalities: ModalitySupport = { image: false, pdf: false, audio: false, video: false }
  for (const m of s.modalities) modalities[m] = true
  const out = await resolveMediaTurn({
    text: `[${TOKEN_WORD[s.kind]} #${MEDIA_ID}]`,
    registry: registry as unknown as MediaRegistry,
    limits: {
      acceptedMimeTypes: new Set(s.acceptedMimeTypes),
      maxBytesPerItem: s.maxBytesPerItem,
      maxRequestBytes: s.maxRequestBytes,
      maxItemsPerRequest: s.maxItemsPerRequest,
      maxDimension: s.maxDimension,
    },
    modalities,
    ...(s.modelId !== undefined ? { modelId: s.modelId } : {}),
    prepare: () => Promise.reject(new Error("not attached")),
  })
  const block = out.content.find((b) => b.type === "text")
  return block?.type === "text" ? block.text : ""
}

/** The residual text of a one-token prompt whose id is not in the registry. */
async function mediaUnavailableText(id: string): Promise<string> {
  const out = await resolveMediaTurn({
    text: `[Image #${id}]`,
    registry: { get: () => undefined } as unknown as MediaRegistry,
    limits: {
      acceptedMimeTypes: new Set(),
      maxBytesPerItem: 1,
      maxRequestBytes: 1,
      maxItemsPerRequest: 1,
      maxDimension: null,
    },
    modalities: { image: true, pdf: true, audio: false, video: false },
  })
  const block = out.content.find((b) => b.type === "text")
  return block?.type === "text" ? block.text : ""
}

const LIM = {
  acceptedMimeTypes: ["image/png", "image/jpeg", "application/pdf", "audio/wav", "video/mp4"],
  maxBytesPerItem: 5242880,
  maxRequestBytes: 33554432,
  maxItemsPerRequest: 100,
  maxDimension: 8000,
}
const ALL: Array<keyof ModalitySupport> = ["image", "pdf", "audio", "video"]

const MEDIA_MARKER_CASES: MediaMarkerScenario[] = [
  {
    ...LIM,
    kind: "image",
    mimeType: "image/png",
    sizeBytes: 100,
    modelId: "model-x",
    modalities: [],
  },
  {
    ...LIM,
    kind: "audio",
    mimeType: "audio/wav",
    sizeBytes: 100,
    modelId: "model-x",
    modalities: [],
  },
  {
    ...LIM,
    kind: "video",
    mimeType: "video/mp4",
    sizeBytes: 100,
    modelId: "model-x",
    modalities: [],
  },
  {
    ...LIM,
    kind: "document",
    mimeType: "application/pdf",
    sizeBytes: 100,
    modelId: "model-x",
    modalities: [],
  },
  {
    ...LIM,
    kind: "image",
    mimeType: "image/tiff",
    sizeBytes: 100,
    modelId: "model-x",
    modalities: ALL,
  },
  { ...LIM, kind: "image", mimeType: "image/png", sizeBytes: 100, modalities: [] },
  {
    ...LIM,
    kind: "image",
    mimeType: "image/png",
    sizeBytes: 6000000,
    modelId: "model-x",
    modalities: ALL,
  },
  {
    ...LIM,
    kind: "image",
    mimeType: "image/png",
    sizeBytes: 100,
    width: 9000,
    height: 4000,
    modelId: "model-x",
    modalities: ALL,
  },
  {
    ...LIM,
    kind: "document",
    mimeType: "application/pdf",
    sizeBytes: 100,
    modelId: "model-x",
    modalities: ALL,
    maxItemsPerRequest: 0,
  },
  {
    ...LIM,
    kind: "document",
    mimeType: "application/pdf",
    sizeBytes: 3000000,
    modelId: "model-x",
    modalities: ALL,
    maxRequestBytes: 1048576,
  },
]

async function inlineEntries(): Promise<unknown[]> {
  const marker = []
  for (const s of MEDIA_MARKER_CASES) marker.push({ args: [s], text: await mediaMarkerText(s) })
  return [
    {
      fn: "mediaRejectedMarker",
      file: "src/media/resolve.ts",
      proposedKind: "user_media.rejected{site:marker}",
      cases: marker,
    },
    {
      fn: "mediaUnavailableMarker",
      file: "src/media/resolve.ts",
      proposedKind: "user_media.unavailable",
      cases: [{ args: ["deadbeef"], text: await mediaUnavailableText("deadbeef") }],
    },
    {
      fn: "placeholderText",
      file: "src/agent/synthetic-fallbacks.ts",
      proposedKind: "assistant.placeholder",
      cases: [{ args: [], text: placeholderText(FALLBACK_SYNTHETIC_TEXT) }],
    },
    {
      fn: "continueText",
      file: "src/agent/synthetic-fallbacks.ts",
      proposedKind: "continue.*",
      cases: [
        { args: [true], text: continueText(FALLBACK_SYNTHETIC_TEXT, true) },
        { args: [false], text: continueText(FALLBACK_SYNTHETIC_TEXT, false) },
      ],
    },
  ]
}

async function captureSynthetic(): Promise<void> {
  const entries = []
  const counts: Record<string, number> = {}
  const missing: string[] = []
  for (const [file, mod, specs] of FILES) {
    counts[file] = 0
    for (const [name, value] of Object.entries(mod).sort(([a], [b]) => a.localeCompare(b))) {
      if (typeof value !== "function") continue
      const spec = specs[name]
      if (spec === undefined) {
        missing.push(`${file}#${name}`)
        continue
      }
      const fn = value as Fn
      const cases = spec.cases.map((args): Case & { text: string } => ({
        args,
        text: fn(...(args as never[])),
      }))
      entries.push({ fn: name, file, proposedKind: spec.proposedKind, cases })
      counts[file] += 1
    }
    for (const name of Object.keys(specs)) {
      if (typeof mod[name] !== "function") missing.push(`${file}#${name} (spec without export)`)
    }
  }
  if (missing.length > 0) throw new Error(`uncovered exports: ${missing.join(", ")}`)
  const inline = await inlineEntries()
  entries.push(...(inline as typeof entries))
  console.log(`inline call sites: ${inline.length} entries`)
  write("synthetic.json", {
    paramDescriptions: toolsPrompts.TOOL_PARAM_DESCRIPTIONS,
    entries,
  })
  for (const [file, n] of Object.entries(counts)) console.log(`${file}: ${n} functions`)
}

mkdirSync(OUT, { recursive: true })
captureTools()
captureSystem()
await captureSynthetic()
// The plugins repo lints JSON with biome, so format the fixtures with its config. Parsed data is unchanged.
const fmt = Bun.spawnSync(["bunx", "biome", "format", "--write", OUT], {
  cwd: resolve(OUT, "../../.."),
  stdout: "ignore",
  stderr: "inherit",
})
if (fmt.exitCode !== 0) throw new Error(`biome format exited ${fmt.exitCode}`)
console.log(`fixtures written to ${OUT}`)
