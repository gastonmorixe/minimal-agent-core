/**
 * Per-process session id — the provider-neutral conversation identifier.
 *
 * A random UUID v4 minted once per process and cached for its lifetime. It is
 * the value that keys this run's session files
 * (`~/.minimal-agent/sessions/<sid>.jsonl`), the file-lock holder identity, the
 * net-dbg capture dir, and the `MINIMAL_AGENT_SESSION_ID` env var the loader
 * publishes to plugin subprocesses. Nothing here is provider-specific: a
 * provider that wants the sid in its wire metadata (e.g. the Anthropic
 * `metadata.user_id` device fingerprint, see
 * `plugins/llm-anthropic/identity.ts`) reads it from the request context, not
 * by importing this module.
 *
 * @module session-id
 */

import { randomUUID } from "node:crypto"

// ---------------------------------------------------------------------------
// Session id (one per process)
// ---------------------------------------------------------------------------

let cachedSessionId: string | null = null

/**
 * Loose RFC-4122 shape check (8-4-4-4-12 hex). We accept any UUID-shaped
 * string, not strictly v4, so a caller can pass an externally-minted id
 * without us second-guessing the version nibble.
 */
function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

/**
 * Session ID resolution on first call:
 *
 *   1. An id seeded via {@link setSessionId} (the `--session-id` CLI flag).
 *   2. A fresh `randomUUID()` (the historical default).
 *
 * Cached for the process lifetime.
 *
 * NOTE: we deliberately do NOT auto-adopt `process.env.MINIMAL_AGENT_SESSION_ID`.
 * That var is published by {@link agentContextToEnv} for plugin SUBPROCESS
 * identity and is inherited broadly by anything the agent spawns (plugin
 * handlers, `bun test`, a child agent's grandchildren). Reading it here would
 * make a process silently reuse an ancestor's sid and collide on its session
 * file. A caller that wants to control a child's sid must pass it EXPLICITLY
 * via `--session-id` (which routes through {@link setSessionId}); the
 * supervising sub-agents plugin does exactly that.
 */
export function getSessionId(): string {
  if (!cachedSessionId) {
    cachedSessionId = randomUUID()
  }
  return cachedSessionId
}

/**
 * Seed the per-process session id explicitly, BEFORE the first
 * {@link getSessionId} call. Backs the `--session-id <uuid>` flag so a caller
 * (typically a parent agent spawning a headless child) controls the child's
 * sid deterministically and can locate its session files up front.
 *
 * Throws on a malformed id. Idempotent when `id` equals the already-resolved
 * value; throws if a DIFFERENT id was already resolved (changing it mid-flight
 * would split the session across two files).
 */
export function setSessionId(id: string): void {
  if (!isUuidLike(id)) {
    throw new Error(`setSessionId: not a UUID: ${JSON.stringify(id)}`)
  }
  if (cachedSessionId !== null && cachedSessionId !== id) {
    throw new Error(
      `setSessionId: already resolved as ${cachedSessionId}; refusing to change to ${id}`,
    )
  }
  cachedSessionId = id
}

/** Reset for testing — allows tests to get a fresh session ID */
export function _resetSessionId(): void {
  cachedSessionId = null
}
