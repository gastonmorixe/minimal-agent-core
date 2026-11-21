/**
 * Shared context-compaction helpers for both legacy {@link Agent} and
 * {@link AgentCore}.
 *
 * Pure history rewrite + policy helpers live here so neither agent class
 * grows past the max-lines budget, and so REPL/SDK paths share one
 * compact contract.
 *
 * Remote compaction is provider-owned (`ProviderAdapter.compact`). When
 * the active provider has no remote compact endpoint, callers fall back
 * to {@link buildLocalCompactMessages} (LLM summary or hard prune).
 *
 * @module agent/context-compact
 */

import type { CoreErrorJson } from "../errors/types.ts"
import type { ContentBlock, Message } from "../llm/messages.ts"
import { renderCoreKind } from "../sideband/core-render.ts"
import type { SidebandApi } from "../sideband/types.ts"

import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "./synthetic-text.ts"

/** Why a compact was requested. */
export type CompactReason = "manual" | "auto" | "exceeded"

/** Compaction engine. Triggers (`auto`/`manual`/`exceeded`) are reasons, not modes. */
export type CompactMode = "remote" | "tail" | "local" | "fork"

/** Default trailing messages kept verbatim behind the checkpoint. */
export const DEFAULT_KEEP_TAIL = 6

/**
 * Options every `compact()` entry point accepts. All fields optional so
 * legacy callers (`{ reason }`, `{ reason, preferRemote }`) keep working.
 */
export interface CompactRequestOpts {
  reason?: CompactReason
  preferRemote?: boolean
  /** Explicit engine. Overrides the `preferRemote` default mapping. */
  mode?: CompactMode
  /** Trailing messages kept verbatim (default 6). Must be \>= 0. */
  keepTail?: number
  /** Hint passed to the summarizer and kept verbatim in the checkpoint. */
  focus?: string
  /**
   * Cancellation for the blocking local-summary call and its retry backoff.
   * The host forwards the command's `ctx.abort` (turn cancel / per-command
   * timeout) so a rate-limited summary retries politely but never outlives
   * the command budget.
   */
  signal?: AbortSignal
  /**
   * Optional progress sink for the local-summary LLM stream. Called per
   * text delta with approximate output tokens so host UX (status label,
   * TPS footer) can tick during long summaries. UX-only: a throwing sink
   * must not fail compact (run-compact swallows sink errors).
   */
  onProgress?: (delta: { deltaTokens: number }) => void
  /**
   * Optional interim-text sink for the local-summary LLM stream. The host
   * wires `compositor.writeStream` here when one is available; otherwise
   * status label updates are the only interim UX.
   */
  writeStream?: (chunk: string) => void
  /**
   * Called at the start of each local-summary attempt (1-based). Host
   * formatters must reset on attempt 2 so retry tokens are not mixed
   * into the first stream.
   */
  onSummaryAttempt?: (attempt: number) => void | Promise<void>
}

/** Outcome of a successful history rewrite. */
export interface CompactStats {
  reason: CompactReason
  kind: "remote" | "local"
  messagesBefore: number
  messagesAfter: number
  /** Optional token estimates when the caller computed them. */
  tokensBefore?: number
  tokensAfter?: number
  /**
   * When `kind === "local"` because remote compact failed or was
   * unavailable, the facts of the cause (row c7). Core holds no text: a
   * host renders it (the CLI `/compact` footer).
   */
  remoteError?: CompactFailure
  /**
   * Full local-summary markdown when the blocking summarizer ran
   * (`local` mode with a live model). Absent for tail / remote / stub
   * compacts. Surfaced in `/compact` notices so the user sees what the
   * checkpoint kept.
   */
  summaryText?: string
  /**
   * When `local` mode fell back to the stub checkpoint because the summary
   * call failed or the model was unknown, the facts of the cause (rows c7,
   * c8, c9). Absent on success and on intentional stub compacts.
   */
  summaryError?: CompactFailure
  /**
   * Full checkpoint user-message markdown as persisted (marker + headings
   * + summary). Authoritative display artifact. Prefer this over
   * summaryText alone.
   */
  checkpointText?: string
}

