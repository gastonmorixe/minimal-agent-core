/**
 * Host capabilities — the decoupled, capability-oriented surface a plugin
 * consumes through its handler context (`ctx.host`). TYPE-ONLY contract slice.
 *
 * Wave D-1: `src/plugins/types.ts` (now the package's `types/plugin.ts`)
 * references {@link PluginHost} for the optional `host` field on
 * {@link TUIContext}. The runtime factory (`buildPluginHost`) and the
 * capability-token guard live in `src/plugins/host/` against real host state
 * (`src/session-*`, `src/blob-store`) and STAY there. This module is a
 * faithful, type-only structural copy of the host's capability surface so the
 * leaf contract package depends on nothing in `src/`. TypeScript's structural
 * typing makes the host's real frozen `PluginHost` satisfy this interface, so
 * the loader assigns it into a package-typed `TUIContext.host` without a cast.
 *
 * The host's `src/plugins/host/capabilities.ts` remains the runtime source
 * of truth; Wave D-3 (capability expansion) is where the two formally converge.
 *
 * @module types/host-capabilities
 */

import type { Capabilities } from "../llm/capabilities.ts"
import type { NetworkObserveApi } from "../net/types.ts"
import type { ProviderSessionInfo } from "../llm/provider-plugin.ts"
import type { UsagePeriod, UsageReport } from "../utils/usage-report.ts"

import type { PluginLogger } from "./logger.ts"

// ---------------------------------------------------------------------------
// Capability tokens
// ---------------------------------------------------------------------------

/**
 * Capability namespaces a plugin can request in its manifest. Each maps
 * to a frozen sub-API on {@link PluginHost}. The loader populates ONLY
 * granted namespaces; everything else is `undefined`, so a plugin must
 * defensively check before use.
 *
 * `tasks:read` and `memory:read` are reserved names. `sessions:write`
 * provides a narrow active-session history-edit transaction, not arbitrary
 * session filesystem access. `sessions:meta` gives {@link SessionMetaApi}
 * (session title read and write, with an explicit sid on each call).
 * `sessions:files` gives {@link SessionFilesApi} (immutable files of the plugin
 * in `<sessionsDir>/<sid>.files/<pluginId>/`).
 */
export type CapabilityToken =
  | "sessions:read"
  | "sessions:write"
  | "sessions:meta"
  | "sessions:files"
  | "blobs:read"
  | "tasks:read"
  | "memory:read"
  | "presence:read"
  | "models:read"
  | "models:register"
  | "session-info:read"
  | "llm:complete"
  | "usage:read"
  | "context:compact"
  | "paths"
  | "transport:registry"
  | "network:observe"
  | "clock"
  | "logger"

// ---------------------------------------------------------------------------
// Shared read-only value views
// ---------------------------------------------------------------------------

/** One row of the global session index. Cheap; no per-file read. */
export interface SessionIndexEntry {
  readonly sid: string
  readonly createdAt: string
  readonly cwd: string
  readonly model: string
}

/**
 * Liveness verdict. Baseline is the PID probe (`src/session-liveness.ts`);
 * when a presence producer is installed the `source` is `"presence"`.
 * `source: "none"` + `status: "unknown"` is the honest "I can't tell"
 * answer the plugin renders as "Unknown: missing Presence plugin".
 */
export type SessionLiveness =
  | {
      readonly status: "live"
      readonly source: "presence" | "pid"
      readonly pid?: number
      readonly since?: string
      readonly detail?: string
    }
  | { readonly status: "dead"; readonly source: "presence" | "pid"; readonly reason: string }
  | {
      readonly status: "unknown"
      readonly source: "presence" | "pid" | "none"
      readonly reason: string
    }

/**
 * One provider/model change in a session's lifetime. Reserved for when
 * model-change persistence lands; today the array is always empty
 * because the JSONL doesn't record changes yet.
 */
export interface ModelChangeEntry {
  readonly ts: string
  readonly fromModel: string
  readonly toModel: string
  readonly fromProvider?: string
  readonly toProvider?: string
  readonly effort?: string
}

/**
 * Always-available session metadata. Every sid-targeted action returns
 * this so the model never has to ask twice for "when / where / what
 * state". Fields not yet persisted (`provider`, `effort`, `modelChanges`)
 * are null/empty and the renderer is expected to say so honestly.
 */
