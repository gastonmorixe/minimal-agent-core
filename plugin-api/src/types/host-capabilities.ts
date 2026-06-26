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
 * `sessions:write`, `tasks:read`, and `memory:read` are reserved names
 * (declared so manifests validate forward) but not implemented in this
 * cut.
 */
export type CapabilityToken =
  | "sessions:read"
  | "sessions:write"
  | "blobs:read"
  | "tasks:read"
  | "memory:read"
  | "presence:read"
  | "models:read"
  | "models:register"
  | "paths"
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
  /** First user prompt, clipped. Cheap orientation. */
  readonly firstPrompt: string | null
  /** ISO timestamp of the newest record, or null when empty. */
  readonly lastActivity: string | null
  readonly liveness: SessionLiveness
  readonly modelChanges: readonly ModelChangeEntry[]
  readonly hasTasks: boolean
  readonly hasScratch: boolean
  readonly blobCount: number
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
  readonly kind: string
  readonly ts: string | null
  /** Compact role/summary, e.g. "assistant · 2 tool_use (Bash, Read)". */
  readonly summary: string
  /** Body text, already clipped to the requested preview budget. */
  readonly preview: string
  readonly clipped: boolean
  /** Full body length in chars (pre-clip), for "N more chars" hints. */
  readonly fullChars: number
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
  /** Clipped JSON of the call input. */
  readonly inputPreview: string
}

/** One hit from a text search across one or many sessions. */
export interface SearchHit {
  readonly sid: string
  readonly index: number
  readonly ts: string | null
  readonly kind: string
  readonly preview: string
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
  }): Promise<{ hits: readonly SearchHit[]; total: number; scannedSessions: number }>

  /** Full improved dump. Large; the caller is expected to warn first. */
  dump(
    sid: string,
    opts?: { format?: "markdown" | "xml" },
  ): Promise<{ text: string; bytes: number } | null>
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
 * `@minimal-agent/plugin-api/utils/agent-paths` directly; this capability is
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
  readonly blobs?: BlobsReadApi
  readonly presence?: PresenceReadApi
  readonly models?: ModelsReadApi
  readonly modelsRegistry?: ModelsRegisterApi
  readonly paths?: PathsApi
  readonly clock?: ClockApi
  readonly logger?: PluginLogger
}
