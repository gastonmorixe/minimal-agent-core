/**
 * Imperative compact runner shared by legacy {@link Agent} and
 * {@link AgentCore}.
 *
 * Modes (`remote` | `tail` | `local` | `fork`):
 *
 * - `remote`: prefers `adapter.compact`, falls back to the local stub
 *   prune+checkpoint when remote is missing or fails.
 * - `tail`: keeps the last N messages verbatim behind a checkpoint
 *   marker via `buildTailCompactMessages` (default 6). No LLM call.
 * - `local`: blocking `await` LLM summary (never fire-forget), then
 *   rewrites via `buildLocalCompactMessages`. Falls back to the stub
 *   checkpoint when the summary call fails.
 * - `fork`: stub. Leaves history untouched, records guidance via
 *   `appendNote`, then throws so callers do not report an unchanged
 *   history as a successful compact.
 *
 * Mutates the caller's `messages` array in place via
 * {@link replaceMessagesInPlace}.
 *
 * @module agent/run-compact
 */

import type { AuthResult } from "../auth/auth.ts"
import { resolveStoredProviderAuth } from "../auth/auth-strategies.ts"
import { getGlobalEventBus } from "../bus/global-bus.ts"
import { legacyAuthToProviderAuth } from "../llm/adapter-legacy.ts"
import type { CanonicalRequest } from "../llm/canonical-request.ts"
import type { Message } from "../llm/messages.ts"
import { findModel, findModelForProvider, resolveProvider } from "../llm/model-registry.ts"
import type { CompactResult, ProviderAdapter, ProviderAuth, RunContext } from "../llm/provider.ts"
import { run } from "../llm/run.ts"
import { emitOutputEnd, LLM_OUTPUT_DELTA } from "../llm/transport/stream-delta.ts"
import { normalizeModelForAPI } from "../llm/transport/types.ts"
import { defaultNetworkClient, type NetworkClient } from "../network/index.ts"

import {
  buildLocalCompactMessages,
  buildLocalSummarySystemPrompt,
  buildReplacementHistory,
  buildTailCompactMessages,
  type CompactMode,
  type CompactReason,
  type CompactStats,
  DEFAULT_KEEP_TAIL,
  flattenHistoryForSummary,
  replaceMessagesInPlace,
} from "./context-compact.ts"

/** Inputs both agent shells pass into the shared compact runner. */
export interface RunCompactInput {
  messages: Message[]
  model: string
  providerId?: string
  auth: AuthResult
  /**
   * Named credential pin (`--credential-name`). Must match the live send
   * path so remote compact does not fall back to the provider's default
   * stored account when multiple ChatGPT OAuth entries exist.
   */
  credentialName?: string
  networkClient?: NetworkClient
  reason: CompactReason
  /**
   * When true (default), try provider.compact first. Set false to force
   * the local fallback (tests / offline). Ignored when `mode` is set:
   * an explicit mode always wins.
   */
  preferRemote?: boolean
  /**
   * Explicit engine. Overrides the `preferRemote` default mapping.
   * Unset preserves the legacy behavior: `preferRemote !== false`
   * attempts remote first, else the local stub.
   */
  mode?: CompactMode
  /** Trailing messages kept verbatim (default 6). Must be \>= 0. */
  keepTail?: number
  /** Hint passed to the summarizer, kept verbatim in the checkpoint. */
  focus?: string
  /**
   * Optional progress sink for the local-summary LLM stream. Called per
   * text delta with approximate output tokens; also forwarded to the
   * shared `llm.outputDelta` bus so the TPS footer ticks. UX-only and
   * non-throwing (run-compact swallows sink errors).
   */
  onProgress?: (delta: { deltaTokens: number }) => void
  /**
   * Optional interim-text sink. The host wires `compositor.writeStream`
   * here when one is available; otherwise status label updates are the
   * only interim UX.
   */
  writeStream?: (chunk: string) => void
  /** Optional note sink (session JSONL). */
  appendNote?: (text: string) => void
  /**
   * Optional durable compact checkpoint writer. When set, called after a
   * successful rewrite with the post-compact messages so resume can fold
   * model history from the checkpoint without deleting jsonl history.
   */
  appendCompact?: (rec: {
    reason: CompactReason
    compactKind: "remote" | "local"
    messagesBefore: number
    messagesAfter: number
    replacementMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>
  }) => void
}