export interface SessionMetaView {
  readonly sid: string
  readonly createdAt: string | null
  readonly cwd: string | null
  readonly model: string | null
  readonly provider: string | null
  readonly effort: string | null
  readonly agentVersion: string | null
  readonly parentSid: string | null
  /** Total records in the append-only log (upper bound of the stable-index space). */
  readonly recordCount: number
  /** Per-kind tally (user, assistant, tool_result, note, ...). */
  readonly counts: Readonly<Record<string, number>>
  /** Char budget for the first prompt line that the plugin builds. */
  readonly firstPromptChars: number
  /**
   * Raw first prompt: the first user record's text pieces
   * (one entry for string content, one per text block otherwise), or null
   * when the session has no user record. Unclipped, unnormalized.
   */
  readonly firstPromptParts: readonly string[] | null
  /** ISO timestamp of the newest record, or null when empty. */
  readonly lastActivity: string | null
  readonly liveness: SessionLiveness
  readonly modelChanges: readonly ModelChangeEntry[]
  readonly hasTasks: boolean
  readonly hasScratch: boolean
  readonly blobCount: number
  /**
   * The saved title that the catalog shows (display order: user, then ai, then
   * derived; SPEC §9.2). Absent when the sid has no saved title line; then
   * the first prompt is the fallback.
   */
  readonly title?: string
  /** The source of {@link title}. Absent when `title` is absent. */
  readonly titleSource?: TitleSource
}

/**
 * One record in a {@link RecordWindow}. `index` is the STABLE id: a
 * 0-based position in the append-only log that never shifts for an
 * existing record (writes only append). A running session growing at the
 * tail does not move a scanner's cursor over earlier records. `ts` rides
 * along so the model always has a time anchor.
 */
export interface RecordView {
  readonly index: number
  /** Stable user-record id, present only for user prompts. */
  readonly userId: string | null
  readonly kind: string
  readonly ts: string | null
  /** Effective preview budget (chars) requested for this record. */
  readonly previewChars: number
  /**
   * Unclipped body pieces, raw text only. The plugin adds any prefix per part
   * (by kind, toolName, role) and joins the parts. Core holds no prefix text.
   */
  readonly parts: readonly BodyPart[]
  /** Raw kind-specific values of the record. */
  readonly facts: RecordFacts
}

/** One piece of a record body, data only. */
export interface BodyPart {
  /** "text", "thinking", "tool_use", "tool_result", "message" (compact) or "raw" (unknown record). */
  readonly kind: string
  /** Raw text. For "tool_use" it is the JSON of the call input. */
  readonly text: string
  /** Tool name for "tool_use", else null. */
  readonly toolName: string | null
  /** Role for "message" parts only. */
  readonly role?: string
}

/**
 * Raw kind-specific values of a record. Absent or null when the kind has no such value.
 * An unknown record kind has all facts null (or zero/empty) and its raw JSON
 * is `parts[0].text` with kind "raw".
 */
export interface RecordFacts {
  /** user: content is a plain string. Null for other kinds. */
  readonly contentIsString: boolean | null
  /** user: tool_result block count. */
  readonly toolResultCount: number
  /** user: text block count. */
  readonly textBlockCount: number
  /** user: total block count. */
  readonly blockCount: number
  /** assistant: tool_use names in order. */
  readonly toolNames: readonly string[]
  /** assistant: has a text block. */
  readonly hasText: boolean
  /** assistant: raw stop reason. Null when absent. May be "": test truthiness in the plugin. */
  readonly stopReason: string | null
  /** tool_result: error flag. */
  readonly isError: boolean | null
  readonly toolUseId: string | null
  /** meta, target_switch */
  readonly model: string | null
  readonly cwd: string | null
  /** compact */
  readonly compactKind: string | null
  readonly reason: string | null
  readonly messagesBefore: number | null
  readonly messagesAfter: number | null
  /** rewind */
  readonly rewindTo: string | null
  readonly droppedCount: number | null
  /** history_edit */
  readonly backupSid: string | null
  readonly droppedRecordCount: number | null
  /** attach, detach */
  readonly pid: number | null
  /** attach */
  readonly hostname: string | null
  /** round_checkpoint */
  readonly round: number | null
}

/**
 * A stable, lazy window into a session's records. Only `items` crosses
 * into the plugin (and thus model context), never the whole transcript.
 * `total` is the full record count so the caller can compute next/prev
 * cursors without a second round-trip.
 */
export interface RecordWindow {
  readonly sid: string
  readonly items: readonly RecordView[]
  readonly total: number
  readonly firstIndex: number | null
  readonly lastIndex: number | null
}

/** One hit from a tool-call filter ("last 3 times Task was called"). */
export interface ToolCallHit {
  readonly index: number
  readonly ts: string | null
  readonly tool: string
  readonly toolUseId: string | null
  /** Raw tool input as stored. */
  readonly input: unknown
  /** JSON of `input`. Null means it cannot be serialized: the plugin supplies the text. */
  readonly inputJson: string | null
  /** Char budget requested for the input preview that the plugin builds. */
  readonly inputPreviewChars: number
}

