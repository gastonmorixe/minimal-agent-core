/**
 * The `SessionPersistence` port over a real {@link SessionStore} (spec v2
 * section 2.3, S47).
 *
 * Unlike the CLI's `SessionPersistenceAdapter`
 * (`src/adapters/session-persistence-adapter.ts`), this adapter
 * does NOT no-op `appendToolResult`: the CLI's tool executor persists tool
 * results itself (with the raw-blob pointer its bare
 * `ToolResultBlock` cannot carry), so the CLI's session-persistence adapter
 * would double-write if it also persisted them. A runtime session with no
 * caller-supplied `toolExecutor` runs no tools (`./noop-tools.ts`) and has
 * no second writer, so this adapter is the only persister and writes every
 * record straight through.
 *
 * @module runtime/session-persistence-store
 */

import type { ContentBlock, ToolResultBlock } from "../llm/messages.ts"
import type { SessionPersistence } from "../sdk/ports.ts"
import {
  blockOutcomeOf,
  outcomeTextOf,
  validatePersistedToolOutcome,
} from "../sdk/tool-outcome-record.ts"
import type { SessionStore } from "../session/session-store.ts"

/** A {@link SessionPersistence} that writes every record straight through to `store`. */
export class SessionStorePersistence implements SessionPersistence {
  constructor(private readonly store: SessionStore) {}

  appendUser(content: string | ContentBlock[]): string {
    return this.store.appendUser(content)
  }

  appendAssistant(
    content: ContentBlock[],
    stopReason: string | null,
    usage?: { input_tokens?: number; output_tokens?: number },
    meta?: { providerMessageId?: string },
  ): void {
    this.store.appendAssistant(content, stopReason, usage, undefined, meta)
  }

  /**
   * Write the tool result. The record gets the outcome that `runToolCalls`
   * registered for this block through the core-internal channel
   * (`withBlockOutcome`), checked again against the block content (SPEC v6.1
   * D8 rule 8, review W2 M2). So the live block and the restored block hold
   * the same value. An `outcome` key on the block itself is never read (F18).
   */
  appendToolResult(
    result: ToolResultBlock,
    rawBlob?: { path: string; bytes: number; sha256: string },
  ): void {
    const registered = blockOutcomeOf(result)
    const outcome =
      registered === undefined
        ? undefined
        : validatePersistedToolOutcome(registered, outcomeTextOf(result.content))
    this.store.appendToolResult(result, new Date(), rawBlob, outcome)
  }

  appendNote(text: string): void {
    this.store.appendNote(text)
  }

  appendRewind(toMsgId: string, droppedCount: number): void {
    this.store.appendRewind(toMsgId, droppedCount)
  }

  appendCompact(rec: Parameters<NonNullable<SessionPersistence["appendCompact"]>>[0]): void {
    this.store.appendCompact(rec)
  }

  appendRoundCheckpoint(
    checkpoint: Parameters<NonNullable<SessionPersistence["appendRoundCheckpoint"]>>[0],
  ): void {
    this.store.appendRoundCheckpoint({
      round: checkpoint.round,
      maxTokensStreak: checkpoint.streaks.maxTokens,
      interruptedStreak: checkpoint.streaks.interrupted,
    })
  }

  appendTargetSwitch(
    target: Parameters<NonNullable<SessionPersistence["appendTargetSwitch"]>>[0],
  ): void {
    this.store.appendTargetSwitch(target)
  }
}
