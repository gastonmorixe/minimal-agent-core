/**
 * Host capabilities — the decoupled, capability-oriented surface a plugin
 * consumes through its handler context (`ctx.host`).
 *
 * ## Why this exists
 *
 * A plugin must be able to live in its own repo. It may NOT import host
 * code (`src/...`) — not even type-only. So the host hands each plugin a
 * frozen {@link PluginHost} carrying exactly the capability namespaces
 * its manifest declared (`capabilities: ["sessions:read", ...]`). The
 * plugin re-declares the slice it uses as a LOCAL structural interface;
 * TypeScript's structural typing means the real frozen host satisfies it
 * at runtime. The types in THIS file are the host's source of truth:
 * `./factory.ts`'s `buildPluginHost` produces objects that satisfy them,
 * and `./providers/*` implement the backing logic against `src/session-*`
 * and `src/blob-store`.
 *
 * This is the single host-owned capability contract for plugins. Plugins
 * consume it structurally through the public plugin API; runtime backing logic
 * stays in this host package.
 *
 * @module plugins/host/capabilities
 */

import type { ProviderSessionInfo } from "@minimal-agent/plugin-api/llm/provider-plugin"

import type { PluginLogger } from "../../diagnostic-bus.ts"
import type { ModelEntry } from "../../llm/model-registry.ts"

import type { TransportRegistryApi } from "./transport-registry.ts"

// ---------------------------------------------------------------------------
// Capability tokens
// ---------------------------------------------------------------------------

/**
 * Capability namespaces a plugin can request in its manifest. Each maps
 * to a frozen sub-API on {@link PluginHost}. The loader populates ONLY
 * granted namespaces; everything else is `undefined`, so a plugin must
 * defensively check before use.
 *
 * `models:read` / `models:register` (Wave D-2) expose the live model registry
 * (`src/llm/model-registry.ts`) so a plugin can read the catalog (or register
 * into it) without importing `registerModel` / `resolveModel` from `src/`.
 *
 * `sessions:write` and `tasks:read` are reserved names (declared so manifests
 * validate forward) but not implemented in this cut.
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
  | "session-info:read"
  | "paths"
  | "transport:registry"
  | "clock"
  | "logger"

/** Every recognized token. Manifest validation rejects anything not here. */
export const KNOWN_CAPABILITIES: readonly CapabilityToken[] = [
  "sessions:read",
  "sessions:write",
  "blobs:read",
  "tasks:read",
  "memory:read",
  "presence:read",
  "models:read",
  "models:register",
  "session-info:read",
  "paths",
  "transport:registry",
  "clock",
  "logger",
] as const

/** Narrowing guard for an untrusted manifest string. */
export function isCapabilityToken(s: string): s is CapabilityToken {
  return (KNOWN_CAPABILITIES as readonly string[]).includes(s)
}

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
 * SAME agent-home resolver the core uses (`src/agent-paths.ts` →
 * `@minimal-agent/plugin-api/utils/agent-paths`) WITHOUT importing it. Each
 * method returns an absolute path already resolved against the boot-published
 * `MINIMAL_AGENT_HOME`, so a relocated home is honored uniformly.
 *
 * A plugin that takes a workspace dependency could import the leaf resolver
 * directly; this capability is the decoupled alternative for plugins living in
 * their own repo (which must NOT import the leaf at runtime) and for code that
 * already has `ctx.host` in hand. Read-only; pure path math, no IO.
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
 * `models:read` — read-only view of the live model registry
 * (`src/llm/model-registry.ts`). A plugin uses this to resolve a model's
 * capabilities / pricing / tags (e.g. memory's cheap-tier pick, session-info's
 * context-window lookup, model-info's report) without importing `resolveModel`
 * / `findModelByTags` from `src/`. The returned {@link ModelEntry} objects are
 * the registry's own records; treat them as read-only.
 */
export interface ModelsReadApi {
  /** Look up a model by id or alias. `undefined` when not registered. */
  find(idOrAlias: string): ModelEntry | undefined
  /** Look up a model by id or alias. Throws when not registered. */
  resolve(idOrAlias: string): ModelEntry
  /** Every registered model, in registration order. */
  list(): ModelEntry[]
  /**
   * First model for `providerId` whose `tags` include EVERY tag in `mustHave`
   * (insertion order wins). `undefined` when none match.
   */
  findByTags(providerId: string, mustHave: readonly string[]): ModelEntry | undefined
  /** The default model id a no-model session boots with. */
  defaultModelId(): string
}

/**
 * `models:register` — setup-time write access to the live model registry. A
 * provider plugin uses this to contribute its catalog (instead of importing
 * `registerModel` / `setDefaultModelId` from `src/`). Idempotent;
 * last-write-wins per id (collisions with an existing alias throw, surfacing
 * registration bugs early).
 *
 * NOTE (Wave D-2 finding): LLM provider plugins currently activate through the
 * dedicated provider loader (`src/llm/provider-discovery.ts` →
 * `ProviderPlugin.register()`, which takes no `ctx`), NOT through the TUI
 * capability host. So this namespace has no live provider consumer yet; it is
 * placed here so a future provider-loader convergence (or a TUI plugin that
 * needs to register a model) can use it without a new seam.
 */
export interface ModelsRegisterApi {
  /** Add or replace a model entry. Throws on id/alias collision. */
  register(entry: ModelEntry): void
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
 * importing `getSessionTokens` from `src/`.
 *
 * `contextSize` is the field to display (latest-turn input footprint); the
 * cumulative `cacheRead` / `total` are inflated for cache-heavy providers and
 * kept for debug parity, not user display. See the field notes on core's
 * `SessionTokens` for the inflation rationale.
 */
export interface SessionTokensView {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheCreate: number
  readonly total: number
  readonly turns: number
  readonly contextSize: number
}

/**
 * `session-info:read` — the live per-session provider + token snapshot the
 * `quota-status` / `session-info` footers render. Both pieces are host reads
 * the plugin must not do itself once it lives in its own repo:
 *
 *  - `providerInfo(modelId)` routes to the ACTIVE provider plugin's
 *    `fetchSessionInfo` (core `resolveProviderSessionInfo` in
 *    `src/llm/provider-session.ts`), returning the provider-neutral
 *    {@link ProviderSessionInfo} (quota windows, context window, model label).
 *    Async because a provider may probe the network; honors `signal`.
 *  - `tokens()` reads the process-wide session token counters (core
 *    `getSessionTokens` in `src/session-tokens.ts`) as a {@link SessionTokensView}.
 *
 * `ProviderSessionInfo` is already a leaf type
 * (`@minimal-agent/plugin-api/llm/provider-plugin`), so a plugin imports it
 * from the leaf and consumes it directly; `tokens()` returns the neutral view
 * above so no core `SessionTokens` import is needed.
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
  readonly sessionInfo?: SessionInfoReadApi
  readonly paths?: PathsApi
  /**
   * `transport:registry` — the host-brokered store a transport-PROVIDER plugin
   * (e.g. `minimal-agent-cloud`) writes into and a CONSUMER plugin (Intercom)
   * reads, so a remote transport reaches Intercom without either plugin
   * importing the other (dependency inversion, mirroring `models:register` /
   * `models:read`). Core treats a transport as opaque (`{id}`-only); the
   * consumer re-declares the full shape locally. See `./transport-registry.ts`.
   */
  readonly transportRegistry?: TransportRegistryApi
  readonly clock?: ClockApi
  readonly logger?: PluginLogger
}