/** One hit from a text search across one or many sessions. */
export interface SearchHit {
  readonly sid: string
  readonly index: number
  readonly ts: string | null
  readonly kind: string
  /**
   * Unclipped body pieces of the matched record (raw text, see `RecordView.parts`).
   * The body is `renderBody(parts)` when the caller passed `renderBody`, else the raw texts joined by a newline.
   */
  readonly parts: readonly BodyPart[]
  /**
   * Match start offset in the body (case-insensitive). The body is built by
   * `renderBody` when given. A match can lie inside text that `renderBody` adds.
   */
  readonly matchAt: number
  /** Match length in chars. */
  readonly matchLength: number
  /** Snippet budget (chars) requested for this search. */
  readonly previewChars: number
}

/** Metadata for one spilled tool-output blob. */
export interface BlobMeta {
  readonly toolUseId: string
  readonly bytes: number
  readonly mtime: string
}

// ---------------------------------------------------------------------------
// Capability sub-APIs
// ---------------------------------------------------------------------------

/** Options for {@link SessionsReadApi.window}. */
export interface WindowOpts {
  /** Anchor the window at the start (oldest) or end (newest) of history. */
  readonly anchor: "start" | "end"
  /** Records to skip from the anchor. Default 0. */
  readonly offset?: number
  /** Window size. Default 50, hard max 500. */
  readonly limit?: number
  /** Per-record body clip in chars. Default 600, min 80. */
  readonly previewChars?: number
}

// Structural copies of the core persisted shapes (`src/llm/messages.ts`,
// `src/session/session-store.ts`). A leaf type cannot import core internals.
// The drift test pins them equal to the core types.

/** Structural copy of the core `BlockCacheControl`. */
export type SessionBlockCacheControl = {
  type: "ephemeral"
  ttl?: "5m" | "1h"
  scope?: "global"
}

/** Structural copy of the core content block union. */
export type SessionContentBlock =
  | {
      type: "text"
      text: string
      cache_control?: SessionBlockCacheControl
      sideband?: { kind: string; origin?: string }
    }
  | { type: "thinking"; thinking: string; signature: string; cache_control?: SessionBlockCacheControl }
  | { type: "redacted_thinking"; data: string; cache_control?: SessionBlockCacheControl }
  | {
      type: "tool_use"
      id: string
      name: string
      input: Record<string, unknown>
      caller?: { type: string }
      cache_control?: SessionBlockCacheControl
    }
  | {
      type: "tool_result"
      tool_use_id: string
      content: string | SessionContentBlock[]
      is_error?: boolean
      cache_control?: SessionBlockCacheControl
    }
  | {
      type: "image"
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string }
        | { type: "file"; file_id: string }
      cache_control?: SessionBlockCacheControl
    }
  | {
      type: "document"
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string }
        | { type: "file"; file_id: string }
        | { type: "text"; media_type: "text/plain"; data: string }
      title?: string
      context?: string
      citations?: { enabled: boolean }
      cache_control?: SessionBlockCacheControl
    }

/** Structural copy of the core `Message`. */
export interface SessionMessage {
  role: "user" | "assistant" | "system"
  content: string | SessionContentBlock[]
}

/** Structural copy of the core `MetaRecord`. */
export interface SessionMetaRecord {
  kind: "meta"
  formatVersion: 1
  sid: string
  createdAt: string
  model: string
  cwd: string
  systemHash: string
  toolsHash: string
  agentVersion: string
  parentSid?: string
  forkedAt?: string
  provider?: string
  credentialName?: string
  backup?: boolean
  backupOfSid?: string
}

/** Structural copy of the core `SessionRecord` union. */
export type SessionStoreRecord =
  | SessionMetaRecord
  | {
      kind: "user"
      ts: string
      content: string | SessionContentBlock[]
      id?: string
    }
  | {
      kind: "assistant"
      ts: string
      content: SessionContentBlock[]
      stopReason: string | null
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
    }
  | {
      kind: "tool_result"
      ts: string
      tool_use_id: string
      content: string | SessionContentBlock[]
      isError: boolean
      rawPath?: string
      rawBytes?: number
      rawSha256?: string
    }
  | { kind: "note"; ts: string; text: string }
  | {
      kind: "compact"
      ts: string
      id?: string
      reason: "manual" | "auto" | "exceeded"
      compactKind: "remote" | "local"
      messagesBefore: number
      messagesAfter: number
      replacementMessages: Array<{
        role: "user" | "assistant" | "system"
        content: string | SessionContentBlock[]
      }>
      encryptedContent?: string
    }
  | { kind: "rewind"; ts: string; to: string; droppedCount: number }
  | {
      kind: "history_edit"
      ts: string
      targetUserId: string
      backupSid: string
      droppedRecordCount: number
    }
  | {
      kind: "round_checkpoint"
      ts: string
      round: number
      maxTokensStreak: number
      interruptedStreak: number
    }
  | {
      kind: "target_switch"
      ts: string
      providerId?: string
      credentialName?: string
      model: string
      effort?: string
      discardedThinking: boolean
    }
  | {
      kind: "attach"
      ts: string
      pid: number
      ppid: number
      startTime: string
      hostname: string
      agentVersion: string
    }
  | { kind: "detach"; ts: string; pid: number; reason: "exit" | "signal" | "error"; exitCode?: number }