/**
 * Compact the model-facing history. Returns stats. Throws only when both
 * remote and local paths fail to produce a non-empty history.
 *
 * Throws on unknown `mode` strings. Throws RangeError on `keepTail` \< 0
 * (rejected, not clamped, so callers notice bad argv).
 */
export async function runCompact(input: RunCompactInput): Promise<CompactStats> {
  const mode = input.mode as string | undefined
  const knownModes: readonly string[] = ["remote", "tail", "local", "fork"]
  if (mode !== undefined && !knownModes.includes(mode)) {
    throw new Error(`runCompact: unknown mode "${mode}" (expected remote|tail|local|fork)`)
  }
  if (input.keepTail !== undefined && input.keepTail < 0) {
    throw new RangeError(`runCompact: keepTail must be >= 0 (got ${input.keepTail})`)
  }
  const messagesBefore = input.messages.length
  if (messagesBefore === 0) {
    return {
      reason: input.reason,
      kind: "local",
      messagesBefore: 0,
      messagesAfter: 0,
    }
  }

  if (input.mode === "tail") return runTailCompact(input, messagesBefore)
  if (input.mode === "fork") return runForkStub(input, messagesBefore)
  if (input.mode === "local") return runLocalCompact(input, messagesBefore)
  if (input.mode === "remote") return runRemoteCompact(input, messagesBefore)

  // Legacy path (no explicit mode): preferRemote !== false attempts remote
  // first with a stub fallback, else the local stub directly.
  if (input.preferRemote === false) {
    return runLocalStub(input, messagesBefore)
  }
  return runRemoteCompact(input, messagesBefore)
}

function finish(
  input: RunCompactInput,
  stats: CompactStats,
  note: string,
  writeCheckpoint: boolean,
): CompactStats {
  input.appendNote?.(note)
  if (
    input.appendCompact &&
    writeCheckpoint &&
    (stats.messagesAfter > 0 || stats.messagesBefore > 0)
  ) {
    input.appendCompact({
      reason: stats.reason,
      compactKind: stats.kind,
      messagesBefore: stats.messagesBefore,
      messagesAfter: stats.messagesAfter,
      replacementMessages: input.messages.map(messageToPortableText),
    })
  }
  return stats
}

/** Tail-only rewrite: last N verbatim behind a checkpoint. No LLM call. */
function runTailCompact(input: RunCompactInput, messagesBefore: number): CompactStats {
  const keepTail = input.keepTail ?? DEFAULT_KEEP_TAIL
  replaceMessagesInPlace(input.messages, buildTailCompactMessages(input.messages, keepTail))
  const stats: CompactStats = {
    reason: input.reason,
    kind: "local",
    messagesBefore,
    messagesAfter: input.messages.length,
  }
  return finish(
    input,
    stats,
    `compact: tail reason=${input.reason} keepTail=${keepTail} messages ${messagesBefore}→${stats.messagesAfter}`,
    true,
  )
}

/**
 * Fork stub: history is left untouched. Records guidance via `appendNote`,
 * then throws so callers (TUI `/compact`) report an error instead of a
 * success checkmark for an unchanged history.
 */
function runForkStub(input: RunCompactInput, messagesBefore: number): CompactStats {
  const guidance =
    "fork compact is not implemented in this runner: history left unchanged. " +
    "To branch, fork the session file (SessionStore.fork) or copy the transcript, " +
    "then compact the branch."
  input.appendNote?.(
    `compact: fork reason=${input.reason} ${guidance} messages ${messagesBefore}→${messagesBefore}`,
  )
  throw new Error(`compact fork: ${guidance}`)
}

/** Local stub: checkpoint + tail, no LLM call. Offline-safe. */
function runLocalStub(
  input: RunCompactInput,
  messagesBefore: number,
  remoteError?: string,
): CompactStats {
  const localMsgs = buildLocalCompactMessages({
    previous: input.messages,
    keepTail: input.keepTail,
    focus: input.focus,
  })
  replaceMessagesInPlace(input.messages, localMsgs)
  const stats: CompactStats = {
    reason: input.reason,
    kind: "local",
    messagesBefore,
    messagesAfter: input.messages.length,
    ...(remoteError ? { remoteError } : {}),
  }
  return finish(
    input,
    stats,
    `compact: local reason=${input.reason} messages ${messagesBefore}→${stats.messagesAfter}` +
      (remoteError ? ` remoteError=${remoteError}` : ""),
    true,
  )
}

