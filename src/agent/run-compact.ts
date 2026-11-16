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

import { abortableSleep } from "@minimal-agent/core/plugin-api/utils/retry"

import { type AuthResult, authResultToProviderAuth } from "../auth/auth.ts"
import { providerPeerToken, resolveStoredProviderAuth } from "../auth/auth-strategies.ts"
import { NOOP_PLUGIN_EVENTS, type PluginEventsPort } from "../bus/plugin-events-port.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { CanonicalRequest } from "../llm/canonical-request.ts"
import type { ContentBlock, Message } from "../llm/messages.ts"
import { findModel, findModelForProvider, resolveProvider } from "../llm/model-registry.ts"
import type { CompactResult, ProviderAdapter, ProviderAuth, RunContext } from "../llm/provider.ts"
import { findProviderPlugin } from "../llm/provider-plugin.ts"
import { run } from "../llm/run.ts"
import { getSystemPromptBase } from "../llm/system-prompt-base-registry.ts"
import {
  applyPromptPartOverride,
  type SystemPromptOverrides,
} from "../llm/system-prompt-overrides.ts"
import { is401 } from "../llm/transport/auth-refresh.ts"
import { classifyError, retryDelayMs } from "../llm/transport/retry-policy.ts"
import { emitOutputEnd, LLM_OUTPUT_DELTA } from "../llm/transport/stream-delta.ts"
import { normalizeModelForAPI } from "../llm/transport/types.ts"
import {
  defaultNetworkClient,
  type NetworkClient,
  withRequestDiagnostics,
} from "../network/index.ts"
import { resolveBaseIdentity, type SystemPromptBaseHolder } from "../plugins/system-prompt-base.ts"
import type { LifecyclePort } from "../sdk/lifecycle.ts"
import { LifecycleSendDeniedError } from "../sdk/with-lifecycle-send.ts"

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
import { decideSendPolicy, notifyDidSend } from "./run-compact-send-policy.ts"

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
  /**
   * Diagnostics handle of the caller (S20). The summary and remote compact
   * requests report here. Default: the process bus.
   */
  diagnostics?: Diagnostics
  /**
   * Live-output telemetry port (spec S28) for the local summary stream
   * (`llm.outputDelta`, `llm.outputEnd`). Default: no telemetry.
   */
  pluginEvents?: PluginEventsPort
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
   * The base prompt holder of the live turn (the `systemPromptBase` option
   * of `resolveSystemPromptForModel`). Absent: the process holder, as the
   * live turn does.
   */
  systemPromptBase?: SystemPromptBaseHolder
  /**
   * The live turn's system prompt overrides. Only `identity` applies here,
   * as in `resolveSystemPromptForModel`, so the summary call sends the same
   * identity as a live turn.
   */
  systemPromptOverrides?: SystemPromptOverrides
  /**
   * Cancellation for the blocking local-summary call and its retry backoff.
   * The host wires the slash command's `ctx.abort` (turn cancel / per-command
   * timeout) here so a rate-limited summary retries on the shared curve but
   * never outlives the command budget.
   */
  signal?: AbortSignal
  /**
   * Test seam: sleep between summary retries. Defaults to the abortable sleep
   * used by the transport retry coordinator. Inject a no-op to exercise the
   * slow (rate-limit) curve without a real 30s wait.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
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
  onSummaryAttempt?: (attempt: number) => void | Promise<void>
  /** Optional note sink (session JSONL). */
  appendNote?: (text: string) => void
  /**
   * Send policy port. Required so no caller can send a compact request raw
   * by omission (pass `NOOP_LIFECYCLE` for none). Both provider-bound compact
   * requests (local summary and remote `adapter.compact`) pass
   * `message.willSend` once before the network, and `message.didSend` after
   * a successful send. A deny gives the stub checkpoint with no send.
   */
  lifecycle: LifecyclePort
  /**
   * Optional durable compact checkpoint writer. Called with the candidate
   * replacement BEFORE memory is mutated. A throw leaves live history
   * unchanged.
   */
  appendCompact?: (rec: {
    reason: CompactReason
    compactKind: "remote" | "local"
    messagesBefore: number
    messagesAfter: number
    replacementMessages: Array<{
      role: "user" | "assistant" | "system"
      content: string | ContentBlock[]
    }>
  }) => void
}