/** Raw structured data of one session (data only, no text shaped by the host). */
export interface SessionRecordsView {
  readonly sid: string
  /** The meta record, or null when the file has none. */
  readonly meta: SessionMetaRecord | null
  /** Every parsed record, in file order. */
  readonly records: readonly SessionStoreRecord[]
  /** Model-facing messages (honors durable compact checkpoints). */
  readonly messages: readonly SessionMessage[]
}

/**
 * `sessions:read` — read-only access to the session store. The host does
 * the heavy scanning so only bounded results cross into plugin/model
 * context.
 */
export interface SessionsReadApi {
  list(opts?: {
    cwd?: string
    query?: string
    limit?: number
    offset?: number
  }): Promise<{ items: readonly SessionIndexEntry[]; total: number }>

  /** The saved title (user, AI, then derived), or null. Reads only the metadata sidecar. */
  title(sid: string): string | null

  /** Always-available metadata + liveness + counts. Null when sid unknown. */
  meta(sid: string): Promise<SessionMetaView | null>

  /** Stable-cursor window into records. Null when sid unknown. */
  window(sid: string, opts: WindowOpts): Promise<RecordWindow | null>

  /** Tool-call filter: "last/prev N/all times tool X was called". */
  toolCalls(
    sid: string,
    opts?: { tool?: string; limit?: number; offset?: number; newestFirst?: boolean },
  ): Promise<{ hits: readonly ToolCallHit[]; total: number } | null>

  /** Text search inside one session (sid set) or across recent sessions (sid omitted). */
  search(opts: {
    sid?: string
    query: string
    limit?: number
    offset?: number
    previewChars?: number
    maxSessions?: number
    /** Builds the body that `query` is matched against, from the raw parts. Default: texts joined by a newline. */
    renderBody?: (parts: readonly BodyPart[]) => string
  }): Promise<{ hits: readonly SearchHit[]; total: number; scannedSessions: number }>

  /** Raw records, meta and messages of one session. Null for an unknown sid. */
  records(sid: string): Promise<SessionRecordsView | null>
}

/** Narrow active-session history-edit transaction. */
export interface SessionsWriteApi {
  beginHistoryEdit(input: { targetUserId: string }): Promise<
    | {
        ok: true
        backupSid: string
        selectedText: string
        targetRecordIndex: number
        userPromptOrdinal: number
        totalUserPrompts: number
      }
    | { ok: false; code: string; message: string }
  >
  commitHistoryEdit(input: {
    targetUserId: string
    backupSid: string
  }): Promise<{ ok: true; droppedRecordCount: number } | { ok: false; code: string; message: string }>
}

/** `blobs:read` — spilled tool-output access for a session. */
export interface BlobsReadApi {
  list(
    sid: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ items: readonly BlobMeta[]; total: number }>
  read(
    sid: string,
    toolUseId: string,
    opts?: { maxBytes?: number },
  ): Promise<{ text: string; bytes: number; clipped: boolean; path: string } | null>
}

/**
 * `presence:read` — best-effort "is this agent running and what's it
 * doing". Backed by `~/.minimal-agent/presence.jsonl` (agent-mesh). When
 * that file is absent every method returns the `unavailable`/`unknown`
 * shape so the plugin can be honest.
 */
export interface PresenceReadApi {
  /** True when a presence producer is installed (the jsonl exists). */
  available(): boolean
  /** Liveness for one sid via presence; `unknown/none` when unavailable. */
  liveness(sid: string): Promise<SessionLiveness>
}

/** `clock` — injectable now(), so time-dependent rendering is testable. */
export interface ClockApi {
  now(): number
  iso(): string
}

/**
 * `paths` — the host's resolved storage locations, so a plugin reaches the
 * SAME agent-home resolver the core uses WITHOUT importing it. Each method
 * returns an absolute path already resolved against the boot-published
 * `MINIMAL_AGENT_HOME`, so a relocated home is honored uniformly.
 *
 * A plugin that takes a workspace dependency could import
 * `@minimal-agent/core/plugin-api/utils/agent-paths` directly; this capability is
 * the decoupled alternative for plugins living in their own repo (which must
 * NOT import the package at runtime) and for code that already has `ctx.host`.
 * Read-only; pure path math, no IO.
 */
export interface PathsApi {
  /** The agent home directory (`MINIMAL_AGENT_HOME` or `~/.minimal-agent`). */
  home(): string
  /** The sessions directory (`<home>/sessions`). */
  sessionsDir(): string
  /** The network-debug capture directory (`<home>/net-dbg`). */
  netDbgDir(): string
}

