/**
 * High-level ingestion entry point the agent/REPL calls at submit time.
 *
 * Given the submitted prompt text and the session {@link MediaRegistry}, it
 * resolves any `[Image #id …]` tokens into legacy wire content blocks ready to
 * push onto the conversation as a `user` message. Text-only prompts pass
 * straight through as a single text block, so this is a safe drop-in for the
 * existing "text -\> user content" step.
 *
 * Provider-neutral: limits/modalities resolve from the ACTIVE model through
 * the registry + the provider's `mediaLimits` hook (`resolveToolMediaContext`
 * route), falling back to the conservative neutral floor in
 * `./default-limits.ts`. Callers on a known model should pass the resolved
 * `limits`/`modalities`; the defaults exist for unresolved/early-boot cases.
 *
 * @module media/ingest
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { diag } from "../bus/diagnostic-bus.ts"
import type { ContentBlock as LegacyContentBlock } from "../client/types.ts"
import { canonicalMessageToLegacy } from "../llm/adapter-legacy.ts"
import type { ModalitySupport } from "../llm/capabilities.ts"

import { defaultMediaLimits } from "./default-limits.ts"
import type { MediaLimits } from "./limits.ts"
import type { MediaRegistry } from "./registry.ts"
import { type MediaPreparer, resolveMediaTurn } from "./resolve.ts"
import { getSessionMediaRegistry } from "./session-registry.ts"
import { formatMediaToken } from "./token.ts"
import type { MediaItem, MediaRejection } from "./types.ts"

/**
 * Neutral default modality assumption for vision-era chat models: image +
 * document in, no audio/video. Used only when the caller has no resolved
 * model (the registry's `capabilities.modalities` is authoritative
 * otherwise).
 */
export const DEFAULT_VISION_MODALITIES: ModalitySupport = {
  image: true,
  pdf: true,
  audio: false,
  video: false,
}

export interface BuildUserContentOptions {
  modelId?: string
  /** Override limits (default: the neutral {@link defaultMediaLimits} floor). */
  limits?: MediaLimits
  /** Context window, to size the per-request image cap. */
  contextWindow?: number
  /** Override the per-item preparer (default: inline base64). */
  prepare?: MediaPreparer
  modalities?: ModalitySupport
}

export interface UserContentResult {
  /** Legacy wire content blocks for a `role:"user"` message. */
  content: LegacyContentBlock[]
  /** Items dropped by a limit/modality check : caller should warn these. */
  rejected: Array<{ item: MediaItem; rejection: MediaRejection }>
  /** Token ids with no registry entry (stale pointers). */
  missing: string[]
  /** Oversize images auto-shrunk to fit, with a human summary : caller should note these. */
  fitted: Array<{ item: MediaItem; strategy: string }>
  /** True when at least one media block was attached. */
  hadMedia: boolean
}

/**
 * Resolve a submitted prompt into legacy user-message content, attaching any
 * referenced media as image/document blocks (image-then-text ordering).
 */
export async function buildUserContent(
  text: string,
  registry: MediaRegistry,
  opts: BuildUserContentOptions = {},
): Promise<UserContentResult> {
  const limits = opts.limits ?? defaultMediaLimits()
  const resolved = await resolveMediaTurn({
    text,
    registry,
    limits,
    modalities: opts.modalities ?? DEFAULT_VISION_MODALITIES,
    modelId: opts.modelId,
    prepare: opts.prepare,
  })
  const legacy = canonicalMessageToLegacy({ role: "user", content: resolved.content })
  // A `user` message always serializes to a block array, but the legacy type is
  // `string | ContentBlock[]`; normalize a (never-hit) string to one text block.
  const content: LegacyContentBlock[] = Array.isArray(legacy.content)
    ? legacy.content
    : [{ type: "text", text: legacy.content }]
  return {
    content,
    rejected: resolved.rejected,
    missing: resolved.missing,
    fitted: resolved.fitted,
    hadMedia: resolved.attached.length > 0,
  }
}

// Bare absolute IMAGE paths typed/pasted into the prompt (matches Claude Code's
// "just type a path to an image and I'll read it"). Documents (.pdf/.txt) are
// NOT auto-attached inline : they need an explicit drag-drop or token, so a
// prose mention of a doc path is not silently turned into an attachment.
// The path atom accepts a backslash-escape (`\.` for a drag-escaped space), a
// Unicode space that legitimately sits inside the name (U+00A0 NBSP, U+202F
// NARROW NO-BREAK SPACE — the macOS screenshot "5.49.35␏PM.png" case), or any
// non-whitespace/non-quote/non-backslash char. Matching these means a typed or
// drag-escaped screenshot path no longer dies at the first space before
// reaching its `.png`. The matched run is backslash-unescaped before the
// filesystem check (see below).
const INLINE_IMAGE_PATH_RE =
  /(?<![\w/~.])(?:\/|~\/)(?:\\.|[\u00a0\u202f]|[^\s'"\\])*\.(?:jpe?g|png|gif|webp)(?=$|[\s'".,;:!?])/gi

/**
 * Replace bare on-disk image paths in `text` with their media tokens,
 * registering each into `registry`. Non-existent paths are left untouched.
 * Returns the rewritten text (token substitutions applied right-to-left so
 * earlier indices stay valid).
 */
export async function materializeInlineImagePaths(
  text: string,
  registry: MediaRegistry,
): Promise<string> {
  const matches = [...text.matchAll(INLINE_IMAGE_PATH_RE)]
  if (matches.length === 0) return text
  let out = text
  for (const m of matches.reverse()) {
    const raw = m[0]
    // Unescape drag-style `\ ` (and any other `\x`) to get the on-disk name.
    const unescaped = raw.replace(/\\(.)/g, "$1")
    const abs = unescaped.startsWith("~/") ? join(homedir(), unescaped.slice(2)) : unescaped
    if (!existsSync(abs)) continue
    try {
      const item = await registry.registerPath(abs, "path")
      if (item.kind !== "image") continue
      const at = m.index ?? out.indexOf(raw)
      out = out.slice(0, at) + formatMediaToken(item) + out.slice(at + raw.length)
    } catch {
      // unreadable -> leave the literal path
    }
  }
  return out
}

/**
 * Full submit-time ingestion: materialize bare inline image paths into tokens,
 * then resolve all tokens (drop-inserted or typed) into user content. This is
 * the single call `agent.run()` makes for every submitted prompt.
 */
export async function ingestUserText(
  text: string,
  registry: MediaRegistry,
  opts: BuildUserContentOptions = {},
): Promise<UserContentResult> {
  const materialized = await materializeInlineImagePaths(text, registry)
  return buildUserContent(materialized, registry, opts)
}

/**
 * The single call the agent's submit path makes: resolve the prompt against the
 * shared session registry, warn (transient live-area) on rejected/missing
 * attachments, and return the content blocks to push onto the user turn.
 */
export async function resolveUserTurnContent(
  userText: string,
  opts: { modelId?: string } = {},
): Promise<LegacyContentBlock[]> {
  const ingested = await ingestUserText(userText, getSessionMediaRegistry(), {
    modelId: opts.modelId,
  })
  for (const f of ingested.fitted) {
    diag.info("media.fitted", `shrank an oversize image to fit (${f.strategy})`, {
      id: f.item.id,
      strategy: f.strategy,
    })
  }
  for (const r of ingested.rejected) {
    diag.warn("media.rejected", r.rejection.message, { id: r.item.id, code: r.rejection.code })
  }
  for (const id of ingested.missing) {
    diag.warn("media.missing", `attachment #${id} is no longer available`, { id })
  }
  return ingested.content
}