/**
 * Local mode: blocking `await` LLM summary, then checkpoint + tail.
 * Falls back to the stub checkpoint when the summary call fails.
 */
async function runLocalCompact(
  input: RunCompactInput,
  messagesBefore: number,
): Promise<CompactStats> {
  let summaryText: string | undefined
  let summaryError: string | undefined
  try {
    summaryText = await runLocalSummary(input)
  } catch (err) {
    summaryError = err instanceof Error ? err.message : String(err)
  }
  if (!summaryText) {
    if (summaryError)
      input.appendNote?.(`compact: local summary failed (${summaryError}); using stub`)
    return runLocalStub(input, messagesBefore)
  }
  const localMsgs = buildLocalCompactMessages({
    previous: input.messages,
    summaryText,
    keepTail: input.keepTail,
    focus: input.focus,
  })
  replaceMessagesInPlace(input.messages, localMsgs)
  const stats: CompactStats = {
    reason: input.reason,
    kind: "local",
    messagesBefore,
    messagesAfter: input.messages.length,
  }
  return finish(
    input,
    stats,
    `compact: local reason=${input.reason} messages ${messagesBefore}→${stats.messagesAfter} summaryChars=${summaryText.length}`,
    true,
  )
}

/** Remote mode: try `adapter.compact`, fall back to the local stub. */
async function runRemoteCompact(
  input: RunCompactInput,
  messagesBefore: number,
): Promise<CompactStats> {
  let result: CompactResult | null = null
  let remoteError: string | undefined

  try {
    result = await tryRemoteCompact(input)
    if (!result) {
      // Adapter missing / model not registered — not a hard throw, but
      // still explain why we fell back so `/compact` is not a silent
      // "local" mystery on plan-auth sessions.
      remoteError = "remote compact unavailable (no adapter.compact or model entry)"
      input.appendNote?.(`compact: ${remoteError}; using local fallback`)
    }
  } catch (err) {
    // Remote failed: fall through to local. Surface via note for ops.
    remoteError = err instanceof Error ? err.message : String(err)
    input.appendNote?.(`compact: remote failed (${remoteError}); using local fallback`)
    result = null
  }

  if (!result) {
    return runLocalStub(input, messagesBefore, remoteError)
  }
  replaceMessagesInPlace(input.messages, buildReplacementHistory(result.replacementMessages))
  const stats: CompactStats = {
    reason: input.reason,
    kind: result.kind,
    messagesBefore,
    messagesAfter: input.messages.length,
  }
  return finish(
    input,
    stats,
    `compact: ${stats.kind} reason=${input.reason} messages ${messagesBefore}→${stats.messagesAfter}`,
    true,
  )
}

/**
 * Blocking single-shot summary call over the same model/provider auth as
 * the live send path. Resolves with trimmed summary text, or `undefined`
 * when the model is unknown. Rejects on transport / stream errors so the
 * caller can note the cause before falling back to the stub.
 */