// ---------------------------------------------------------------------------
// models:read / models:register (Wave D-2)
// ---------------------------------------------------------------------------

/**
 * Per-1M-token USD rates for a model — provider-neutral, structurally
 * identical to the host's `MTokRate` (which stays in `src/llm/pricing.ts`,
 * token-free but not yet moved). Declared here so the leaf package depends on
 * nothing in `src/`; the host's real rate object satisfies it structurally.
 */
export interface ModelRate {
  inputUSD: number
  outputUSD: number
  cacheWriteUSD: number
  /** Optional 1 hour TTL cache write rate. Unset: every write uses `cacheWriteUSD`. */
  cacheWrite1hUSD?: number
  cacheReadUSD: number
  webSearchPerCallUSD: number
  reasoningUSD?: number
}

/**
 * One model record, provider-neutral projection of the host's `ModelEntry`
 * (`src/llm/model-registry.ts`). `surfaceId` is a plain string here (the host's
 * `SurfaceId` is a token-bearing union that stays in `src/`), and the optional
 * per-request / estimator closures are omitted from the contract slice. The
 * host's real `ModelEntry` is assignable to this, so the loader hands the real
 * registry view into a package-typed `ctx.host.models` without a cast.
 */
export interface ModelView {
  id: string
  aliases?: ReadonlyArray<string>
  providerId: string
  surfaceId: string
  displayName: string
  knowledgeCutoff?: string
  tags?: ReadonlyArray<string>
  capabilities: Capabilities
  pricing: ModelRate
  /**
   * Per-cloud-vendor model ids (e.g. `{ firstParty: "deepseek-v4-flash" }`).
   * Read-only projection of the host `ModelEntry.vendorIds`; a provider adapter
   * reads `firstParty` to map a registry id onto the wire model id. Optional:
   * absent when the model declares none.
   */
  vendorIds?: Readonly<Record<string, string>>
}

/**
 * `models:read` — read-only view of the live model registry. A plugin uses
 * this to resolve a model's capabilities / pricing / tags without importing
 * `resolveModel` / `findModelByTags` from `src/`. Treat returned records as
 * read-only.
 */
export interface ModelsReadApi {
  /** Look up a model by id or alias. `undefined` when not registered. */
  find(idOrAlias: string): ModelView | undefined
  /**
   * Provider-scoped lookup: the entry `providerId` registered for this id or
   * alias. `undefined` when that provider does not serve it (no cross-provider
   * fallback, unlike `find`, which is last-write-wins across providers).
   */
  findForProvider(idOrAlias: string, providerId: string): ModelView | undefined
  /** Look up a model by id or alias. Throws when not registered. */
  resolve(idOrAlias: string): ModelView
  /** Every registered model, in registration order. */
  list(): ModelView[]
  /**
   * First model for `providerId` whose `tags` include EVERY tag in `mustHave`
   * (insertion order wins). `undefined` when none match.
   */
  findByTags(providerId: string, mustHave: readonly string[]): ModelView | undefined
  /** The default model id a no-model session boots with. */
  defaultModelId(): string
  /**
   * The cheap utility model of `providerId` (default: the live session
   * provider): the adapter `recommendUtilityModel()` only (no tag fallback).
   * `undefined` when the provider gives no recommendation, or when the model
   * is above the price ceilings. Optional: older hosts.
   */
  utilityFor?(providerId?: string): ResolvedUtilityModel | undefined
}

/** Result of {@link ModelsReadApi.utilityFor}. */
export interface ResolvedUtilityModel {
  modelId: string
  providerId: string
  /** `"none"` ⇒ no JSON-schema output; a title plugin makes no call. */
  structured: "json_schema" | "none"
  /** True when the adapter maps `thinking: "off"` for this model. */
  thinkingOff?: boolean
  /** Provider-chosen reasoning effort (from the recommendation). */
  effort?: "low" | "medium" | "high"
  /** Stream mode (from the recommendation). Absent ⇒ `"required"`. */
  stream?: "off" | "required"
  /** Registry price of the model. `undefined` when the model is not registered. */
  pricing?: ModelRate
}

/**
 * `models:register` — setup-time write access to the live model registry. A
 * provider plugin uses this to contribute its catalog instead of importing
 * `registerModel` / `setDefaultModelId` from `src/`. Idempotent;
 * last-write-wins per id.
 */
export interface ModelsRegisterApi {
  /** Add or replace a model entry. Throws on id/alias collision. */
  register(entry: ModelView): void
  /** Declare the default model id a no-model session should boot with. */
  setDefault(id: string | null): void
}

// ---------------------------------------------------------------------------
// session-info:read (Wave G)
// ---------------------------------------------------------------------------

