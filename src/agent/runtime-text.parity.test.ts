/**
 * Kind and facts table for the runtime, loader, mode and media texts
 * (core-prompts decouple P1.5 and P3.2). One row per synthetic.json entry of
 * the old agent, plugin loader and mode text files, the limits part of the
 * old media text file, and the inline texts of `src/media/resolve.ts` and
 * `src/agent/synthetic-texts.ts` (follow-up F1).
 *
 * For each fixture case, a recording stub provider owns the kind. The core
 * path called with the fixture args asks for exactly the row kind with
 * exactly the expected facts, the keys are the documented ones (plugin-api
 * synthetic-text.ts), and every value is data (number, string, boolean).
 * The text compare lives in minimal-agent-plugins
 * (ma-turn-recovery-plugin/provider.parity.test.ts and the other plugin
 * parity tests).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type {
  SyntheticFacts,
  SyntheticKind,
  SyntheticTextProvider,
} from "../../plugin-api/src/types/synthetic-text.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import type { ModalitySupport } from "../llm/capabilities.ts"
import type { Message } from "../llm/messages.ts"
import {
  base64EncodedSize,
  checkMedia,
  checkMediaSet,
  kindModality,
  type MediaLimits,
} from "../media/limits.ts"
import type { MediaRegistry } from "../media/registry.ts"
import { resolveMediaTurn } from "../media/resolve.ts"
import type { MediaItem, MediaKind } from "../media/types.ts"
import { modeActiveStampText, modeChangeText, modeRefusalText } from "../modes/mode-text.ts"
import {
  pluginHandlerErrorText,
  subprocessOverflowText,
  unknownPluginToolText,
} from "../plugins/loader/helpers.ts"
import { buildInitialUserContent, nextRoundContent } from "../sdk/agent-core-helpers.ts"

import { closeInterruptedToolCalls, repairOrphanedToolUse } from "./history-repair.ts"
import { buildReflectionCheckpointBlock } from "./reflection.ts"
import { createSyntheticTextResolver, type SyntheticTextResolver } from "./synthetic-text.ts"
import { continueText, placeholderText } from "./synthetic-texts.ts"

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "minimal-agent-plugins",
  "tests",
  "text-parity",
  "fixtures",
  "synthetic.json",
)

interface FixtureCase {
  args: unknown[]
  text: string
}
interface FixtureEntry {
  fn: string
  file: string
  proposedKind: string
  cases: FixtureCase[]
}

const hasFixture = existsSync(FIXTURE)
const entries: FixtureEntry[] = hasFixture
  ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as { entries: FixtureEntry[] }).entries
  : []

/** The limits part of the old media text file. The rest is tool_text.Read.* (step 1.3). */
const LIMITS_FNS = new Set([
  "unsupportedModalityMessage",
  "unsupportedTypeMessage",
  "mediaTooLargeMessage",
  "mediaDimensionsTooLargeMessage",
  "tooManyAttachmentsMessage",
  "requestTooLargeMessage",
])

/** Fixture `file` directories whose entries are runtime, loader or mode texts. */
const DIRS = ["src/agent/", "src/plugins/loader/", "src/modes/"]

const rows = entries.filter(
  (e) =>
    DIRS.some((d) => e.file.startsWith(d)) ||
    e.file === "src/media/resolve.ts" ||
    (e.file.startsWith("src/media/") && LIMITS_FNS.has(e.fn)),
)

type Text = SyntheticTextResolver
type Obj = Record<string, unknown>

/** How one fixture case runs through the core path with the recording resolver. */
interface Row {
  /** The kind, or the kind of one case when it depends on the args. */
  kind: SyntheticKind | ((args: unknown[]) => SyntheticKind)
  run: (text: Text, args: unknown[]) => string | Promise<string>
  /** The exact facts the core path must pass for the fixture args. */
  facts: (args: unknown[]) => SyntheticFacts
  /** Only calls with these facts are checked (a path that asks the kind twice). */
  pick?: (facts: SyntheticFacts) => boolean
}

const s = (v: unknown): string => v as string
const n = (v: unknown): number => v as number
const none = (): SyntheticFacts => ({})

/** The first text block of a content array. */
function firstText(blocks: Array<{ type: string; text?: string }>): string {
  const b = blocks.find((x) => x.type === "text")
  return b?.text ?? ""
}

/** A history whose last assistant message has one tool_use with no result. */
function orphanHistory(): Message[] {
  return [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
  ]
}

const NO_MODALITY: ModalitySupport = { image: false, pdf: false, audio: false, video: false }
const ALL_MODALITY: ModalitySupport = { image: true, pdf: true, audio: true, video: true }

