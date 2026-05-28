/**
 * Wire constants for the Anthropic Messages API.
 *
 * Mirrors what `src/headers.ts` exposes today but lives inside the
 * provider directory so the adapter is self-contained. Re-exports from
 * `src/headers.ts` are kept for now to avoid a destructive move during
 * Phase 3 (we want byte-identical headers from both the legacy client
 * and the new adapter). Phase 7 collapses the duplication.
 *
 * Source of truth for VERSION / Stainless / billing-header format:
 * `cli.patched.cjs` at L166 (build-info object) and L117040 (`er_()`
 * billing-header builder) in claude-code 2.1.154.
 *
 * @module llm/providers/anthropic/wire-constants
 */

export {
  ANTHROPIC_VERSION,
  API_URL,
  BUILD_HASH,
  BUILD_TIME,
  GIT_SHA,
  STAINLESS_SDK_VERSION,
  USER_AGENT,
  USER_AGENT_MCP,
  USER_AGENT_OAUTH,
  VERSION,
} from "../../../headers.ts"

/** Bootstrap endpoint introduced in v2.1.154. */
export const BOOTSTRAP_URL_BASE = "https://api.anthropic.com/api/claude_cli/bootstrap"

/**
 * Models endpoint. Shared with the legacy client's `MODELS_URL`.
 */
export const MODELS_URL = "https://api.anthropic.com/v1/models?beta=true"