/**
 * Cumulative token counters for the current session. A provider-neutral,
 * read-only view of core's `SessionTokens` (`src/session-tokens.ts`) so a
 * plugin renders the "tokens this session" / context-size footer WITHOUT
 * importing `getSessionTokens` from `src/`. Display `contextSize`; the
 * cumulative `cacheRead` / `total` are inflated for cache-heavy providers.
 */
export interface SessionTokensView {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheCreate: number
  /** Of `cacheCreate`, the 1 hour TTL writes. Optional for older hosts. */
  readonly cacheCreate1h?: number
  /** Thinking tokens, a part of `output`. Optional for older hosts. */
  readonly thinking?: number
  /** Billed server web-search calls. Optional for older hosts. */
  readonly webSearchRequests?: number
  readonly total: number
  readonly turns: number
  readonly contextSize: number
  readonly contextSizeEstimated: boolean
}

/**
 * `session-info:read` — the live per-session provider + token snapshot the
 * `quota-status` / `session-info` footers render. `providerInfo(modelId)`
 * routes to the active provider's `fetchSessionInfo` (core
 * `resolveProviderSessionInfo`), returning the leaf {@link ProviderSessionInfo}
 * (quota windows, context window, model label). `tokens()` reads the
 * process-wide session counters as a {@link SessionTokensView}. Both are host
 * reads a plugin must not do itself once it lives in its own repo.
 */
export interface SessionInfoReadApi {
  /** Resolve the active provider's session snapshot for `modelId`. */
  providerInfo(
    modelId: string,
    opts?: { signal?: AbortSignal; providerId?: string },
  ): Promise<ProviderSessionInfo>
  /** Read the cumulative session token counters. */
  tokens(): SessionTokensView
}

// ---------------------------------------------------------------------------
// llm:complete (Wave G)
// ---------------------------------------------------------------------------

/** A one-shot, non-streaming LLM completion request. See {@link LlmCompleteApi}. */
export interface LlmCompleteRequest {
  /** Model id to complete against. Absent ⇒ the host's default summary model. */
  model?: string
  /** System prompt text. */
  system: string
  /** The single user turn's text. */
  userText: string
  /** Max output tokens. Host applies a sensible default when absent. */
  maxTokens?: number
  /** Per-call timeout in ms. Host applies a default when absent. */
  timeoutMs?: number
}

/**
 * `llm:complete` — a host-run, one-shot text completion so a plugin (e.g.
 * `memory`'s summary regen) can call the model WITHOUT importing the auth resolver /
 * `canonicalSendFn` from `src/`. The whole auth → send → drain pipeline stays
 * host-side; the plugin passes content and receives text. Reserved for
 * background, non-interactive completions (summaries, titles).
 */
export interface LlmCompleteApi {
  /** Run a one-shot completion; resolves to the model's full text response. */
  complete(req: LlmCompleteRequest): Promise<string>
  /**
   * One bounded side call with a rich result (one attempt, no retry). Never
   * throws on timeout or abort: read `stopReason`. Usage goes to the aux
   * bucket, not to `turns` / `contextSize`. Optional: older hosts.
   */
  request?(req: LlmSideRequest): Promise<LlmSideResult>
}

/** Purpose of a side call. All values use the auxiliary transport class. */
export type LlmSidePurpose = "title" | "summary" | "aux"

/** JSON-schema output request for {@link LlmSideRequest.outputSchema}. */
export interface LlmSideOutputSchema {
  /** Schema name, e.g. `"session_title"`. */
  name: string
  /** JSON Schema object. Keep it constant (provider grammar cache). */
  schema: Record<string, unknown>
  /** Default `true`. */
  strict?: boolean
}

/** Request for {@link LlmCompleteApi.request}. */
export interface LlmSideRequest extends LlmCompleteRequest {
  /**
   * Default `"aux"`. For every purpose, `model` is REQUIRED (no default-model
   * fallback) and the default price ceilings apply (input 1.0, output 5.0 USD
   * per 1M tokens; an unknown price ⇒ no send).
   */
  purpose?: LlmSidePurpose
  /** Maps to the transport `outputConfig.format` (`json_schema`). */
  outputSchema?: LlmSideOutputSchema
  /** `"off"` ⇒ the adapter disables thinking when the model allows it. */
  thinking?: "off" | "default"
  /** Output effort, when the model supports it. */
  effort?: "low" | "medium" | "high"
  /** Aborts the call (with `timeoutMs`, one controller feeds the transport). */
  abortSignal?: AbortSignal
  /** Price ceiling in USD per 1M input tokens (default 1.0). Unknown price ⇒ no send. */
  maxUsdPerMTokIn?: number
  /** Price ceiling in USD per 1M output tokens (default 5.0). Unknown price ⇒ no send. */
  maxUsdPerMTokOut?: number
  /**
   * Allow a model of another provider than the session provider (SPEC M6).
   * Default `false`: such a request is rejected with `reason: "other-provider"`.
   */
  allowOtherProvider?: boolean
}

