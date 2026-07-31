/**
 * Imperative compact runner shared by legacy {@link Agent} and
 * {@link AgentCore}.
 *
 * Resolves the active provider, prefers `adapter.compact` (remote), falls
 * back to local prune+checkpoint when remote is missing or fails.
 * Mutates the caller's `messages` array in place via
 * {@link replaceMessagesInPlace}.
 *
 * @module agent/run-compact
 */

import type { AuthResult } from "../auth/auth.ts"
import { resolveStoredProviderAuth } from "../auth/auth-strategies.ts"
import { legacyAuthToProviderAuth } from "../llm/adapter-legacy.ts"
import type { CanonicalRequest } from "../llm/canonical-request.ts"
import type { Message } from "../llm/messages.ts"
import { findModel, findModelForProvider, resolveProvider } from "../llm/model-registry.ts"
import type { CompactResult, ProviderAdapter, ProviderAuth, RunContext } from "../llm/provider.ts"
import { normalizeModelForAPI } from "../llm/transport/types.ts"
import { defaultNetworkClient, type NetworkClient } from "../network/index.ts"

import {
  buildLocalCompactMessages,
  buildReplacementHistory,
  type CompactReason,
  type CompactStats,
  LOCAL_COMPACTION_PROMPT,
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
   * the local fallback (tests / offline).
   */
  preferRemote?: boolean
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
 */
export async function runCompact(input: RunCompactInput): Promise<CompactStats> {
  const preferRemote = input.preferRemote !== false
  const messagesBefore = input.messages.length
  if (messagesBefore === 0) {
    return {
      reason: input.reason,
      kind: "local",
      messagesBefore: 0,
      messagesAfter: 0,
    }
  }

  let result: CompactResult | null = null
  let kind: "remote" | "local" = "local"
  let remoteError: string | undefined

  if (preferRemote) {
    try {
      result = await tryRemoteCompact(input)
      if (result) kind = result.kind
      else {
        // Adapter missing / model not registered — not a hard throw, but
        // still explain why we fell back so `/compact` is not a silent
        // "local" mystery on plan-auth sessions.
        remoteError = "remote compact unavailable (no adapter.compact or model entry)"
        input.appendNote?.(`compact: ${remoteError}; using local fallback`)
      }
    } catch (err) {
      // Remote failed: fall through to local. Surface via note for ops.
      const msg = err instanceof Error ? err.message : String(err)
      remoteError = msg
      input.appendNote?.(`compact: remote failed (${msg}); using local fallback`)
      result = null
    }
  }

  if (!result) {
    result = {
      kind: "local",
      replacementMessages: buildLocalCompactMessages({
        previous: input.messages,
        summaryText: undefined,
      }).map((m) => ({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content
            : m.content
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("\n"),
      })),
    }
    // Prefer a single checkpoint + empty tail when history was only the
    // checkpoint mapping above: re-run through buildLocalCompactMessages
    // for correct tail retention.
    const localMsgs = buildLocalCompactMessages({ previous: input.messages })
    replaceMessagesInPlace(input.messages, localMsgs)
    kind = "local"
  } else {
    replaceMessagesInPlace(input.messages, buildReplacementHistory(result.replacementMessages))
    kind = result.kind
  }

  const stats: CompactStats = {
    reason: input.reason,
    kind,
    messagesBefore,
    messagesAfter: input.messages.length,
    ...(remoteError && kind === "local" ? { remoteError } : {}),
  }
  input.appendNote?.(
    `compact: ${kind} reason=${input.reason} messages ${messagesBefore}→${stats.messagesAfter}` +
      (remoteError && kind === "local" ? ` remoteError=${remoteError}` : ""),
  )
  if (input.appendCompact && (stats.messagesAfter > 0 || stats.messagesBefore > 0)) {
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
    system: [{ type: "text", text: LOCAL_COMPACTION_PROMPT }],
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
