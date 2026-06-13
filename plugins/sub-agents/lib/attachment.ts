/**
 * Per-turn `<ma::agent::subagents>` attachment producer.
 *
 * Prepended to the first user message each turn (behind the rolling-tail cache
 * breakpoint, like the `tasks` and short-term-memory snapshots — zero extra
 * cache cost). It gives the lead model live awareness of its own fleet EVERY
 * turn, not just the digest it gets when a worker finishes. Bounded + plain
 * text (data the model reads, never a trigger).
 *
 * Emitted only when at least one worker is active (running/queued); an idle
 * fleet contributes nothing, so a session that isn't delegating pays no tokens.
 *
 * @module sub-agents/lib/attachment
 */

import { type StoreDeps, SubagentStore } from "./store.ts"
import { fmtElapsed, fmtTokens } from "./style.ts"
import { fleetStats, isActive, type SubagentRecord } from "./types.ts"

/**
 * LOCAL structural slice of the host's `ContentBlock` union — the text block
 * this producer emits. The host's turn-attachment registry expects
 * `toAttachment(): ContentBlock | null`; a text block satisfies that union
 * structurally, so the real host accepts it without the plugin importing host
 * code (the decoupling contract). Source of truth: `src/client/types.ts`
 * (`TextBlock`).
 */
interface AttachmentTextBlock {
  type: "text"
  text: string
}

const MAX_ROWS = 8

function row(r: SubagentRecord, nowMs: number): string {
  const s = r.status
  let state: string
  switch (s.kind) {
    case "running": {
      const el = fmtElapsed(nowMs - Date.parse(s.startedAt))
      const act = s.progress.lastActivity ?? s.progress.lastTool ?? ""
      state = `running ${el} · ${s.progress.tools} tools · ${fmtTokens(s.progress.tokens)}${act ? ` · ${act}` : ""}`
      break
    }
    case "queued":
      state = "queued"
      break
    case "done":
      state = `done · AgentResult ${r.id}`
      break
    case "incomplete":
      state = `⚠ INCOMPLETE · no deliverable (${s.reason}) · AgentResult ${r.id}`
      break
    case "failed":
      state = `failed · ${s.error}`
      break
    case "stopped":
      state = "stopped"
      break
    default: {
      throw new Error(`unhandled status kind: ${String(s satisfies never)}`)
    }
  }
  return `${r.id.padEnd(4)} ${r.type.padEnd(10)} ${state}`
}

/**
 * Per-session producer. Construct one per lead agent; reads the fleet file on
 * each {@link toAttachment} call. Returns `null` (so the agent can append
 * unconditionally) when there is no session id or no active worker.
 */
export class SubagentsAttachment {
  constructor(
    public readonly sid: string | null,
    private readonly deps: StoreDeps = {},
    private readonly now: () => number = Date.now,
  ) {}

  toAttachment(): AttachmentTextBlock | null {
    if (this.sid === null || this.sid.trim().length === 0) return null
    const records = new SubagentStore(this.sid, this.deps).all()
    const active = records.filter((r) => isActive(r.status))
    if (active.length === 0) return null

    const s = fleetStats(records)
    const nowMs = this.now()
    // Show active workers first, then the most recent terminal ones, capped.
    const terminal = records.filter((r) => !isActive(r.status))
    const shown = [...active, ...terminal].slice(0, MAX_ROWS)
    const body = shown.map((r) => row(r, nowMs)).join("\n")
    const overflow =
      records.length > shown.length ? `\n… +${records.length - shown.length} more (ListAgents)` : ""
    const incompleteAttr = s.incomplete > 0 ? ` incomplete="${s.incomplete}"` : ""
    const text =
      `<ma::agent::subagents active="${s.running + s.queued}" done="${s.done}"${incompleteAttr} failed="${s.failed}" tokens="${fmtTokens(s.tokens)}">\n` +
      `${body}${overflow}\n</ma::agent::subagents>`
    return { type: "text", text }
  }

  /** Convenience for tests: the rendered text, or null. */
  toText(): string | null {
    const a = this.toAttachment()
    return a?.type === "text" ? a.text : null
  }
}