async function runLocalSummary(input: RunCompactInput): Promise<string | undefined> {
  const apiModel = normalizeModelForAPI(input.model)
  const entry = input.providerId
    ? (findModelForProvider(apiModel, input.providerId) ?? findModel(apiModel))
    : findModel(apiModel)
  if (!entry) return undefined

  const providerAuth = resolveCompactProviderAuth(input, entry.providerId, entry.id)
  const ctx: RunContext = {
    auth: providerAuth,
    sessionId: "compact-local",
    networkClient: input.networkClient ?? defaultNetworkClient,
  }
  const req: CanonicalRequest = {
    modelId: entry.id,
    providerId: entry.providerId,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: flattenHistoryForSummary(input.messages) }],
      },
    ],
    stream: false,
    system: [{ type: "text", text: buildLocalSummarySystemPrompt(input.focus) }],
  }

  let text = ""
  for await (const ev of run(req, { context: ctx })) {
    if (ev.type === "text_delta") {
      text += ev.text
      const deltaTokens = Math.max(1, Math.round(ev.text.length / 4))
      try {
        input.onProgress?.({ deltaTokens })
      } catch {
        // UX-only sink: never fail compact.
      }
      try {
        input.writeStream?.(ev.text)
      } catch {
        // UX-only sink: never fail compact.
      }
      try {
        getGlobalEventBus()?.emit(LLM_OUTPUT_DELTA, { deltaTokens })
      } catch {
        // Bus emit is best-effort telemetry.
      }
    } else if (ev.type === "stream_error") {
      throw new Error(`local summary stream error (retryable=${ev.retryable})`)
    }
  }
  try {
    emitOutputEnd("stream_end")
  } catch {
    // Bus emit is best-effort telemetry.
  }
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function messageToPortableText(m: Message): {
  role: "user" | "assistant" | "system"
  content: string
} {
  return {
    role: m.role as "user" | "assistant" | "system",
    content:
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n"),
  }
}

/**
 * Resolve ProviderAuth for compact the same way the live send path does:
 * prefer the stored provider credential (preserves plan-auth `baseUrl`
 * + plan headers). Fall back to the agent session's AuthResult only when
 * store lookup is unavailable.
 */
function resolveCompactProviderAuth(
  input: RunCompactInput,
  providerId: string,
  modelId: string,
): ProviderAuth {
  try {
    return resolveStoredProviderAuth(providerId, modelId, input.credentialName)
  } catch {
    // No stored credential / plugins not booted (unit tests): use session auth.
    return legacyAuthToProviderAuth(input.auth)
  }
}

async function tryRemoteCompact(input: RunCompactInput): Promise<CompactResult | null> {
  const apiModel = normalizeModelForAPI(input.model)
  const entry = input.providerId
    ? (findModelForProvider(apiModel, input.providerId) ?? findModel(apiModel))
    : findModel(apiModel)
  if (!entry) return null

  let adapter: ProviderAdapter
  try {
    adapter = resolveProvider(entry.providerId)
  } catch {
    return null
  }
  if (typeof adapter.compact !== "function") return null

  const providerAuth = resolveCompactProviderAuth(input, entry.providerId, entry.id)
  const ctx: RunContext = {
    auth: providerAuth,
    sessionId: "compact",
    networkClient: input.networkClient ?? defaultNetworkClient,
  }

  // Build a minimal canonical request from the live history for the
  // provider's compact encoder. System prefix is omitted: the compact
  // endpoint uses instructions separately when the provider wants them.
  const req: CanonicalRequest = {
    modelId: entry.id,
    providerId: entry.providerId,
    messages: input.messages.map((m) => legacyMessageToMinimalCanonical(m)),
    stream: false,
    system: [{ type: "text", text: buildLocalSummarySystemPrompt(input.focus) }],
  }

  return adapter.compact({ req }, entry, ctx)
}

/**
 * Minimal legacy Message → CanonicalMessage without pulling the full
 * adapter-legacy block matrix (images etc. become text placeholders).
 * Good enough for compact: the endpoint mostly needs text + tool pairs.
 */
function legacyMessageToMinimalCanonical(m: Message): CanonicalRequest["messages"][number] {
  if (typeof m.content === "string") {
    return { role: m.role, content: [{ type: "text", text: m.content }] }
  }
  const content: CanonicalRequest["messages"][number]["content"] = []
  for (const b of m.content) {
    switch (b.type) {
      case "text":
        content.push({ type: "text", text: b.text })
        break
      case "tool_use":
        content.push({
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.input,
        })
        break
      case "tool_result": {
        const text =
          typeof b.content === "string"
            ? b.content
            : b.content
                .map((c) => (c.type === "text" ? c.text : ""))
                .filter(Boolean)
                .join("\n")
        content.push({
          type: "tool_result",
          toolUseId: b.tool_use_id,
          content: [{ type: "text", text }],
          ...(b.is_error !== undefined ? { isError: b.is_error } : {}),
        })
        break
      }
      case "thinking":
        content.push({ type: "thinking", text: b.thinking, signature: b.signature })
        break
      default:
        // image / document / redacted_thinking: skip for compact body
        break
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" })
  }
  return { role: m.role, content }
}