/** Token usage of one side call. */
export interface LlmSideUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Stop reason of a side call. Open string for provider-specific values. */
export type LlmSideStopReason =
  | "end_turn"
  | "max_tokens"
  | "refusal"
  | "timeout"
  | "aborted"
  | "error"
  | (string & {})

/** Result of {@link LlmCompleteApi.request}. */
export interface LlmSideResult {
  /** Concatenated text blocks; thinking blocks dropped. */
  text: string
  /** Parsed JSON, set when `outputSchema` was given and the text parsed. */
  json?: unknown
  stopReason: LlmSideStopReason
  model: string
  provider: string
  usage: LlmSideUsage
  /** From the model price entry, when known. */
  costUsd?: number
  latencyMs: number
  /** Set on a rejection, an error, a timeout, an abort, or a JSON parse failure. */
  reason?: LlmSideReason
  /** Short error text (no secrets, max 200 chars), for a debug log. */
  detail?: string
}

/** Why a side call stopped before or after the send. Machine-readable. */
export type LlmSideReason =
  | "no-model"
  | "unknown-model"
  | "over-ceiling"
  | "unknown-price"
  | "other-provider"
  | "no-session-provider"
  | "auth"
  | "timeout"
  | "aborted"
  | "transport"
  | "invalid-json"

// ---------------------------------------------------------------------------
// sessions:meta (session titles)
// ---------------------------------------------------------------------------

/** Origin of a session title. `derived` is computed at read time, normally not written. */
export type TitleSource = "ai" | "user" | "derived"

/** Usage that a title line can carry. */
export interface SessionTitleUsage {
  inputTokens: number
  outputTokens: number
  costUsd?: number
}

/**
 * One title line of the sidecar `index-meta.jsonl`. This is the single
 * definition: the core record `IndexTitleRecord`
 * (`src/session/session-title.ts`) is an alias of this type.
 */
export interface SessionTitleRecordView {
  kind: "title"
  v: 1
  sid: string
  /** At most 80 chars after sanitize. Empty on a `user` line ⇒ "no user title". */
  title: string
  source: TitleSource
  model?: string
  provider?: string
  usage?: SessionTitleUsage
  /** ISO time. */
  at: string
}

/** Input of {@link SessionMetaApi.setTitle}. */
export interface SessionTitleInput {
  /** The sid captured from the event payload. Core checks it; never a cached sid. */
  sid: string
  title: string
  source: TitleSource
  model?: string
  provider?: string
  usage?: SessionTitleUsage
}

/** Merged title state of one sid: the last line per source. */
export interface SessionTitleState {
  ai?: SessionTitleRecordView
  user?: SessionTitleRecordView
  derived?: SessionTitleRecordView
}

/**
 * `sessions:meta` — read and write session titles in the sidecar. Each call
 * takes an explicit `sid`; core rejects a sid that this process does not own.
 */
export interface SessionMetaApi {
  /** Merged read for `sid` (reads the sidecar). */
  getTitle(sid: string): SessionTitleState
  /**
   * Validate, sanitize, cap, and append one line. No write when the sid is
   * rejected, the title is empty, or `source:"ai"` meets a user title.
   */
  setTitle(input: SessionTitleInput): Promise<void>
}

// ---------------------------------------------------------------------------
// sessions:files
// ---------------------------------------------------------------------------

/**
 * Result of {@link SessionFilesApi.create}. `"exists"`: the name is taken (no
 * overwrite). `"over-cap"`: the file or the plugin dir of the sid is over its
 * byte cap. `"error"`: a bad sid or name, or a file system error.
 */
export type SessionFileCreate = "ok" | "exists" | "over-cap" | "error"

/**
 * `sessions:files` — immutable files of one plugin in one session, at
 * `<sessionsDir>/<sid>.files/<pluginId>/<name>`. A fork of the session keeps
 * them, and the cleanup of an unused session removes them. There is no delete
 * and no overwrite. `name` must agree with `^[a-z0-9][a-z0-9._-]{0,63}$` and
 * must not hold `..`.
 */
export interface SessionFilesApi {
  /** Exclusive create of <sessionsDir>/<sid>.files/<pluginId>/<name>. Never overwrites. */
  create(sid: string, name: string, data: string): SessionFileCreate
  /** The UTF-8 text of the file, or null when it is missing (or the sid or name is bad). */
  read(sid: string, name: string): string | null
  /** The size of the file, or null when it is missing (or the sid or name is bad). */
  stat(sid: string, name: string): { bytes: number } | null
  /** The file count and the bytes of the plugin dir of `sid`, read from the disk. */
  usage(sid: string): { files: number; bytes: number }
}