/**
 * Why a compaction fell back to the stub checkpoint (rows c7, c8, c9).
 *
 * - `send_denied`: the `message.willSend` hook denied the request (`reason`
 *   is the plugin reason, absent when none).
 * - `remote_unavailable`: no `adapter.compact` or no model entry.
 * - `unknown_model`: the model id is not in the registry (`model`).
 * - `empty_summary`: the summary call gave no text.
 * - `request_failed`: the request failed. `error` holds a CoreError (for
 *   example `CompactSendPolicyError`, `CompactSummaryStreamError`), else
 *   `detail` holds the message of a foreign error (absent when empty).
 */
export interface CompactFailure {
  readonly code:
    | "send_denied"
    | "remote_unavailable"
    | "unknown_model"
    | "empty_summary"
    | "request_failed"
  readonly reason?: string
  readonly model?: string
  readonly error?: CoreErrorJson
  readonly detail?: string
}

/** Marker prefix written into model-facing history after a compact. */
export const COMPACTION_USER_MARKER = "<ma::context::compaction"

/**
 * The checkpoint text: the `compaction` tag line (`sb` renders it, design
 * step 7), then the plugin prose when there is any. With no codec, or no
 * `compaction` kind, the tag is `""` and the text is the prose alone.
 */
function checkpointText(
  sb: Pick<SidebandApi, "render">,
  kind: "tail" | "local",
  prose: string,
): string {
  const tag = renderCoreKind(sb, "compaction", { attrs: { kind } })
  return [tag, prose].filter((t) => t !== "").join("\n")
}

/**
 * The checkpoint text block ({@link checkpointText}) with the block mark
 * `sideband: { kind: "compaction" }` (design step 12c). The block holds the
 * `compaction` tag first; with no codec it is the prose alone and keeps the
 * mark (harness text). The mark is metadata only: no encoder sends it.
 */
function checkpointBlock(
  sb: Pick<SidebandApi, "render">,
  kind: "tail" | "local",
  prose: string,
): ContentBlock {
  return { type: "text", text: checkpointText(sb, kind, prose), sideband: { kind: "compaction" } }
}

/** `value` trimmed, or undefined when the trimmed value is empty. */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const t = value?.trim()
  return t ? t : undefined
}

/**
 * The trimmed `focus` fact (absent when blank), shared by
 * `compact.summary_system` and `compact.local_checkpoint`. The plugin owns
 * the text (ma-turn-recovery-plugin).
 */
export function compactFocusFacts(focus?: string): Record<string, string> {
  const f = trimmedOrUndefined(focus)
  return f === undefined ? {} : { focus: f }
}

/**
 * Replace `messages` in place with `next`. Shared by Agent / AgentCore
 * so preflight and compact share one mutation path.
 */
export function replaceMessagesInPlace(messages: Message[], next: Message[]): void {
  messages.length = 0
  for (const m of next) messages.push(m)
}

/**
 * Build the post-compact model-facing history from a portable message
 * list returned by a provider compact call (or local summarizer).
 *
 * Does not re-inject the system *prefix* (that lives outside `messages[]`
 * via resolveSystemPromptForModel). Mid-conversation system rows from
 * the compact output are kept.
 */
export function buildReplacementHistory(
  replacement: Array<{ role: "user" | "assistant" | "system"; content: string }>,
): Message[] {
  return replacement.map((m) => ({
    role: m.role,
    content: [{ type: "text" as const, text: m.content }],
  }))
}

/**
 * Slice the last `keepTail` messages, keeping `tool_use`/`tool_result`
 * pairs atomic on both edges: drop a trailing assistant whose `tool_use`
 * ids have no matching `tool_result` in the tail, and drop a leading
 * user `tool_result` (or leading assistant `tool_use`) whose ids have no
 * match in the tail.
 */
