/**
 * LOCAL structural re-declaration of the host surfaces this plugin
 * consumes. The decoupling contract: a plugin may NOT import host code
 * (`src/...`), not even type-only — it must be able to live in its own
 * repository. So we re-declare exactly the slice of the capability host
 * (`ctx.host`) and the handler context we use; TypeScript's structural
 * typing means the real frozen host satisfies these at runtime.
 *
 * The host-side source of truth for these shapes is
 * `src/plugins/host/capabilities.ts`. Keep field names in lockstep —
 * the integration test (`integration.test.ts`) dispatches through the
 * real loader and fails on drift.
 *
 * @module plugins/session-history/lib/host-types
 */

// ---------------------------------------------------------------------------
// sessions:read slice
// ---------------------------------------------------------------------------

export interface SessionIndexEntry {
  readonly sid: string
  readonly createdAt: string
  readonly cwd: string
  readonly model: string
}

export interface SessionLiveness {
  readonly status: "live" | "dead" | "unknown"
  readonly source: string
  readonly pid?: number
  readonly since?: string
  readonly reason?: string
}

export interface SessionMetaView {
  readonly sid: string
  readonly createdAt: string | null
  readonly cwd: string | null
  readonly model: string | null
  readonly agentVersion: string | null
  readonly parentSid: string | null
  readonly recordCount: number
  readonly counts: Readonly<Record<string, number>>
  readonly firstPrompt: string | null
  readonly lastActivity: string | null
  readonly liveness: SessionLiveness
  readonly hasTasks: boolean
  readonly hasScratch: boolean
  readonly blobCount: number
}

export interface RecordView {
  readonly index: number
  readonly kind: string
  readonly ts: string | null
  readonly summary: string
  readonly preview: string
  readonly clipped: boolean
  readonly fullChars: number
}

export interface RecordWindow {
  readonly sid: string
  readonly items: readonly RecordView[]
  readonly total: number
  readonly firstIndex: number | null
  readonly lastIndex: number | null
}

export interface ToolCallHit {
  readonly index: number
  readonly ts: string | null
  readonly tool: string
  readonly toolUseId: string | null
  readonly inputPreview: string
}

export interface SearchHit {
  readonly sid: string
  readonly index: number
  readonly ts: string | null
  readonly kind: string
  readonly preview: string
}

export interface SessionsReadApi {
  list(opts?: {
    cwd?: string
    query?: string
    limit?: number
    offset?: number
  }): Promise<{ items: readonly SessionIndexEntry[]; total: number }>
  meta(sid: string): Promise<SessionMetaView | null>
  window(
    sid: string,
    opts: { anchor: "start" | "end"; offset?: number; limit?: number; previewChars?: number },
  ): Promise<RecordWindow | null>
  toolCalls(
    sid: string,
    opts?: { tool?: string; limit?: number; offset?: number; newestFirst?: boolean },
  ): Promise<{ hits: readonly ToolCallHit[]; total: number } | null>
  search(opts: {
    sid?: string
    query: string
    limit?: number
    offset?: number
    previewChars?: number
    maxSessions?: number
  }): Promise<{ hits: readonly SearchHit[]; total: number; scannedSessions: number }>
  dump(
    sid: string,
    opts?: { format?: "markdown" | "xml" },
  ): Promise<{ text: string; bytes: number } | null>
}

// ---------------------------------------------------------------------------
// blobs:read slice
// ---------------------------------------------------------------------------

export interface BlobsReadApi {
  list(
    sid: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{
    items: readonly { toolUseId: string; bytes: number; mtime: string }[]
    total: number
  }>
  read(
    sid: string,
    toolUseId: string,
    opts?: { maxBytes?: number },
  ): Promise<{ text: string; bytes: number; clipped: boolean; path: string } | null>
}

// ---------------------------------------------------------------------------
// Context slice (what the handler reads off TUIContext)
// ---------------------------------------------------------------------------

export interface PluginHostSlice {
  readonly sessions?: SessionsReadApi
  readonly blobs?: BlobsReadApi
}

export interface ToolTriggerSlice {
  type: "tool"
  name: string
  input: Record<string, unknown>
  tool_use_id: string
}

export interface HandlerContextSlice {
  trigger: { type: string } & Partial<ToolTriggerSlice>
  cwd: string
  host?: PluginHostSlice
}

export interface ToolResultSlice {
  kind: "tool_result"
  content: string
  is_error?: boolean
  displayHeader?: string
}