// ---------------------------------------------------------------------------
// usage:read (Wave G)
// ---------------------------------------------------------------------------

/**
 * `usage:read` — folded token/cost usage reports for the `/usage` overlay. The
 * heavy work (scanning the sessions dir, decoding events, pricing them against
 * the model registry) stays host-side; only the bounded {@link UsageReport}
 * crosses into the plugin, so the usage plugin never imports `scanUsageEvents`
 * / `aggregateUsage` from `src/`. `UsageReport` / `UsagePeriod` are sibling leaf
 * types (`../utils/usage-report`), so results are consumed directly.
 */
export interface UsageReadApi {
  /** Fold usage for ONE period (single scan). */
  report(period: UsagePeriod): UsageReport
  /** Fold usage for EVERY period from one scan (for the overlay's switcher). */
  reports(): Record<UsagePeriod, UsageReport>
}

// ---------------------------------------------------------------------------
// context:compact — queue-only compact request (parity with host)
// ---------------------------------------------------------------------------

/** Queue options for {@link ContextCompactApi.requestCompact}. */
export interface RequestCompactOpts {
  readonly reason?: string
  readonly mode?: string
  readonly keepTail?: number
  readonly focus?: string
}

/** Result of a queue request. Queue semantic only, never compacts inline. */
export interface RequestCompactResult {
  readonly queued: boolean
}

/**
 * `context:compact` — queue-only compact request. The plugin asks, the
 * agent loop drains between tool rounds via the existing compact path.
 */
export interface ContextCompactApi {
  requestCompact(opts?: RequestCompactOpts): RequestCompactResult | Promise<RequestCompactResult>
}

// ---------------------------------------------------------------------------
// transport:registry — host-brokered transport injection seam
// ---------------------------------------------------------------------------

/**
 * The minimal contract core requires of a registered transport: a stable,
 * non-empty `id`. Everything else is OPAQUE to the host — the consuming plugin
 * (Intercom) re-declares the full transport shape (presence + messaging) as its
 * own local structural interface and narrows the objects it reads back. Core is
 * a neutral broker; this leaf type is its structural copy of the host's
 * `RegisteredTransport`.
 */
export interface RegisteredTransport {
  readonly id: string
}

/**
 * `transport:registry` — the host-brokered store a transport-PROVIDER plugin
 * (e.g. `minimal-agent-cloud`) writes into and a CONSUMER plugin (Intercom)
 * reads, so a remote transport reaches the consumer WITHOUT either plugin
 * importing the other (dependency inversion, same shape as `models:register` /
 * `models:read`). The backing store is process-wide, so the provider's
 * `register` and the consumer's `list` observe the same set even though each
 * plugin gets its own frozen {@link PluginHost}.
 */
export interface TransportRegistryApi {
  /** Register (or replace) a transport. Idempotent, last-write-wins per `id`. */
  register(transport: RegisteredTransport): void
  /** Remove a transport by id (provider teardown on disconnect). No-op when absent. */
  unregister(id: string): void
  /** Every currently-registered transport, in registration order. */
  list(): RegisteredTransport[]
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/**
 * The frozen capability host handed to a plugin via `ctx.host`. Only
 * the namespaces the manifest declared are populated; the rest are
 * `undefined`. The optionality is deliberate — a plugin must check
 * (`if (!host.sessions) return error`) before use.
 */
export interface PluginHost {
  readonly capabilities: readonly CapabilityToken[]
  readonly sessions?: SessionsReadApi
  readonly sessionsWrite?: SessionsWriteApi
  /** `sessions:meta` — session titles (see {@link SessionMetaApi}). */
  readonly sessionMeta?: SessionMetaApi
  /** `sessions:files` — immutable files of the plugin in a session (see {@link SessionFilesApi}). */
  readonly sessionFiles?: SessionFilesApi
  readonly blobs?: BlobsReadApi
  readonly presence?: PresenceReadApi
  readonly models?: ModelsReadApi
  readonly modelsRegistry?: ModelsRegisterApi
  readonly sessionInfo?: SessionInfoReadApi
  readonly llm?: LlmCompleteApi
  readonly usage?: UsageReadApi
  readonly compact?: ContextCompactApi
  readonly paths?: PathsApi
  /**
   * `transport:registry` — host-brokered remote-transport injection seam (see
   * {@link TransportRegistryApi}). A provider plugin registers a transport; a
   * consumer plugin lists them. Decoupled: neither imports the other.
   */
  readonly transportRegistry?: TransportRegistryApi
  /**
   * `network:observe` : read-only taps on the raw traffic of the host network
   * client (see {@link NetworkObserveApi}).
   */
  readonly network?: NetworkObserveApi
  readonly clock?: ClockApi
  readonly logger?: PluginLogger
}