function sliceTail(previous: Message[], keepTail: number): Message[] {
  const tail =
    previous.length <= keepTail ? [...previous] : previous.slice(previous.length - keepTail)
  const toolUseIds = (m: Message): string[] => {
    if (!Array.isArray(m.content)) return []
    const ids: string[] = []
    for (const b of m.content) {
      if (b.type === "tool_use") ids.push(b.id)
    }
    return ids
  }
  const toolResultIds = (m: Message): string[] => {
    if (!Array.isArray(m.content)) return []
    const ids: string[] = []
    for (const b of m.content) {
      if (b.type === "tool_result") ids.push(b.tool_use_id)
    }
    return ids
  }
  const allToolUseIds = (): Set<string> => {
    const ids = new Set<string>()
    for (const m of tail) for (const id of toolUseIds(m)) ids.add(id)
    return ids
  }
  const allToolResultIds = (): Set<string> => {
    const ids = new Set<string>()
    for (const m of tail) for (const id of toolResultIds(m)) ids.add(id)
    return ids
  }
  while (tail.length > 0) {
    const last = tail[tail.length - 1]
    if (last.role !== "assistant") break
    const ids = toolUseIds(last)
    if (ids.length === 0) break
    if (ids.every((id) => allToolResultIds().has(id))) break
    tail.pop()
  }
  while (tail.length > 0) {
    const first = tail[0]
    if (first.role === "assistant") {
      const ids = toolUseIds(first)
      if (ids.length === 0) break
      if (ids.every((id) => allToolResultIds().has(id))) break
      tail.shift()
      continue
    }
    if (first.role !== "user") break
    const ids = toolResultIds(first)
    if (ids.length === 0) break
    if (ids.every((id) => allToolUseIds().has(id))) break
    tail.shift()
  }
  return tail
}

/**
 * Tail-only rewrite: keep the last N messages verbatim behind a
 * checkpoint marker. Instant, no LLM call. Used for `--mode tail` and
 * offline use. The prose after the tag line is `compact.tail_checkpoint`
 * with `retained` = the ACTUAL tail length after the tool-pair trim (not
 * `keepTail`). No text: the tag line only.
 */
export function buildTailCompactMessages(
  sb: Pick<SidebandApi, "render">,
  previous: Message[],
  keepTail: number = DEFAULT_KEEP_TAIL,
  text: SyntheticTextResolver = EMPTY_SYNTHETIC_TEXT,
): Message[] {
  const tail = sliceTail(previous, keepTail)
  const prose = text.resolve("compact.tail_checkpoint", { retained: tail.length })
  const checkpoint: Message = {
    role: "user",
    content: [checkpointBlock(sb, "tail", prose)],
  }
  return [checkpoint, ...tail]
}

/**
 * Why `/compact` argv was rejected (row c10). Core holds no text: the host
 * renders it from these facts.
 *
 * - `duplicate_mode`: a second mode token (`token`).
 * - `unknown_argument`: a token that is not a mode or a known key (`token`).
 * - `unknown_mode`: `mode=<value>` with an unknown engine (`value`).
 * - `bad_tail`: `tail=<value>` that is not an integer \>= 0 (`value`).
 */
export interface CompactArgsError {
  readonly code: "duplicate_mode" | "unknown_argument" | "unknown_mode" | "bad_tail"
  /** The whole argv token. */
  readonly token: string
  /** The unquoted value of a `key=value` token. */
  readonly value?: string
}

/** Parsed `/compact` argv. `error` is set when argv is rejected. */
export interface ParsedCompactArgs {
  mode?: CompactMode
  keepTail?: number
  focus?: string
  error?: CompactArgsError
}

const COMPACT_MODES: readonly CompactMode[] = ["remote", "tail", "local", "fork"]

/**
 * Parse `/compact` argv: `[mode] [tail=N] [focus="..."]`.
 *
 * - `mode`: positional engine or `mode=<engine>` (default unset: caller
 *   applies `"local"`).
 * - `tail=N` (alias `keep-tail=N`): trailing messages kept verbatim
 *   (default unset: caller applies `DEFAULT_KEEP_TAIL`). Must be an
 *   integer \>= 0.
 * - `focus="..."`: hint passed to the summarizer, kept verbatim.
 * - `reason=<trigger>` is accepted and ignored (manual path hardcodes it).
 */
export function parseCompactArgs(argv: string): ParsedCompactArgs {
  const out: ParsedCompactArgs = {}
  const tokens = tokenizeCompactArgs(argv.trim())
  for (const token of tokens) {
    const eq = token.indexOf("=")
    if (eq === -1) {
      const lower = token.toLowerCase()
      if ((COMPACT_MODES as readonly string[]).includes(lower)) {
        if (out.mode !== undefined) return { error: { code: "duplicate_mode", token } }
        out.mode = lower as CompactMode
        continue
      }
      return { error: { code: "unknown_argument", token } }
    }
    const key = token.slice(0, eq).toLowerCase()
    const raw = unquoteCompactValue(token.slice(eq + 1))
    if (key === "mode") {
      const lower = raw.toLowerCase()
      if (!(COMPACT_MODES as readonly string[]).includes(lower)) {
        return { error: { code: "unknown_mode", token, value: raw } }
      }
      if (out.mode !== undefined) return { error: { code: "duplicate_mode", token } }
      out.mode = lower as CompactMode
    } else if (key === "tail" || key === "keep-tail") {
      if (!/^\d+$/.test(raw)) {
        return { error: { code: "bad_tail", token, value: raw } }
      }
      out.keepTail = Number.parseInt(raw, 10)
    } else if (key === "focus") {
      out.focus = raw
    } else if (key === "reason") {
      continue
    } else {
      return { error: { code: "unknown_argument", token } }
    }
  }
  return out
}

