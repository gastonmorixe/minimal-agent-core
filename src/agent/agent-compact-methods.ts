/**
 * Compact / replaceMessages methods for {@link Agent}, kept out of agent.ts
 * to stay under the max-lines budget.
 *
 * @module agent/agent-compact-methods
 */

import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../llm/messages.ts"
import type { NetworkClient } from "../network/index.ts"
import type { SessionStore } from "../session/session-store.ts"

import type { CompactStats } from "./context-compact.ts"

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
}

/** Replace model-facing history in place (compaction / preflight). */
export function agentReplaceMessages(agent: CompactableAgent, next: Message[]): void {
  agent.messages.length = 0
  for (const m of next) agent.messages.push(m)
}

/** Compact history via shared `runCompact` runner. */
export async function agentCompact(
  agent: CompactableAgent,
  opts?: { reason?: "manual" | "auto" | "exceeded"; preferRemote?: boolean },
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
    appendNote: (t) => agent.appendNote(t),
    appendCompact: (r) => agent.store?.appendCompact(r),
  })
}
