/**
 * Compact / replaceMessages methods for {@link Agent}, kept out of agent.ts
 * to stay under the max-lines budget.
 *
 * @module agent/agent-compact-methods
 */

import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../llm/messages.ts"
import type { NetworkClient } from "../network/index.ts"
import { type LifecyclePort, NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import type { SessionStore } from "../session/session-store.ts"
import type { SidebandApi } from "../sideband/types.ts"

import type { CompactRequestOpts, CompactStats } from "./context-compact.ts"
import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "./synthetic-text.ts"

/** Minimal Agent surface needed for compact. */
export interface CompactableAgent {
  messages: Message[]
  model: string
  providerId?: string
  auth: AuthResult
  /** Named credential pin used by the live send path. */
  credentialName?: string
  networkClient?: NetworkClient
  appendNote(text: string): void
  store: SessionStore | null
  /** Send policy port: compact requests pass `message.willSend` (item 8). */
  lifecycle?: LifecyclePort
  /** Synthetic text resolver for the compaction texts (15d.3a). Absent: the empty resolver. */
  text?: SyntheticTextResolver
  /** Sideband API for the checkpoint tag (design step 7). Absent: none. */
  sideband?: SidebandApi
}

/** Replace model-facing history in place (compaction / preflight). */
export function agentReplaceMessages(agent: CompactableAgent, next: Message[]): void {
  agent.messages.length = 0
  for (const m of next) agent.messages.push(m)
}

/** Compact history via shared `runCompact` runner. */
export async function agentCompact(
  agent: CompactableAgent,
  opts?: CompactRequestOpts,
): Promise<CompactStats> {
  const { runCompact } = await import("./run-compact.ts")
  return runCompact({
    messages: agent.messages,
    model: agent.model,
    providerId: agent.providerId,
    auth: agent.auth,
    ...(agent.credentialName ? { credentialName: agent.credentialName } : {}),
    networkClient: agent.networkClient,
    reason: opts?.reason ?? "manual",
    preferRemote: opts?.preferRemote,
    ...(opts?.mode ? { mode: opts.mode } : {}),
    ...(opts?.keepTail !== undefined ? { keepTail: opts.keepTail } : {}),
    ...(opts?.focus ? { focus: opts.focus } : {}),
    ...(opts?.signal ? { signal: opts.signal } : {}),
    ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts?.writeStream ? { writeStream: opts.writeStream } : {}),
    ...(opts?.onSummaryAttempt ? { onSummaryAttempt: opts.onSummaryAttempt } : {}),
    text: agent.text ?? EMPTY_SYNTHETIC_TEXT,
    ...(agent.sideband ? { sideband: agent.sideband } : {}),
    appendNote: (t) => agent.appendNote(t),
    appendCompact: (r) => agent.store?.appendCompact(r),
    // Required by runCompact: an agent with no port sends through the no-op.
    lifecycle: agent.lifecycle ?? NOOP_LIFECYCLE,
  })
}