/**
 * Compact the model-facing history. Returns stats. Throws only when both
 * remote and local paths fail to produce a non-empty history.
 *
 * Throws on unknown `mode` strings. Throws RangeError on `keepTail` \< 0
 * (rejected, not clamped, so callers notice bad argv).
 */
/**
 * Compact the model-facing history. Returns stats. Throws only when both
 * remote and local paths fail to produce a non-empty history.
 *
 * Throws on unknown `mode` strings. Throws RangeError on `keepTail` \< 0
 * (rejected, not clamped, so callers notice bad argv).
 */
const compactLocks = new WeakSet<Message[]>()

/**
 * Run the compact pipeline for `input` and return the resulting stats.
 *
 * `compactLocks` serializes concurrent compacts that share one `messages`
 * array (the persist step must not interleave with another compact's
 * snapshot check).
 *
 * @param input - Mode, tail, focus, live-stream hooks, and the history.
 * @returns Stats for the committed compact, including the checkpoint text.
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
  if (compactLocks.has(input.messages)) {
    throw new Error("compact aborted: compact already in progress")
  }
  compactLocks.add(input.messages)
  try {
    return await runCompactUnlocked(input)
  } finally {
    compactLocks.delete(input.messages)
  }
}

async function runCompactUnlocked(input: RunCompactInput): Promise<CompactStats> {
  const snapshot = input.messages.slice()
  const contentLens = snapshot.map((m) => (Array.isArray(m.content) ? m.content.length : -1))
  const messagesBefore = snapshot.length
  if (messagesBefore === 0) {
    return {
      reason: input.reason,
      kind: "local",
      messagesBefore: 0,
      messagesAfter: 0,
    }
  }

  if (input.mode === "tail") return runTailCompact(input, messagesBefore, snapshot, contentLens)
  if (input.mode === "fork") return runForkStub(input, messagesBefore)
  if (input.mode === "local") return runLocalCompact(input, messagesBefore, snapshot, contentLens)
  if (input.mode === "remote") return runRemoteCompact(input, messagesBefore, snapshot, contentLens)

  // Legacy path (no explicit mode): preferRemote !== false attempts remote
  // first with a stub fallback, else the local stub directly.
  if (input.preferRemote === false) {
    return runLocalStub(input, messagesBefore, snapshot, contentLens)
  }
  return runRemoteCompact(input, messagesBefore, snapshot, contentLens)
}

function historyUnchanged(live: Message[], snapshot: Message[], contentLens: number[]): boolean {
  return (
    live.length === snapshot.length &&
    live.every((m, i) => m === snapshot[i]) &&
    live.every((m, i) => (Array.isArray(m.content) ? m.content.length : -1) === contentLens[i])
  )
}

function finish(
  input: RunCompactInput,
  stats: CompactStats,
  note: string,
  candidate: Message[] | null,
  snapshot: Message[],
  contentLens: number[],
  metaKind?: "tail" | "local",
): CompactStats {
  if (candidate) {
    if (!historyUnchanged(input.messages, snapshot, contentLens)) {
      throw new Error("compact aborted: history changed during compact")
    }
    if (input.appendCompact && (stats.messagesAfter > 0 || stats.messagesBefore > 0)) {
      input.appendCompact({
        reason: stats.reason,
        compactKind: stats.kind,
        messagesBefore: stats.messagesBefore,
        messagesAfter: stats.messagesAfter,
        replacementMessages: candidate.map(messageToReplacement),
        ...(metaKind
          ? {
              meta: {
                kind: metaKind,
                retained: candidate.length - 1,
                ...(input.focus !== undefined ? { focus: input.focus } : {}),
              },
            }
          : {}),
      })
    }
    replaceMessagesInPlace(input.messages, candidate)
    if (!stats.checkpointText) {
      stats.checkpointText = checkpointTextFromMessages(candidate)
    }
  }
  try {
    input.appendNote?.(note)
  } catch {
    // Note is audit-only. Persist + memory already committed.
  }
  return stats
}

function checkpointTextFromMessages(msgs: Message[]): string | undefined {
  const first = msgs[0]
  if (!first) return undefined
  if (typeof first.content === "string") return first.content
  const text = first.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
  return text.length > 0 ? text : undefined
}

function messageToReplacement(m: Message): {
  role: "user" | "assistant" | "system"
  content: string | ContentBlock[]
} {
  return {
    role: m.role,
    content: typeof m.content === "string" ? m.content : structuredClone(m.content),
  }
}

/** Tail-only rewrite: last N verbatim behind a checkpoint. No LLM call. */
function runTailCompact(
  input: RunCompactInput,
  messagesBefore: number,
  snapshot: Message[],
  contentLens: number[],
): CompactStats {
  const keepTail = input.keepTail ?? DEFAULT_KEEP_TAIL
  const candidate = buildTailCompactMessages(snapshot, keepTail)
  const stats: CompactStats = {
    reason: input.reason,
    kind: "local",
    messagesBefore,
    messagesAfter: candidate.length,
  }
  return finish(
    input,
    stats,
    `compact: tail reason=${input.reason} keepTail=${keepTail} messages ${messagesBefore}->${stats.messagesAfter}`,
    candidate,
    snapshot,
    contentLens,
    "tail",
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
    `compact: fork reason=${input.reason} ${guidance} messages ${messagesBefore}->${messagesBefore}`,
  )
  throw new Error(`compact fork: ${guidance}`)
}

