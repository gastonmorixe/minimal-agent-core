/**
 * Parity table for the runtime, loader, mode and media texts (core-prompts
 * decouple P1.5). One row per synthetic.json entry of `src/agent/PROMPTS.ts`,
 * `src/plugins/loader/PROMPTS.ts`, `src/modes/PROMPTS.ts`, the limits part
 * of `src/media/PROMPTS.ts`, and the inline texts of `src/media/resolve.ts`
 * and `src/agent/synthetic-fallbacks.ts` (follow-up F1).
 *
 * Pass 1: the core path with no provider, called with the fixture args,
 * gives the fixture text.
 * Pass 2: a recording stub provider owns the kind. The facts the core path
 * passes have exactly the documented keys (plugin-api synthetic-text.ts),
 * and every value is data (number, string, boolean).
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
import { checkMedia, checkMediaSet, type MediaLimits } from "../media/limits.ts"
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
import { continueText, placeholderText } from "./synthetic-fallbacks.ts"
import {
  createSyntheticTextResolver,
  FALLBACK_SYNTHETIC_TEXT,
  type SyntheticTextResolver,
} from "./synthetic-text.ts"

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

/** The limits part of media/PROMPTS.ts. The rest is tool_text.Read.* (step 1.3). */
const LIMITS_FNS = new Set([
  "unsupportedModalityMessage",
  "unsupportedTypeMessage",
  "mediaTooLargeMessage",
  "mediaDimensionsTooLargeMessage",
  "tooManyAttachmentsMessage",
  "requestTooLargeMessage",
])

const FILES = new Set([
  "src/agent/PROMPTS.ts",
  "src/plugins/loader/PROMPTS.ts",
  "src/modes/PROMPTS.ts",
  "src/media/resolve.ts",
  "src/agent/synthetic-fallbacks.ts",
])

const rows = entries.filter(
  (e) => FILES.has(e.file) || (e.file === "src/media/PROMPTS.ts" && LIMITS_FNS.has(e.fn)),
)

type Text = SyntheticTextResolver | undefined
type Obj = Record<string, unknown>

/** How one fixture case runs through the core path. `text` undefined: no provider. */
interface Row {
  /** The kind, or the kind of one case when it depends on the args. */
  kind: SyntheticKind | ((args: unknown[]) => SyntheticKind)
  run: (text: Text, args: unknown[]) => string | Promise<string>
  /** Only calls with these facts are checked (a path that asks the kind twice). */
  pick?: (facts: SyntheticFacts) => boolean
}

const s = (v: unknown): string => v as string
const n = (v: unknown): number => v as number
const fb = (t: Text): SyntheticTextResolver => t ?? FALLBACK_SYNTHETIC_TEXT

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
    ...(text ? { syntheticText: text } : {}),
  })
  return firstText(out.content as Array<{ type: string; text?: string }>)
}

async function unavailableText(text: Text, id: string): Promise<string> {
  const out = await resolveMediaTurn({
    text: `[Image #${id}]`,
    registry: { get: () => undefined } as unknown as MediaRegistry,
    limits: limits(),
    modalities: ALL_MODALITY,
    ...(text ? { syntheticText: text } : {}),
  })
  return firstText(out.content as Array<{ type: string; text?: string }>)
}

const isCheck = (f: SyntheticFacts): boolean => f.site === "check"
const isMarker = (f: SyntheticFacts): boolean => f.site === "marker"

