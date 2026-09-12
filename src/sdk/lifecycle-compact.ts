/**
 * Shared compact-with-lifecycle helper for AgentCore and legacy Agent.
 *
 * @module sdk/lifecycle-compact
 */

import type { CompactReason, CompactRequestOpts, CompactStats } from "../agent/context-compact.ts"
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
  /** Explicit engine. Overrides the `preferRemote` default mapping. */
  mode?: CompactRequestOpts["mode"]
  /** Trailing messages kept verbatim (default 6). Must be \>= 0. */
  keepTail?: number
  /** Hint passed to the summarizer, kept verbatim in the checkpoint. */
  focus?: string
  onProgress?: CompactRequestOpts["onProgress"]
  writeStream?: CompactRequestOpts["writeStream"]
  onSummaryAttempt?: CompactRequestOpts["onSummaryAttempt"]
  appendNote?: (text: string) => void
  appendCompact?: (rec: {
    reason: CompactReason
    compactKind: "remote" | "local"
    messagesBefore: number
    messagesAfter: number
    replacementMessages: Array<{
      role: "user" | "assistant" | "system"
      content: string | import("../llm/messages.ts").ContentBlock[]
    }>
  }) => void
}

/** Run beforeCompact → runCompact → afterCompact. Throws on deny. */
export async function compactWithLifecycle(
  input: CompactWithLifecycleInput,
): Promise<CompactStats> {
  const reason = input.reason ?? "manual"
  if (input.lifecycle.beforeCompact) {
    // Extra opts ride along as data for policy hooks; the payload type
    // stays CompactWillRunPayload so legacy hooks keep working.
    const willPayload = {
      reason,
      preferRemote: input.preferRemote,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.keepTail !== undefined ? { keepTail: input.keepTail } : {}),
      ...(input.focus ? { focus: input.focus } : {}),
      messagesBefore: input.messages.length,
    }
    const will = await input.lifecycle.beforeCompact(willPayload)
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
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.keepTail !== undefined ? { keepTail: input.keepTail } : {}),
    ...(input.focus ? { focus: input.focus } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.writeStream ? { writeStream: input.writeStream } : {}),
    ...(input.onSummaryAttempt ? { onSummaryAttempt: input.onSummaryAttempt } : {}),
    appendNote: input.appendNote,
    appendCompact: input.appendCompact,
  })
  try {
    await input.lifecycle.afterCompact?.({
      reason: stats.reason,
      messagesBefore: stats.messagesBefore,
      messagesAfter: stats.messagesAfter,
      compactKind: stats.kind,
    })
  } catch {
    // afterCompact is host UX. Persist + memory already committed.
  }
  return stats
}