/** Split argv on whitespace, honoring double quotes (kept, stripped later). */
function tokenizeCompactArgs(argv: string): string[] {
  if (argv === "") return []
  const tokens: string[] = []
  let cur = ""
  let quote: string | null = null
  for (const ch of argv) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === " " || ch === "\t" || ch === "\n") {
      if (cur !== "") {
        tokens.push(cur)
        cur = ""
      }
    } else {
      cur += ch
    }
  }
  if (cur !== "") tokens.push(cur)
  return tokens
}

/** Strip one pair of matching outer quotes. */
function unquoteCompactValue(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0]
    const last = raw[raw.length - 1]
    if ((first === '"' || first === "'") && last === first) return raw.slice(1, -1)
  }
  return raw
}

/**
 * Local fallback when remote compact is unavailable: keep a short tail
 * of recent turns and prepend a checkpoint user message. The prose after
 * the tag line is `compact.local_checkpoint` with `summary` (the model
 * summary, trimmed; absent when blank, so the plugin uses its stub) and
 * `focus` (trimmed; absent when blank). No text: the tag line only.
 */
export function buildLocalCompactMessages(
  sb: Pick<SidebandApi, "render">,
  opts: {
    previous: Message[]
    summaryText?: string
    /** How many trailing messages to retain (default 6). */
    keepTail?: number
    /** Hint kept verbatim in the checkpoint (default none). */
    focus?: string
    /** Synthetic text resolver (default: the empty resolver). */
    text?: SyntheticTextResolver
  },
): Message[] {
  const tail = sliceTail(opts.previous, opts.keepTail ?? DEFAULT_KEEP_TAIL)
  const summary = trimmedOrUndefined(opts.summaryText)
  const facts = compactFocusFacts(opts.focus)
  if (summary !== undefined) facts.summary = summary
  const prose = (opts.text ?? EMPTY_SYNTHETIC_TEXT).resolve("compact.local_checkpoint", facts)
  const checkpoint: Message = {
    role: "user",
    content: [checkpointBlock(sb, "local", prose)],
  }
  return [checkpoint, ...tail]
}

/**
 * Extract the last pending plain user text (no tool_result) for re-queue
 * after a compact+retry. Returns null when the tail is not a plain user
 * turn (e.g. mid tool loop).
 */
export function extractPendingUserText(messages: Message[]): string | null {
  if (messages.length === 0) return null
  const last = messages[messages.length - 1]
  if (last.role !== "user") return null
  if (Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result")) {
    return null
  }
  if (typeof last.content === "string") return last.content
  if (!Array.isArray(last.content)) return null
  const parts = last.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
  const text = parts.join("\n").trim()
  return text.length > 0 ? text : null
}

/**
 * Rough char budget for local summary input: stringify recent messages
 * into a single user blob the summarizer model can read.
 */
export function flattenHistoryForSummary(messages: Message[], maxChars = 120_000): string {
  const chunks: string[] = []
  let total = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const body =
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((b) => {
              if (b.type === "text") return b.text
              if (b.type === "tool_use") return `[tool_use ${b.name}]`
              if (b.type === "tool_result") {
                const c =
                  typeof b.content === "string"
                    ? b.content
                    : b.content.map((x) => (x.type === "text" ? x.text : "")).join("")
                return `[tool_result ${c.slice(0, 500)}]`
              }
              if (b.type === "thinking") return `[thinking]`
              return `[${b.type}]`
            })
            .join("\n")
    const piece = `${m.role.toUpperCase()}:\n${body}\n\n`
    if (total + piece.length > maxChars) break
    chunks.push(piece)
    total += piece.length
  }
  chunks.reverse()
  return chunks.join("")
}
