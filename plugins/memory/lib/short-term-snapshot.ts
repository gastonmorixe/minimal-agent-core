/**
 * Per-turn `<ma::agent::short-term-memory>` attachment producer.
 *
 * The agent's session-scoped scratchpad is stored at
 * `~/.minimal-agent/sessions/<sid>.scratch.md` (see
 * {@link MemoryStore.shortTerm}). To make the contents reliably present
 * in the model's context every turn — without busting the system-prompt
 * cache — we prepend a `<ma::agent::short-term-memory>…</ma::agent::short-term-memory>`
 * attachment to the FIRST user message of each `Agent.run` call.
 *
 * This sits behind the rolling-tail cache breakpoint (which is
 * invalidated every turn anyway by the user message changing), so the
 * snapshot costs zero extra cache invalidation. Same shape as the
 * `<mode-change>` and `<ma::agent::memory-saved>` attachments — the model already
 * has the pattern.
 *
 * Only emitted at the INITIAL user-content seam, not at the loop seam
 * (post tool_use). Reasoning: the model already saw the snapshot at
 * the start of the turn; re-emitting on every tool round would balloon
 * the conversation with stale repeats. Save-echoes (which ARE deltas)
 * still fire at the loop seam.
 *
 * Reads from disk on demand. Files are tiny (≤ {@link SHORT_TERM_CAP}
 * entries × ~80 chars), filesystem cache makes reads ~µs, and reading
 * fresh on every call avoids any stale-snapshot bug after an external
 * mutation (CLI edit, another process — though there's only one
 * writer per session).
 *
 * @module memory/lib/short-term-snapshot
 */

import { type AttachmentTextBlock } from "./save-echo.ts"
import { MemoryStore, type StoreDeps } from "./store.ts"

/**
 * Per-session short-term snapshot producer.
 *
 * Construct one per agent. Holds the session id and lazily reads the
 * scratch file on each {@link toAttachment} call. When the session id
 * is `null` (e.g. ad-hoc test, no session plumbed through), every call
 * returns `null` — the agent simply doesn't emit the attachment.
 */
export class ShortTermSnapshot {
  constructor(
    public readonly sid: string | null,
    private readonly deps: StoreDeps = {},
  ) {}

  /**
   * Read the current short-term scratch and render the attachment.
   * Returns `null` when the file is missing/empty or no sid is set,
   * so the agent can append unconditionally:
   *
   *     const att = snapshot.toAttachment()
   *     if (att) userContent.push(att)
   */
  toAttachment(): AttachmentTextBlock | null {
    if (this.sid === null || this.sid.trim().length === 0) return null

    const store = MemoryStore.shortTerm(this.sid, this.deps)
    const bullets = store.list()
    if (bullets.length === 0) return null

    // Render: one line per bullet as `[#<id>] <body>`. We do NOT include
    // the timestamp or session id — those are file metadata, not part
    // of the working content. The model can call MemoryTool to inspect
    // them if it ever needs to.
    const lines = bullets.map((b) => `[#${b.id}] ${b.body}`)
    return {
      type: "text",
      text: `<ma::agent::short-term-memory>\n${lines.join("\n")}\n</ma::agent::short-term-memory>`,
    }
  }

  /**
   * Convenience: returns just the rendered text (or `null`). Used by
   * tests that want to assert on string shape without unwrapping a
   * ContentBlock.
   */
  toText(): string | null {
    const a = this.toAttachment()
    return a?.type === "text" ? a.text : null
  }
}
