/**
 * Compact-with-lifecycle helper for AgentCore.
 *
 * @module sdk/lifecycle-compact
 */

import type { CompactReason, CompactRequestOpts, CompactStats } from "../agent/context-compact.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { Message } from "../llm/messages.ts"
import type { NetworkClient } from "../network/index.ts"

import { deniedError, type HookContextEntry, isDenied, type LifecyclePort } from "./lifecycle.ts"
import type { SyntheticTextResolverLike } from "./ports.ts"

export interface CompactWithLifecycleInput {
  messages: Message[]
  model: string
  providerId?: string
  auth: AuthResult
  credentialName?: string
  networkClient?: NetworkClient
  /** The core's diagnostics handle (S20), forwarded to the compact requests. */
  diagnostics?: Diagnostics
  /** The core's live-output telemetry port (S28), forwarded to the summary stream. */
  pluginEvents?: import("../bus/plugin-events-port.ts").PluginEventsPort
  lifecycle: LifecyclePort
  /** The live turn's system prompt overrides, for the summary identity. */
  systemPromptOverrides?: import("../llm/system-prompt-overrides.ts").SystemPromptOverrides
  reason?: CompactReason
  preferRemote?: boolean
  /** Explicit engine. Overrides the `preferRemote` default mapping. */
  mode?: CompactRequestOpts["mode"]
  /** Trailing messages kept verbatim (default 6). Must be \>= 0. */
  keepTail?: number
  /** Hint passed to the summarizer, kept verbatim in the checkpoint. */
  focus?: string
  /**
   * Session id for the `compact.willRun` payload. The SDK may not import
   * the session module, so the caller supplies it.
   */
  sid?: string
  /** Active agent mode id for the `compact.willRun` payload. The caller supplies it. */
  agentMode?: string
  /** Working directory for the `session.willStart` payload after a compaction. */
  cwd?: string
  /**
   * Receives the `session.willStart` (source `compact`) listener context
   * after a compaction succeeds. The caller puts it into session context.
   */
  onSessionContext?: (lines: HookContextEntry[]) => void
  /** The core's synthetic text resolver (G3), forwarded to `runCompact` (15d.3a). */
  text?: SyntheticTextResolverLike
  /** The core's sideband API: renders the checkpoint tag (design step 7). */
  sideband?: import("../sideband/types.ts").SidebandApi
  /** Cancellation for the local-summary call and its retry backoff (N5). */
  signal?: CompactRequestOpts["signal"]
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
    meta?: Omit<import("../../plugin-api/src/types/compaction.ts").CompactMeta, "at">
  }) => void
}

/** Run beforeCompact → runCompact → afterCompact. Throws a `LifecycleDeniedError` on deny. */
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
      ...(input.sid !== undefined ? { sid: input.sid } : {}),
      ...(input.agentMode !== undefined ? { agentMode: input.agentMode } : {}),
    }
    const will = await input.lifecycle.beforeCompact(willPayload)
    // The action decides, never the reason text: a deny with no reason
    // still throws.
    if (isDenied(will)) throw deniedError("compact.willRun", will)
  }
  const { runCompact } = await import("../agent/run-compact.ts")
  const stats = await runCompact({
    messages: input.messages,
    model: input.model,
    providerId: input.providerId,
    auth: input.auth,
    ...(input.credentialName ? { credentialName: input.credentialName } : {}),
    networkClient: input.networkClient,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    ...(input.pluginEvents ? { pluginEvents: input.pluginEvents } : {}),
    reason,
    preferRemote: input.preferRemote,
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.keepTail !== undefined ? { keepTail: input.keepTail } : {}),
    ...(input.focus ? { focus: input.focus } : {}),
    ...(input.systemPromptOverrides ? { systemPromptOverrides: input.systemPromptOverrides } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.sideband ? { sideband: input.sideband } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.writeStream ? { writeStream: input.writeStream } : {}),
    ...(input.onSummaryAttempt ? { onSummaryAttempt: input.onSummaryAttempt } : {}),
    appendNote: input.appendNote,
    appendCompact: input.appendCompact,
    // Item 8: compact requests pass message.willSend like agent sends.
    lifecycle: input.lifecycle,
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
  await announceCompactSession(input)
  return stats
}

/**
 * A compaction starts a new context: emit `session.willStart` with source
 * `compact`, and hand its context to the caller. A failure never fails the
 * compaction, which already committed.
 */
async function announceCompactSession(input: CompactWithLifecycleInput): Promise<void> {
  if (!input.lifecycle.sessionWillStart) return
  try {
    const started = await input.lifecycle.sessionWillStart({
      source: "compact",
      sid: input.sid ?? "",
      cwd: input.cwd ?? "",
      model: input.model,
    })
    const lines = started.additionalContext ?? []
    if (lines.length > 0) input.onSessionContext?.(lines)
  } catch {
    // session.willStart is advisory. The compaction already committed.
  }
}