const ROWS: Record<string, Row> = {
  // src/agent/PROMPTS.ts
  turnAbortedAttachmentText: {
    kind: "runtime.turn_aborted",
    run: async (t) =>
      firstText(
        await buildInitialUserContent(
          { promptContributors: [] },
          { userText: "", orphanRepair: [], turnMarker: "aborted", ...(t ? { text: t } : {}) },
        ),
      ),
  },
  sessionResumedAttachmentText: {
    kind: "runtime.session_resumed",
    run: async (t) =>
      firstText(
        await buildInitialUserContent(
          { promptContributors: [] },
          { userText: "", orphanRepair: [], turnMarker: "resumed", ...(t ? { text: t } : {}) },
        ),
      ),
  },
  streamInterruptedAttachmentText: {
    kind: "runtime.stream_interrupted",
    run: async (t) => {
      const out = await nextRoundContent(
        {
          promptContributors: [],
          reflectionInterval: 0,
          reflectionCooldownMs: 0,
          reflectionSilenceRemaining: 0,
          ...(t ? { text: t } : {}),
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
    run: (t, a) => {
      const b = buildReflectionCheckpointBlock(n(a[0]), n(a[1]) * 1000, t)
      return b.type === "text" ? b.text : ""
    },
  },
  outputTruncatedAttachmentText: {
    kind: "continue.max_tokens",
    run: (t) => continueText(fb(t), true),
  },
  streamInterruptedContinueAttachmentText: {
    kind: "continue.stream_interrupted",
    run: (t) => continueText(fb(t), false),
  },
  responseTruncatedPlaceholderText: {
    kind: "assistant.placeholder",
    run: (t) => placeholderText(fb(t)),
  },
  toolExecutionAbortedBeforeCompletionResult: {
    kind: "tool_result.aborted",
    run: (t) => s(repairOrphanedToolUse(orphanHistory(), null, t)[0]?.content),
  },
  toolCallInterruptedByStopResult: {
    kind: "tool_result.interrupted_by_stop",
    run: (t) => s(closeInterruptedToolCalls(orphanHistory(), t)[0]?.content),
  },
  // src/agent/synthetic-fallbacks.ts
  placeholderText: { kind: "assistant.placeholder", run: (t) => placeholderText(fb(t)) },
  continueText: {
    kind: (a) => (a[0] ? "continue.max_tokens" : "continue.stream_interrupted"),
    run: (t, a) => continueText(fb(t), Boolean(a[0])),
  },
  // src/plugins/loader/PROMPTS.ts
  unknownPluginToolResult: {
    kind: "tool_result.unknown_tool",
    run: (t, a) => unknownPluginToolText(fb(t), s(a[0])),
  },
  pluginHandlerErrorResult: {
    kind: "tool_result.handler_error",
    run: (t, a) => pluginHandlerErrorText(fb(t), s(a[0])),
  },
  subprocessOutputExceededResult: {
    kind: "tool_result.subprocess_overflow",
    run: (t, a) => subprocessOverflowText(t, n(a[0]), s(a[1])),
  },
  // src/modes/PROMPTS.ts
  modeToolRefusalMessage: {
    kind: "mode.refusal",
    run: (t, a) => {
      const o = a[0] as Obj
      return modeRefusalText(fb(t), {
        toolName: s(o.toolName),
        modeId: s(o.label).toLowerCase(),
        label: s(o.label),
        ...(o.refusalHint !== undefined ? { refusalHint: s(o.refusalHint) } : {}),
      })
    },
  },
  activeModeStamp: {
    kind: "mode.active_stamp",
    run: (t, a) => modeActiveStampText(fb(t), s(a[0]), s(a[1])),
  },
  modeChangeAttachment: {
    kind: "mode.change",
    run: (t, a) => modeChangeText(fb(t), a[0] as { from: string; to: string; at: string }),
  },
  // src/media/PROMPTS.ts, limits part: the bare reason (site "check").
  unsupportedModalityMessage: {
    kind: "user_media.rejected",
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
    run: (t, a) => markerText(t, a[0] as MarkerScenario),
    pick: isMarker,
  },
  mediaUnavailableMarker: {
    kind: "user_media.unavailable",
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
    // 9 agent + 3 loader + 3 modes + 6 limits + 2 resolve.ts + 2 synthetic-fallbacks.ts
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
    it(`no provider: ${e.file} ${e.fn} gives the fixture text`, async () => {
      const row = ROWS[e.fn] as Row
      for (const c of e.cases) expect(await row.run(undefined, c.args)).toBe(c.text)
    })

    it(`recording stub: ${e.fn} passes the documented facts`, async () => {
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
        expect(calls.length, e.fn).toBe(1)
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