/** Local stub: checkpoint + tail, no LLM call. Offline-safe. */
function runLocalStub(
  input: RunCompactInput,
  messagesBefore: number,
  snapshot: Message[],
  contentLens: number[],
  remoteError?: string,
  summaryError?: string,
): CompactStats {
  const localMsgs = buildLocalCompactMessages({
    previous: snapshot,
    keepTail: input.keepTail,
    focus: input.focus,
  })
  const stats: CompactStats = {
    reason: input.reason,
    kind: "local",
    messagesBefore,
    messagesAfter: localMsgs.length,
    ...(remoteError ? { remoteError } : {}),
    ...(summaryError ? { summaryError } : {}),
  }
  return finish(
    input,
    stats,
    `compact: local reason=${input.reason} messages ${messagesBefore}->${stats.messagesAfter}` +
      (remoteError ? ` remoteError=${remoteError}` : "") +
      (summaryError ? ` summaryError=${summaryError}` : ""),
    localMsgs,
    snapshot,
    contentLens,
    "local",
  )
}

/**
 * Local mode: blocking `await` LLM summary, then checkpoint + tail.
 * Falls back to the stub checkpoint when the summary call fails.
 */
async function runLocalCompact(
  input: RunCompactInput,
  messagesBefore: number,
  snapshot: Message[],
  contentLens: number[],
): Promise<CompactStats> {
  let summaryText: string | undefined
  let summaryError: string | undefined
  try {
    summaryText = await runLocalSummary(input)
  } catch (err) {
    if (err instanceof LifecycleSendDeniedError) {
      // Never send after a deny: stub checkpoint, no network call.
      const cause = `send policy denied: ${err.reason}`
      input.appendNote?.(
        `compact: send policy denied the summary request${denyReasonSuffix(err)}, using stub`,
      )
      return runLocalStub(input, messagesBefore, snapshot, contentLens, undefined, cause)
    }
    summaryError = err instanceof Error ? err.message : String(err)
  }
  if (!summaryText) {
    const apiModel = normalizeModelForAPI(input.model)
    const known = input.providerId
      ? (findModelForProvider(apiModel, input.providerId) ?? findModel(apiModel))
      : findModel(apiModel)
    const cause =
      summaryError ?? (known ? "empty summary (no text)" : `unknown model "${input.model}"`)
    input.appendNote?.(`compact: local summary failed (${cause}). Using stub`)
    return runLocalStub(input, messagesBefore, snapshot, contentLens, undefined, cause)
  }
  const localMsgs = buildLocalCompactMessages({
    previous: snapshot,
    summaryText,
    keepTail: input.keepTail,
    focus: input.focus,
  })
  const stats: CompactStats = {
    reason: input.reason,
    kind: "local",
    messagesBefore,
    messagesAfter: localMsgs.length,
    summaryText,
  }
  return finish(
    input,
    stats,
    `compact: local reason=${input.reason} messages ${messagesBefore}->${stats.messagesAfter} summaryChars=${summaryText.length}`,
    localMsgs,
    snapshot,
    contentLens,
    "local",
  )
}

