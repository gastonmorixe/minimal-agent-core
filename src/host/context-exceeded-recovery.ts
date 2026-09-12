/**
 * Shared recovery for `context_length_exceeded` on both the live-area and
 * legacy REPL paths. Keeps Agent / AgentCore compact wiring in one place.
 *
 * @module host/context-exceeded-recovery
 */

import { type CompactRequestOpts, extractPendingUserText } from "../agent/context-compact.ts"
import type { Message } from "../llm/messages.ts"

import {
  contextLengthExceededAdvice,
  isAutoCompactOnExceededEnabled,
  parseContextLengthExceededError,
} from "./model-error.ts"

/** Minimal agent surface the recovery path needs. */
export interface CompactableAgent {
  getModel?(): string
  rollbackPendingTurn?(): boolean
  compact?(opts?: CompactRequestOpts): Promise<{
    kind: "remote" | "local"
    messagesBefore: number
    messagesAfter: number
  }>
  history?(): Message[]
  /** Messages array when history() is absent (legacy Agent). */
  messages?: Message[]
}

export interface ContextExceededRecoveryResult {
  /** True when auto-compact ran and a retry prompt should be re-queued. */
  shouldRetry: boolean
  /** User text to re-submit after compact (if shouldRetry). */
  retryText: string | null
  /** Lines to print to the user (already plain text, no ANSI). */
  notices: string[]
}

/** Live-output hooks forwarded to the auto-compact call (TUI only). */
export interface ContextExceededCompactHooks {
  /** Raw sink for the streamed local summary. */
  writeStream?: (chunk: string) => void
  /** Progress reporter for the streaming summary. */
  onProgress?: (delta: { deltaTokens: number }) => void
  /** Called at the start of each summary attempt (1-based). */
  onSummaryAttempt?: (attempt: number) => void | Promise<void>
}

/**
 * Handle a turn failure that may be a context-window exceed.
 *
 * - Non-context errors → no-op recovery (caller still shows the error).
 * - Context exceed + auto-compact off → advice only, rollback left to caller.
 * - Context exceed + auto-compact on + agent.compact → compact once, return
 *   retryText for the host to re-run.
 *
 * Does NOT call rollback itself when auto-compact succeeds (history is
 * rewritten wholesale). When auto-compact is skipped/fails, caller should
 * still rollbackPendingTurn as today.
 *
 * @param agent - Agent surface with the optional `compact` entry point.
 * @param errMsg - Error message from the failed turn.
 * @param hooks - Optional live-output sinks for the auto-compact stream.
 */
export async function tryRecoverContextExceeded(
  agent: CompactableAgent,
  errMsg: string,
  hooks: ContextExceededCompactHooks = {},
): Promise<ContextExceededRecoveryResult> {
  if (!parseContextLengthExceededError(errMsg)) {
    return { shouldRetry: false, retryText: null, notices: [] }
  }

  const advice = contextLengthExceededAdvice(agent.getModel?.())
  if (!isAutoCompactOnExceededEnabled() || typeof agent.compact !== "function") {
    return {
      shouldRetry: false,
      retryText: null,
      notices: [advice],
    }
  }

  // Capture pending user text before compact rewrites history.
  const msgs: Message[] =
    typeof agent.history === "function"
      ? agent.history()
      : Array.isArray(agent.messages)
        ? agent.messages
        : []
  const pending = extractPendingUserText(msgs)

  try {
    const stats = await agent.compact({
      reason: "exceeded",
      ...(hooks.writeStream ? { writeStream: hooks.writeStream } : {}),
      ...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
      ...(hooks.onSummaryAttempt ? { onSummaryAttempt: hooks.onSummaryAttempt } : {}),
    })
    const notices = [
      `Auto-compacted context (${stats.kind}): ${stats.messagesBefore} → ${stats.messagesAfter} messages.`,
    ]
    if (pending) {
      notices.push("Retrying the failed user turn once…")
      return { shouldRetry: true, retryText: pending, notices }
    }
    notices.push(advice)
    return { shouldRetry: false, retryText: null, notices }
  } catch (compactErr) {
    const cmsg = compactErr instanceof Error ? compactErr.message : String(compactErr)
    return {
      shouldRetry: false,
      retryText: null,
      notices: [`Auto-compact failed: ${cmsg}`, advice],
    }
  }
}