function limits(over: Partial<MediaLimits> = {}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(["image/png", "application/pdf"]),
    maxBytesPerItem: 5242880,
    maxRequestBytes: 33554432,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
    ...over,
  }
}

/** The message of a rejected verdict (fails the test on an ok verdict). */
function msg(v: ReturnType<typeof checkMedia>): string {
  if (v.ok) throw new Error("expected a rejection")
  return v.message
}

/** The capture script's media marker scenario (scripts/capture-text-fixtures.ts). */
interface MarkerScenario {
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

const WORD: Record<MediaKind, string> = {
  image: "Image",
  audio: "Audio",
  video: "Video",
  document: "File",
}

async function markerText(text: Text, sc: MarkerScenario): Promise<string> {
  const id = "0000000a"
  const item: MediaItem = {
    id,
    kind: sc.kind,
    mimeType: sc.mimeType,
    origin: "drop",
    path: null,
    sizeBytes: sc.sizeBytes,
    sha256: "",
    dimensions: sc.width !== undefined ? { width: sc.width, height: sc.height ?? 0 } : null,
    durationSec: null,
    state: "registered",
    bytes: () => Promise.reject(new Error("no bytes")),
    prepared: {},
    createdAt: 0,
  }
  const modalities: ModalitySupport = { ...NO_MODALITY }
  for (const m of sc.modalities) modalities[m] = true
  const out = await resolveMediaTurn({
    text: `[${WORD[sc.kind]} #${id}]`,
    registry: { get: (x: string) => (x === id ? item : undefined) } as unknown as MediaRegistry,
    limits: {
      acceptedMimeTypes: new Set(sc.acceptedMimeTypes),
      maxBytesPerItem: sc.maxBytesPerItem,
      maxRequestBytes: sc.maxRequestBytes,
      maxItemsPerRequest: sc.maxItemsPerRequest,
      maxDimension: sc.maxDimension,
    },
    modalities,
    ...(sc.modelId !== undefined ? { modelId: sc.modelId } : {}),
    prepare: () => Promise.reject(new Error("not attached")),
    syntheticText: text,
  })
  return firstText(out.content as Array<{ type: string; text?: string }>)
}

async function unavailableText(text: Text, id: string): Promise<string> {
  const out = await resolveMediaTurn({
    text: `[Image #${id}]`,
    registry: { get: () => undefined } as unknown as MediaRegistry,
    limits: limits(),
    modalities: ALL_MODALITY,
    syntheticText: text,
  })
  return firstText(out.content as Array<{ type: string; text?: string }>)
}

/**
 * The facts of the `site: "marker"` call for one marker scenario: the
 * rejection reason the limits pick (per item first, then the set), its
 * facts, and the item kind and mime type.
 */
function markerFacts(sc: MarkerScenario): SyntheticFacts {
  const model: SyntheticFacts = sc.modelId === undefined ? {} : { modelId: sc.modelId }
  const item = { ...model, kind: sc.kind, mimeType: sc.mimeType }
  const encodedBytes = base64EncodedSize(sc.sizeBytes)
  let facts: SyntheticFacts
  if (!sc.modalities.includes(kindModality(sc.kind))) {
    facts = { reason: "unsupported-modality", ...item }
  } else if (!sc.acceptedMimeTypes.includes(sc.mimeType)) {
    facts = { reason: "unsupported-type", ...item }
  } else if (encodedBytes > sc.maxBytesPerItem) {
    const limitBytes = sc.maxBytesPerItem
    facts = { reason: "too-large", ...item, sizeBytes: sc.sizeBytes, encodedBytes, limitBytes }
  } else if (
    sc.maxDimension != null &&
    sc.width !== undefined &&
    Math.max(sc.width, sc.height ?? 0) > sc.maxDimension
  ) {
    const dims = { width: sc.width, height: sc.height ?? 0, maxDimension: sc.maxDimension }
    facts = { reason: "dimensions", ...item, ...dims }
  } else if (sc.maxItemsPerRequest < 1) {
    facts = { reason: "too-many", ...model, maxItems: sc.maxItemsPerRequest }
  } else {
    facts = { reason: "request-too-large", ...model, limitBytes: sc.maxRequestBytes }
  }
  return { ...facts, kind: sc.kind, mimeType: sc.mimeType, site: "marker" }
}

const isCheck = (f: SyntheticFacts): boolean => f.site === "check"
const isMarker = (f: SyntheticFacts): boolean => f.site === "marker"

const ROWS: Record<string, Row> = {
  // agent texts (old agent text file)
  turnAbortedAttachmentText: {
    kind: "runtime.turn_aborted",
    facts: none,
    run: async (t) =>
      firstText(
        await buildInitialUserContent(
          { promptContributors: [] },
          { userText: "", orphanRepair: [], turnMarker: "aborted", text: t },
        ),
      ),
  },
  sessionResumedAttachmentText: {
    kind: "runtime.session_resumed",
    facts: none,
    run: async (t) =>
      firstText(
        await buildInitialUserContent(
          { promptContributors: [] },
          { userText: "", orphanRepair: [], turnMarker: "resumed", text: t },
        ),
      ),
  },
  streamInterruptedAttachmentText: {
    kind: "runtime.stream_interrupted",
    facts: none,
    run: async (t) => {
      const out = await nextRoundContent(
        {
          promptContributors: [],
          reflectionInterval: 0,
          reflectionCooldownMs: 0,
          reflectionSilenceRemaining: 0,
          text: t,
        },
        [],
        true,
        1,
        {},
      )
      return firstText(out.content as Array<{ type: string; text?: string }>)
    },
  },
  reflectionCheckpointAttachmentText: {
    kind: "runtime.reflection_checkpoint",
    facts: (a) => ({ round: n(a[0]), cooldownSec: n(a[1]) }),
    run: (t, a) => {
      const b = buildReflectionCheckpointBlock(n(a[0]), n(a[1]) * 1000, t)
      return b.type === "text" ? b.text : ""
    },
  },
  outputTruncatedAttachmentText: {
    kind: "continue.max_tokens",
    facts: none,
    run: (t) => continueText(t, true),
  },
  streamInterruptedContinueAttachmentText: {
    kind: "continue.stream_interrupted",
    facts: none,
    run: (t) => continueText(t, false),
  },
  responseTruncatedPlaceholderText: {
    kind: "assistant.placeholder",
    facts: none,
    run: (t) => placeholderText(t),
  },
  toolExecutionAbortedBeforeCompletionResult: {
    kind: "tool_result.aborted",
    facts: () => ({ site: "orphan" }),
    run: (t) => s(repairOrphanedToolUse(orphanHistory(), null, t)[0]?.content),
  },
  toolCallInterruptedByStopResult: {
    kind: "tool_result.interrupted_by_stop",
    facts: none,
    run: (t) => s(closeInterruptedToolCalls(orphanHistory(), t)[0]?.content),
  },
  // src/agent/synthetic-texts.ts
  placeholderText: {
    kind: "assistant.placeholder",
    facts: none,
    run: (t) => placeholderText(t),
  },
  continueText: {
    kind: (a) => (a[0] ? "continue.max_tokens" : "continue.stream_interrupted"),
    facts: none,
    run: (t, a) => continueText(t, Boolean(a[0])),
  },
  // plugin loader texts
  unknownPluginToolResult: {
    kind: "tool_result.unknown_tool",
    facts: (a) => ({ name: s(a[0]), plugin: true }),
    run: (t, a) => unknownPluginToolText(t, s(a[0])),
  },
  pluginHandlerErrorResult: {
    kind: "tool_result.handler_error",
    facts: (a) => ({ detail: s(a[0]) }),
    run: (t, a) => pluginHandlerErrorText(t, s(a[0])),
  },
  subprocessOutputExceededResult: {
    kind: "tool_result.subprocess_overflow",
    facts: (a) => ({ maxBytes: n(a[0]), detail: s(a[1]) }),
    run: (t, a) => subprocessOverflowText(t, n(a[0]), s(a[1])),
  },
  // mode texts
  modeToolRefusalMessage: {
    kind: "mode.refusal",
    facts: (a) => {
      const o = a[0] as Obj
      const base = { tool: s(o.toolName), modeId: s(o.label).toLowerCase(), label: s(o.label) }
      return o.refusalHint ? { ...base, hint: s(o.refusalHint) } : base
    },
    run: (t, a) => {
      const o = a[0] as Obj
      return modeRefusalText(t, {
        toolName: s(o.toolName),
        modeId: s(o.label).toLowerCase(),
        label: s(o.label),
        ...(o.refusalHint !== undefined ? { refusalHint: s(o.refusalHint) } : {}),
      })
    },
  },
  activeModeStamp: {
    kind: "mode.active_stamp",
    facts: (a) => ({ id: s(a[0]), since: s(a[1]) }),
    run: (t, a) => modeActiveStampText(t, s(a[0]), s(a[1])),
  },
  modeChangeAttachment: {
    kind: "mode.change",
    facts: (a) => ({ ...(a[0] as { from: string; to: string; at: string }) }),
    run: (t, a) => modeChangeText(t, a[0] as { from: string; to: string; at: string }),
  },
  // media limits part: the bare reason (site "check").
  unsupportedModalityMessage: {
    kind: "user_media.rejected",
    facts: (a) => ({
      reason: "unsupported-modality",
      modelId: s(a[0]),
      kind: s(a[1]),
      mimeType: "x/y",
      site: "check",
    }),
    run: (t, a) =>
      msg(
        checkMedia(
          { kind: a[1] as MediaKind, mimeType: "x/y", sizeBytes: 1, dimensions: null },
          limits(),
          NO_MODALITY,
          s(a[0]),
          t,
        ),
      ),
  },
  unsupportedTypeMessage: {
    kind: "user_media.rejected",
    facts: (a) => ({
      reason: "unsupported-type",
      modelId: s(a[1]),
      kind: "image",
      mimeType: s(a[0]),
      site: "check",
    }),
    run: (t, a) =>
      msg(
        checkMedia(
          { kind: "image", mimeType: s(a[0]), sizeBytes: 1, dimensions: null },
          limits(),
          ALL_MODALITY,
          s(a[1]),
          t,
        ),
      ),
  },
  mediaTooLargeMessage: {
    kind: "user_media.rejected",
    facts: (a) => {
      const o = a[0] as Obj
      return {
        reason: "too-large",
        modelId: s(o.modelId),
        kind: "image",
        mimeType: "image/png",
        sizeBytes: n(o.rawBytes),
        encodedBytes: n(o.encodedBytes),
        limitBytes: n(o.limitBytes),
        site: "check",
      }
    },
    run: (t, a) => {
      const o = a[0] as Obj
      return msg(
        checkMedia(
          { kind: "image", mimeType: "image/png", sizeBytes: n(o.rawBytes), dimensions: null },
          limits({ maxBytesPerItem: n(o.limitBytes) }),
          ALL_MODALITY,
          s(o.modelId),
          t,
        ),
      )
    },
  },
  mediaDimensionsTooLargeMessage: {
    kind: "user_media.rejected",
    facts: (a) => {
      const o = a[0] as Obj
      return {
        reason: "dimensions",
        modelId: s(o.modelId),
        kind: "image",
        mimeType: "image/png",
        width: n(o.width),
        height: n(o.height),
        maxDimension: n(o.maxDimension),
        site: "check",
      }
    },
    run: (t, a) => {
      const o = a[0] as Obj
      return msg(
        checkMedia(
          {
            kind: "image",
            mimeType: "image/png",
            sizeBytes: 1,
            dimensions: { width: n(o.width), height: n(o.height) },
          },
          limits({ maxDimension: n(o.maxDimension) }),
          ALL_MODALITY,
          s(o.modelId),
          t,
        ),
      )
    },
  },
  tooManyAttachmentsMessage: {
    kind: "user_media.rejected",
    facts: (a) => ({ reason: "too-many", modelId: s(a[1]), maxItems: n(a[0]), site: "check" }),
    run: (t, a) => {
      const max = n(a[0])
      const items = Array.from({ length: max + 1 }, () => ({ sizeBytes: 1 }))
      const v = checkMediaSet(items, limits({ maxItemsPerRequest: max }), s(a[1]), t).at(-1)
      if (!v || v.ok) throw new Error("expected a rejection")
      return v.message
    },
  },
  requestTooLargeMessage: {
    kind: "user_media.rejected",
    facts: (a) => ({
      reason: "request-too-large",
      modelId: s(a[1]),
      limitBytes: n(a[0]),
      site: "check",
    }),
    run: (t, a) => {
      const max = n(a[0])
      const [v] = checkMediaSet([{ sizeBytes: max }], limits({ maxRequestBytes: max }), s(a[1]), t)
      if (!v || v.ok) throw new Error("expected a rejection")
      return v.message
    },
  },
  // src/media/resolve.ts: the whole marker (site "marker") and a stale id.
  mediaRejectedMarker: {
    kind: "user_media.rejected",
    facts: (a) => markerFacts(a[0] as MarkerScenario),
    run: (t, a) => markerText(t, a[0] as MarkerScenario),
    pick: isMarker,
  },
  mediaUnavailableMarker: {
    kind: "user_media.unavailable",
    facts: (a) => ({ id: s(a[0]) }),
    run: (t, a) => unavailableText(t, s(a[0])),
  },
}

/** Rows that ask `user_media.rejected` from a limit check: only the check call is checked. */
for (const fn of LIMITS_FNS) {
  const row = ROWS[fn]
  if (row) row.pick = isCheck
}

/** The documented facts per kind (plugin-api types/synthetic-text.ts). `?` marks optional. */
const DOC: Partial<Record<SyntheticKind, string[]>> = {
  "runtime.turn_aborted": [],
  "runtime.session_resumed": [],
  "runtime.stream_interrupted": [],
  "runtime.reflection_checkpoint": ["round", "cooldownSec"],
  "continue.max_tokens": [],
  "continue.stream_interrupted": [],
  "assistant.placeholder": [],
  "tool_result.aborted": ["site"],
  "tool_result.interrupted_by_stop": [],
  "tool_result.unknown_tool": ["name", "plugin?"],
  "tool_result.handler_error": ["detail"],
  "tool_result.subprocess_overflow": ["maxBytes", "detail"],
  "mode.refusal": ["tool", "modeId", "label", "hint?"],
  "mode.active_stamp": ["id", "since"],
  "mode.change": ["from", "to", "at"],
  "user_media.rejected": [
    "site",
    "reason",
    "modelId?",
    "kind?",
    "mimeType?",
    "sizeBytes?",
    "encodedBytes?",
    "limitBytes?",
    "width?",
    "height?",
    "maxDimension?",
    "maxItems?",
  ],
  "user_media.unavailable": ["id"],
}

/** Fixed facts some kinds must carry at a given call site. */
const FIXED: Record<string, SyntheticFacts> = {
  toolExecutionAbortedBeforeCompletionResult: { site: "orphan" },
  unknownPluginToolResult: { plugin: true },
}

/** A resolver whose one stub provider owns `kind` and records each call. */
function recording(kind: SyntheticKind): {
  text: SyntheticTextResolver
  calls: { kind: SyntheticKind; facts: SyntheticFacts }[]
} {
  const calls: { kind: SyntheticKind; facts: SyntheticFacts }[] = []
  const provider: SyntheticTextProvider = {
    kinds: [kind],
    text: (k, facts) => {
      calls.push({ kind: k, facts })
      return `STUB ${k}`
    },
  }
  return {
    text: createSyntheticTextResolver([provider], createDiagnostics({ emit: () => {} })),
    calls,
  }
}

const kindOf = (row: Row, args: unknown[]): SyntheticKind =>
  typeof row.kind === "function" ? row.kind(args) : row.kind

describe.skipIf(!hasFixture)("runtime, loader, mode and media text parity table", () => {
  it("covers every agent, loader, mode, limits and inline entry, with the proposed kind", () => {
    // 9 agent + 3 loader + 3 modes + 6 limits + 2 resolve.ts + 2 synthetic-texts.ts
    expect(rows.length).toBe(25)
    for (const e of rows) {
      const row = ROWS[e.fn]
      expect(row, e.fn).toBeDefined()
      if (!row) continue
      // proposedKind may carry a fact suffix (`{site:orphan}`) or a family (`continue.*`).
      const want = e.proposedKind.split("{")[0] ?? ""
      for (const c of e.cases) {
        const got = kindOf(row, c.args)
        if (want.endsWith(".*")) expect(got.startsWith(want.slice(0, -1)), e.fn).toBe(true)
        else expect(got, e.fn).toBe(want as SyntheticKind)
      }
    }
  })

  for (const e of rows) {
    it(`recording stub: ${e.fn} asks for its kind with the exact facts`, async () => {
      const row = ROWS[e.fn] as Row
      for (const c of e.cases) {
        const kind = kindOf(row, c.args)
        const doc = DOC[kind]
        expect(doc, kind).toBeDefined()
        const required = (doc ?? []).filter((k) => !k.endsWith("?"))
        const allowed = new Set((doc ?? []).map((k) => k.replace(/\?$/, "")))
        const rec = recording(kind)
        const out = await row.run(rec.text, c.args)
        expect(out, e.fn).toBe(`STUB ${kind}`)
        const calls = rec.calls.filter((x) => (row.pick ? row.pick(x.facts) : true))
        expect(calls, e.fn).toEqual([{ kind, facts: row.facts(c.args) }])
        const facts = calls[0]?.facts ?? {}
        for (const key of required) expect(Object.hasOwn(facts, key), `${e.fn} ${key}`).toBe(true)
        for (const [key, value] of Object.entries(facts)) {
          expect(allowed.has(key), `${e.fn} extra ${key}`).toBe(true)
          expect(["number", "string", "boolean"]).toContain(typeof value)
        }
        for (const [key, value] of Object.entries(FIXED[e.fn] ?? {}))
          expect(facts[key], `${e.fn} ${key}`).toBe(value)
      }
    })
  }
})