/** Remote mode: try `adapter.compact`, fall back to the local stub. */
async function runRemoteCompact(
  input: RunCompactInput,
  messagesBefore: number,
  snapshot: Message[],
  contentLens: number[],
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
      input.appendNote?.(`compact: ${remoteError}. Using local fallback`)
    }
  } catch (err) {
    if (err instanceof LifecycleSendDeniedError) {
      // Never send after a deny: stub checkpoint, no local summary call.
      remoteError = `send policy denied: ${err.reason}`
      input.appendNote?.(
        `compact: send policy denied remote compact${denyReasonSuffix(err)}, using stub`,
      )
      return runLocalStub(input, messagesBefore, snapshot, contentLens, remoteError)
    }
    // Remote failed: fall through to local. Surface via note for ops.
    remoteError = err instanceof Error ? err.message : String(err)
    input.appendNote?.(`compact: remote failed (${remoteError}). Using local fallback`)
    result = null
  }

  if (!result) {
    return runLocalStub(input, messagesBefore, snapshot, contentLens, remoteError)
  }
  const next = buildReplacementHistory(result.replacementMessages)
  const stats: CompactStats = {
    reason: input.reason,
    kind: result.kind,
    messagesBefore,
    messagesAfter: next.length,
    summaryText:
      result.replacementMessages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")
        .trim() || undefined,
  }
  return finish(
    input,
    stats,
    `compact: ${stats.kind} reason=${input.reason} messages ${messagesBefore}->${stats.messagesAfter}`,
    next,
    snapshot,
    contentLens,
  )
}

