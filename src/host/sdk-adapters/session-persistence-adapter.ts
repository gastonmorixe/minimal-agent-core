/**
 * Host adapter: bind the append-only {@link SessionStore} to the SDK
 * {@link SessionPersistence} port.
 *
 * {@link AgentCore} calls this port at turn boundaries (user submit, assistant
 * turn complete, tool result, notes, rewind markers) so a `--json` run is
 * resumable exactly like the legacy `Agent`.
 *
 * ### Tool-result persistence is owned elsewhere (no double write)
 *
 * `executeToolRound` — reused verbatim by the {@link ToolExecutorAdapter} —
 * ALREADY persists each tool_result via its own `ctx.store` reference, and it
 * does so with full fidelity: the raw-output blob pointer (`rawPath` / bytes /
 * sha256) and the presentation overrides (`display` / `displayHeader` /
 * `displayFooter`) that a resume needs to recreate a plugin tool's custom
 * render without re-executing it. AgentCore's port call, by contrast, only
 * knows the bare `ToolResultBlock`. If BOTH wrote, every tool result would be
 * persisted twice — once rich, once bare — corrupting replay.
 *
 * So this adapter's {@link SessionPersistenceAdapter.appendToolResult} is a
 * deliberate NO-OP: the executor adapter is the sole persister of tool_result
 * records. Everything else (user / assistant / note / rewind) is a
 * straight-through delegate to the store.
 *
 * @module host/sdk-adapters/session-persistence-adapter
 */

import type { ContentBlock, ToolResultBlock } from "../../llm/messages.ts"
import type { SessionPersistence } from "../../sdk/ports.ts"
import type { SessionStore } from "../../session/session-store.ts"

/**
 * A {@link SessionPersistence} over a {@link SessionStore}.
 *
 * User / assistant / note / rewind records delegate straight to the store.
 * Tool-result records are intentionally NOT persisted here — the
 * {@link ToolExecutorAdapter}'s `executeToolRound` call owns that write with
 * blob + presentation fidelity. See the module doc.
 */
export class SessionPersistenceAdapter implements SessionPersistence {
  constructor(private readonly store: SessionStore) {}

  /** Append a user prompt record. Returns the store-generated message id. */
  appendUser(content: string | ContentBlock[]): string {
    return this.store.appendUser(content)
  }

  /** Append a completed assistant turn (content + stop reason + usage). */
  appendAssistant(
    content: ContentBlock[],
    stopReason: string | null,
    usage?: { input_tokens?: number; output_tokens?: number },
  ): void {
    this.store.appendAssistant(content, stopReason, usage)
  }

  /**
   * NO-OP by design. Tool-result persistence is owned by the
   * {@link ToolExecutorAdapter} (via `executeToolRound`'s own `ctx.store`
   * write), which records the raw-blob pointer and presentation overrides
   * this bare-block signature cannot carry. Writing here too would duplicate
   * every tool result on disk. Parameters are accepted to satisfy the port
   * but ignored. See the module doc.
   */
  appendToolResult(
    _result: ToolResultBlock,
    _rawBlob?: { path: string; bytes: number; sha256: string },
    _presentation?: { display?: string; displayHeader?: string; displayFooter?: string },
  ): void {
    // Intentionally empty — see module doc ("no double write").
  }

  /** Append a free-form note record. */
  appendNote(text: string): void {
    this.store.appendNote(text)
  }

  /** Append a rewind marker record. */
  appendRewind(toMsgId: string, droppedCount: number): void {
    this.store.appendRewind(toMsgId, droppedCount)
  }
}
