/**
 * Stream block tracker: one pure fold over canonical events that answers
 * "what is the model doing right now?" for a single attempt.
 *
 * Two consumers read it, so they can never disagree again:
 *
 * - the **watchdog** (`watchdog.ts`) picks its idle budget from
 *   {@link StreamBlockTracker.isSilentBlockOpen}: a thinking block (thinking
 *   display omitted sends no bytes until the signature) or a tool-input block
 *   (large inputs can arrive in one late burst) may stay silent for a long
 *   time while the model is healthy;
 * - the **status activity** (`canonical-send.ts`) publishes
 *   {@link StreamBlockState} on the live status, so a host can tell
 *   "thinking for 30s" from "stalled for 30s".
 *
 * Provider-neutral and host-neutral: it sees canonical events only and
 * produces data (phase codes, tool name, epoch-ms timestamps), never labels.
 *
 * Research: `research/2026-11-15-stream-stall-10404ddc/REPORT.md`.
 *
 * @module llm/transport/stream-block-tracker
 */

import type { ActivityPhase } from "../../bus/status.ts"
import type { CanonicalEvent } from "../canonical-events.ts"

/** The {@link ActivityPhase} values a model stream moves through. */
export type StreamActivityPhase = Extract<
  ActivityPhase,
  "stream" | "thinking" | "writing" | "tool-input"
>

/** Snapshot of the tracker. All times are epoch ms from the injected clock. */
export interface StreamBlockState {
  /** `undefined` until the first event of the attempt. */
  phase: StreamActivityPhase | undefined
  /** When {@link phase} last changed. */
  phaseStartedAt: number | undefined
  /** The tool whose input streams, while `phase` is `tool-input`. */
  toolName: string | undefined
  /** The last non-ping event. */
  lastContentAt: number | undefined
}

type OpenBlock = { phase: Exclude<StreamActivityPhase, "stream">; toolName?: string }

/**
 * Fold canonical events into the current block phase.
 *
 * Blocks are keyed by their `index`, so a provider that interleaves blocks
 * (or a stop that arrives out of order) still leaves a correct answer: the
 * current phase is the most recently opened block that is still open, else
 * `stream`.
 */
export class StreamBlockTracker {
  private readonly open = new Map<number, OpenBlock>()
  private state: StreamBlockState = {
    phase: undefined,
    phaseStartedAt: undefined,
    toolName: undefined,
    lastContentAt: undefined,
  }

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Feed one event.
   *
   * @returns `true` when the phase or tool name changed (the caller should
   *   publish right away), `false` when only {@link StreamBlockState.lastContentAt} moved.
   */
  observe(ev: CanonicalEvent): boolean {
    const t = this.now()
    if (ev.type !== "ping") this.state.lastContentAt = t
    switch (ev.type) {
      case "thinking_start":
        this.open.set(ev.index, { phase: "thinking" })
        break
      case "text_start":
        this.open.set(ev.index, { phase: "writing" })
        break
      case "tool_use_start":
        this.open.set(ev.index, { phase: "tool-input", toolName: ev.name })
        break
      case "thinking_stop":
      case "text_stop":
      case "tool_use_stop":
        this.open.delete(ev.index)
        break
      case "message_stop":
        this.open.clear()
        break
      default:
        break
    }
    return this.settle(t)
  }

  /** The current state (a copy). */
  snapshot(): StreamBlockState {
    return { ...this.state }
  }

  /**
   * True while a block that may legitimately go silent is open: a thinking
   * block, or a tool call whose input is still streaming.
   */
  isSilentBlockOpen(): boolean {
    for (const b of this.open.values()) {
      if (b.phase === "thinking" || b.phase === "tool-input") return true
    }
    return false
  }

  private settle(t: number): boolean {
    let top: OpenBlock | undefined
    for (const b of this.open.values()) top = b // Map keeps insertion order: last = newest.
    const phase: StreamActivityPhase = top?.phase ?? "stream"
    const toolName = top?.toolName
    if (phase === this.state.phase && toolName === this.state.toolName) return false
    this.state.phase = phase
    this.state.toolName = toolName
    this.state.phaseStartedAt = t
    return true
  }
}