/** The network client for a compact request, stamped with the caller's diagnostics. */
function compactNetworkClient(input: RunCompactInput): NetworkClient {
  const client = input.networkClient ?? defaultNetworkClient
  return input.diagnostics ? withRequestDiagnostics(client, input.diagnostics) : client
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
    networkClient: compactNetworkClient(input),
  }
  // MUST go through the provider's resolveSystemPrompt so Anthropic OAuth
  // plan auth gets billing + Claude Code identity preamble. A bare compaction
  // prompt alone returns a fake HTTP 429 rate_limit_error (Janice 9f031663).
  const system = buildCompactSummarySystem(entry, providerAuth, input)

  // message.willSend ONCE, before the retry loop. The listener sees the same
  // shape as a live send: the legacy history (tool_use / tool_result blocks
  // intact) plus the summary system. The flat summary text is built from the
  // listener's payload, so a redaction inside a tool block reaches the wire.
  // The loop (incl. the 401 token swap) reuses this request. Throws on deny.
  const sent = await decideSendPolicy(
    { messages: input.messages, system, modelId: entry.id, providerId: entry.providerId },
    input.lifecycle,
  )
  const req: CanonicalRequest = {
    modelId: entry.id,
    providerId: entry.providerId,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: flattenHistoryForSummary(sent.messages) }],
      },
    ],
    stream: true,
    // Marks the call for providers' request-class hints (no feature change).
    purpose: "compaction",
    ...(sent.system ? { system: sent.system } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  }

  const sleep = input.sleep ?? abortableSleep
  // S28: the caller's port, never a module plugin bus.
  const pluginEventsSink: PluginEventsPort = input.pluginEvents ?? NOOP_PLUGIN_EVENTS
  let savedPartial = ""
  /** Transient failures seen since an attempt saved partial summary text. */
  let partialFailures = 0
  const authRecovery: CompactAuthRecovery = { triedPeerToken: false, triedRefresh: false }
  for (let attempt = 1; ; attempt++) {
    try {
      await input.onSummaryAttempt?.(attempt)
    } catch {
      // UX-only
    }
    let attemptText = ""
    try {
      for await (const ev of run(req, {
        context: ctx,
        ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
      })) {
        if (ev.type === "text_delta") {
          attemptText += ev.text
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
            pluginEventsSink.emit(LLM_OUTPUT_DELTA, { deltaTokens })
          } catch {
            // Bus emit is best-effort telemetry.
          }
        } else if (ev.type === "stream_error") {
          const causeMsg =
            ev.cause instanceof Error
              ? ev.cause.message
              : ev.cause !== undefined
                ? String(ev.cause)
                : ""
          const err = new Error(
            `local summary stream error (retryable=${ev.retryable})${causeMsg ? `: ${causeMsg}` : ""}`,
          )
          ;(err as { retryable?: boolean }).retryable = ev.retryable
          throw err
        }
      }
      try {
        emitOutputEnd("stream_end", pluginEventsSink)
      } catch {
        // Bus emit is best-effort telemetry.
      }
      await notifyDidSend(input.lifecycle, sent)
      const trimmed = attemptText.trim()
      return trimmed.length > 0 ? trimmed : undefined
    } catch (err) {
      const partial = attemptText.trim()
      if (partial.length > 0) savedPartial = partial

      // Expired OAuth access token (HTTP 401, pre-stream). See
      // `recoverCompactAuth401` for why compact needs its own recovery.
      if (
        await recoverCompactAuth401(
          err,
          ctx.auth,
          authRecovery,
          entry.providerId,
          input.credentialName,
        )
      ) {
        continue
      }

      // Transient failure (pre-stream HTTP 429 / 5xx / connect blip, or a
      // retryable mid-stream `stream_error`). Same class and curves as the
      // agent loop, and no attempt limit: only the caller's signal stops it.
      // (The fake plan-auth 429 that once hung `/compact` came from a missing
      // system preamble, fixed in `buildCompactSummarySystem`.)
      const failure = classifyError(err)
      if (failure?.errorClass === "transient") {
        // Once a stream broke after partial text, a second failure keeps the
        // newest partial summary instead of asking again. That ends compaction
        // with a summary, not with an error.
        if (savedPartial.length > 0 && ++partialFailures > 1) {
          try {
            emitOutputEnd("stream_end", pluginEventsSink)
          } catch {
            // Bus emit is best-effort telemetry.
          }
          await notifyDidSend(input.lifecycle, sent)
          return savedPartial
        }
        await sleep(retryDelayMs(failure, attempt).delayMs, input.signal)
        continue
      }
      throw err
    }
  }
}

/**
 * Build the local-summary `system` blocks the same way live turns do: ask the
 * active provider plugin's `resolveSystemPrompt` so OAuth/plan Anthropic gets
 * billing + Claude Code identity before the compaction instructions. Without
 * that preamble, Anthropic answers a fake `rate_limit_error` 429.
 */
