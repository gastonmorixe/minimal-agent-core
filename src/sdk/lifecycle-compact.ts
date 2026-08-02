/**
 * Shared compact-with-lifecycle helper for AgentCore and legacy Agent.
 *
 * @module sdk/lifecycle-compact
 */

import type { CompactReason, CompactStats } from "../agent/context-compact.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../llm/messages.ts"
import type { NetworkClient } from "../network/index.ts"

import { isDenied, type LifecyclePort } from "./lifecycle.ts"

export interface CompactWithLifecycleInput {
  messages: Message[]
  model: string
  providerId?: string
  auth: AuthResult
  credentialName?: string
  networkClient?: NetworkClient
  lifecycle: LifecyclePort
  reason?: CompactReason
  preferRemote?: boolean
  appendNote?: (text: string) => void
  appendCompact?: (rec: {
    reason: CompactReason
    compactKind: "remote" | "local"
    messagesBefore: number
    messagesAfter: number
    replacementMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>
  }) => void
}

/** Run beforeCompact → runCompact → afterCompact. Throws on deny. */
export async function compactWithLifecycle(
  input: CompactWithLifecycleInput,
): Promise<CompactStats> {
  const reason = input.reason ?? "manual"
  if (input.lifecycle.beforeCompact) {
    const will = await input.lifecycle.beforeCompact({
      reason,
      preferRemote: input.preferRemote,
      messagesBefore: input.messages.length,
    })
    if (isDenied(will)) {
      throw new Error(
        will.action === "deny" || will.action === "ask"
          ? will.reason
          : "Compact blocked by lifecycle policy hook.",
      )
    }
  }
  const { runCompact } = await import("../agent/run-compact.ts")
  const stats = await runCompact({
    messages: input.messages,
    model: input.model,
    providerId: input.providerId,
    auth: input.auth,
    ...(input.credentialName ? { credentialName: input.credentialName } : {}),
    networkClient: input.networkClient,
    reason,
    preferRemote: input.preferRemote,
    appendNote: input.appendNote,
    appendCompact: input.appendCompact,
  })
  await input.lifecycle.afterCompact?.({
    reason: stats.reason,
    messagesBefore: stats.messagesBefore,
    messagesAfter: stats.messagesAfter,
    compactKind: stats.kind,
  })
  return stats
}
