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
 * Local summarization prompt (provider-neutral handoff intent). Used when the
 * provider has no remote compact endpoint.
 */
export const LOCAL_COMPACTION_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff",
  "summary for another LLM that will resume the task.",
  "",
  "Include:",
  "- Current progress and key decisions made",
  "- Important context, constraints, or user preferences",
  "- What remains to be done (clear next steps)",
  "- Any critical data, examples, or references needed to continue",
  "",
  "Be concise, structured, and focused on helping the next LLM seamlessly",
  "continue the work. Reply with ONLY the summary body (no preamble).",
].join("\n")

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
 * Local fallback when remote compact is unavailable: keep a short tail
 * of recent turns and prepend a checkpoint user message. Prefer a real
 * model summary (caller supplies `summaryText`) over the generic stub.
 */
export function buildLocalCompactMessages(opts: {
  previous: Message[]
  summaryText?: string
  /** How many trailing messages to retain (default 6). */
  keepTail?: number
}): Message[] {
  const keepTail = opts.keepTail ?? 6
  const tail =
    opts.previous.length <= keepTail
      ? [...opts.previous]
      : opts.previous.slice(opts.previous.length - keepTail)

  // Never start the tail mid tool_use without its tool_result: drop a
  // leading assistant that still has unpaired tool_use if the next
  // message is not a tool_result user turn.
  while (tail.length > 0 && tail[0].role === "assistant") {
    const first = tail[0]
    const hasToolUse =
      Array.isArray(first.content) && first.content.some((b) => b.type === "tool_use")
    if (!hasToolUse) break
    const next = tail[1]
    const nextHasResult =
      next && Array.isArray(next.content) && next.content.some((b) => b.type === "tool_result")
    if (nextHasResult) break
    tail.shift()
  }

  const summary =
    opts.summaryText?.trim() ||
    "Prior conversation was compacted locally. Continue from the retained recent turns below."

  const checkpoint: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `${COMPACTION_USER_MARKER} kind="local" />\n## Context checkpoint\n\n${summary}`,
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