function buildCompactSummarySystem(
  entry: { id: string; providerId: string },
  providerAuth: ProviderAuth,
  input: Pick<RunCompactInput, "focus" | "systemPromptBase" | "systemPromptOverrides">,
): CanonicalRequest["system"] {
  const bodyText = buildLocalSummarySystemPrompt(input.focus)
  const body = [{ type: "text" as const, text: bodyText }]
  const plugin = findProviderPlugin(entry.providerId)
  if (plugin?.resolveSystemPrompt) {
    // Same identity as live turns (system-prompt.ts resolveSystemPromptForModel):
    // the caller's holder, else the process holder, then the identity
    // override. No base identity: no identity block (M8).
    const holder = input.systemPromptBase ?? getSystemPromptBase()
    const identityCtx = { authKind: providerAuth.kind, modelId: entry.id }
    const base = (holder === undefined ? undefined : resolveBaseIdentity(holder, identityCtx)) ?? ""
    const identity = applyPromptPartOverride(base, input.systemPromptOverrides?.identity) ?? base
    return plugin
      .resolveSystemPrompt({
        identity,
        body,
        authKind: providerAuth.kind,
        modelId: entry.id,
      })
      .filter((b) => typeof b.text !== "string" || b.text.length > 0)
  }
  return body
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
    return authResultToProviderAuth(input.auth)
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
    networkClient: compactNetworkClient(input),
  }

  // Build a minimal canonical request from the live history for the
  // provider's compact encoder. System prefix is omitted: the compact
  // endpoint uses instructions separately when the provider wants them.
  // Same provider preamble as local summary / live turns (billing + identity
  // on Anthropic OAuth). Remote adapters that ignore `system` are unaffected.
  const system = buildCompactSummarySystem(entry, providerAuth, input)

  // message.willSend ONCE, before the 401 loop (same rule as local summary).
  // The listener sees a copy of the live history. Throws on deny.
  const sent = await decideSendPolicy(
    { messages: input.messages, system, modelId: entry.id, providerId: entry.providerId },
    input.lifecycle,
  )
  const req: CanonicalRequest = {
    modelId: entry.id,
    providerId: entry.providerId,
    messages: sent.messages.map((m) => legacyMessageToMinimalCanonical(m)),
    stream: false,
    purpose: "compaction",
    ...(sent.system ? { system: sent.system } : {}),
  }

  const authRecovery: CompactAuthRecovery = { triedPeerToken: false, triedRefresh: false }
  for (;;) {
    try {
      const result = await adapter.compact({ req }, entry, ctx)
      await notifyDidSend(input.lifecycle, sent)
      return result
    } catch (err) {
      if (
        await recoverCompactAuth401(
          err,
          ctx.auth,
          authRecovery,
          entry.providerId,
          input.credentialName,
        )
      ) {
        continue
      }
      throw err
    }
  }
}

/** Note suffix with the deny reason text only (never payload values). */
function denyReasonSuffix(err: LifecycleSendDeniedError): string {
  const reason = err.reason?.trim()
  return reason ? ` (${reason})` : ""
}

/** Per-call 401 recovery state for the compact paths. */
interface CompactAuthRecovery {
  triedPeerToken: boolean
  triedRefresh: boolean
}

/**
 * Recover one compact request from an expired OAuth access token (HTTP 401).
 *
 * Live turns recover through `withAuthRefresh` in the canonical send onion.
 * Both compact paths (local summary and remote `adapter.compact`) call the
 * provider directly, so they need the same policy here. Without it, a
 * `/compact` that is the FIRST request after the access token expired
 * (typical right after `--resume`) failed with "OAuth access token has
 * expired" while a new session with the same credential worked.
 *
 * Policy (same as `withAuthRefresh`): adopt a token a peer process already
 * rotated into the store, else do one network refresh. Mutates `auth.token`.
 *
 * @returns `true` when the caller should retry with the updated token.
 */
async function recoverCompactAuth401(
  err: unknown,
  auth: ProviderAuth,
  state: CompactAuthRecovery,
  providerId: string,
  credentialName: string | undefined,
): Promise<boolean> {
  if (!is401(err) || auth.kind !== "oauth" || !auth.refresh) return false
  if (!state.triedPeerToken) {
    state.triedPeerToken = true
    const peer = providerPeerToken(providerId, undefined, credentialName)
    if (peer && peer !== auth.token) {
      auth.token = peer
      return true
    }
  }
  if (!state.triedRefresh) {
    state.triedRefresh = true
    const next = await auth.refresh()
    auth.token = next.token
    return true
  }
  return false
}

/**
 * Minimal legacy Message → CanonicalMessage without pulling the full
 * message-codec block matrix (images etc. become text placeholders).
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
