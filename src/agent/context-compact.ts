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

import type { Message } from "../llm/messages.ts"

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
   * unavailable, the short reason (HTTP error, missing adapter, …).
   * Surfaced in `/compact` notices so a silent local fallback is visible.
   */
  remoteError?: string
}

/** Marker prefix written into model-facing history after a compact. */
export const COMPACTION_USER_MARKER = "<ma::context::compaction"

/**
 * Local summarization prompt (provider-neutral handoff intent). Structured
 * template from MA-427402 DESIGN-prompt: 7 headings, text-only tool ban,
 * verbatim constraints, files+snippets, pending, next step. Sent as the
 * system prompt of the blocking local summary call.
 */
export const LOCAL_COMPACTION_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff",
  "summary for another LLM that will resume the task.",
  "",
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
  "Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.",
  "You have all context in the conversation above. Tool calls are REJECTED.",
  "Reply with ONLY the summary body (no preamble).",
  "Respond in the same language as the conversation.",
  "Do NOT continue the task. Do NOT answer open questions. Only summarize.",
  "",
  "Use exactly these 7 headings:",
  "",
  "## 1. Goal",
  "One or two lines on user intent. Primary request first.",
  "",
  "## 2. Constraints (verbatim)",
  "Copy user constraints and security rules word for word.",
  "Never paraphrase this section.",
  "",
  "## 3. Decisions",
  "Each choice plus one-line reason. Drop superseded drafts.",
  "",
  "## 4. Files and snippets",
  "Exact paths touched plus one line per change.",
  "Keep exact commands, IDs, error text still needed. Drop full logs.",
  "",
  "## 5. Errors and fixes",
  "What broke, what fixed it, what is still broken.",
  "",
  "## 6. Pending tasks",
  "What remains, next action first. Preserve any unanswered",
  "user question or imperative request verbatim.",
  "",
  "## 7. Next step",
  "The single action the next session takes first.",
].join("\n")

/**
 * System prompt for a local summary call, with an optional focus hint kept
 * verbatim so the next session sees what the user cared about.
 */
export function buildLocalSummarySystemPrompt(focus?: string): string {
  const trimmed = focus?.trim()
  if (!trimmed) return LOCAL_COMPACTION_PROMPT
  return `${LOCAL_COMPACTION_PROMPT}\n\nFocus for this compaction (verbatim): ${trimmed}`
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
 * checkpoint marker. Instant, no LLM call. Used for `--mode tail`,
 * offline use, or as the stub fallback when the summarizer fails.
 */
export function buildTailCompactMessages(
  previous: Message[],
  keepTail: number = DEFAULT_KEEP_TAIL,
): Message[] {
  const tail = sliceTail(previous, keepTail)
  const checkpoint: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `${COMPACTION_USER_MARKER} kind="tail" />\n## Context checkpoint\n\nRetained last ${tail.length} message(s) verbatim. Older history was dropped.`,
      },
    ],
  }
  return [checkpoint, ...tail]
}

/** Parsed `/compact` argv. `error` is set when argv is rejected. */
export interface ParsedCompactArgs {
  mode?: CompactMode
  keepTail?: number
  focus?: string
  error?: string
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
        if (out.mode !== undefined) return { error: `/compact: duplicate mode ("${token}")` }
        out.mode = lower as CompactMode
        continue
      }
      return { error: `/compact: unknown argument "${token}" (want [mode] [tail=N] [focus="..."])` }
    }
    const key = token.slice(0, eq).toLowerCase()
    const raw = unquoteCompactValue(token.slice(eq + 1))
    if (key === "mode") {
      const lower = raw.toLowerCase()
      if (!(COMPACT_MODES as readonly string[]).includes(lower)) {
        return { error: `/compact: unknown mode "${raw}" (want remote|tail|local|fork)` }
      }
      if (out.mode !== undefined) return { error: `/compact: duplicate mode ("${token}")` }
      out.mode = lower as CompactMode
    } else if (key === "tail" || key === "keep-tail") {
      if (!/^\d+$/.test(raw)) {
        return { error: `/compact: tail must be an integer >= 0 (got "${raw}")` }
      }
      out.keepTail = Number.parseInt(raw, 10)
    } else if (key === "focus") {
      out.focus = raw
    } else if (key === "reason") {
      continue
    } else {
      return { error: `/compact: unknown argument "${token}" (want [mode] [tail=N] [focus="..."])` }
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
 * of recent turns and prepend a checkpoint user message. Prefer a real
 * model summary (caller supplies `summaryText`) over the generic stub.
 * `focus` is kept verbatim in the checkpoint when set.
 */
export function buildLocalCompactMessages(opts: {
  previous: Message[]
  summaryText?: string
  /** How many trailing messages to retain (default 6). */
  keepTail?: number
  /** Hint kept verbatim in the checkpoint (default none). */
  focus?: string
}): Message[] {
  const tail = sliceTail(opts.previous, opts.keepTail ?? DEFAULT_KEEP_TAIL)
  const summary =
    opts.summaryText?.trim() ||
    "Prior conversation was compacted locally. Continue from the retained recent turns below."
  const focusLine = opts.focus?.trim() ? `\nFocus (verbatim): ${opts.focus.trim()}\n` : ""

  const checkpoint: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `${COMPACTION_USER_MARKER} kind="local" />\n## Context checkpoint\n${focusLine}\n${summary}`,
      },
    ],
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
