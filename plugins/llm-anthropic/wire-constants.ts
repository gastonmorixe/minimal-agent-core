/**
 * Wire constants for the Anthropic Messages API.
 *
 * This module is the single source of truth for the Anthropic/claude-code
 * wire identity the adapter sends: protocol version, User-Agent strings,
 * Stainless SDK version, and the build-info tuple the billing header carries.
 * These are claude-code mimicry values (the server sees them), so they live
 * in the provider plugin, never in core.
 *
 * Source of truth for VERSION / Stainless / billing-header format:
 * `cli.patched.cjs` at L166 (build-info object) and L117040 (`er_()`
 * billing-header builder) in claude-code 2.1.154.
 *
 * @module llm/providers/anthropic/wire-constants
 */

/**
 * claude-code CLI version string observed in the latest captured traffic
 * (2026-05-28). Sent in the User-Agent and the billing header; the server
 * validates/logs it. This is the upstream CLI's version we mimic, NOT
 * minimal-agent's own version (that's `AGENT_VERSION` in `src/build-info.ts`).
 */
export const VERSION = "2.1.154"

/**
 * Per-build hash suffix that appears in the billing header alongside VERSION
 * (`cc_version=${VERSION}.${BUILD_HASH}`). The server doesn't validate the
 * suffix, only logs it; we pin one deterministic value.
 */
export const BUILD_HASH = "d6e"

/**
 * Build timestamp + git sha. Not sent in requests, informational only.
 * Source: cli.patched.cjs L166-L212 (the build-info object) in v2.1.154.
 */
export const BUILD_TIME = "2026-05-28T12:27:24Z"
export const GIT_SHA = "b84d2da9ada13121515426fc644786a303e9ac53"

/**
 * Anthropic API version header value. Constant "2023-06-01" across every
 * version tracked (2.1.12 through 2.1.154).
 * @see cli.pretty.js L8389: `"anthropic-version": "2023-06-01"`.
 */
export const ANTHROPIC_VERSION = "2023-06-01"

/**
 * Messages API URL with the `?beta=true` query parameter. All real CLI
 * requests include it (set by the Stainless SDK's beta handling).
 */
export const API_URL = "https://api.anthropic.com/v1/messages?beta=true"

/**
 * User-Agent string for the Stainless SDK path that hits /v1/messages.
 * `claude-cli/${VERSION} (external, cli)` for the standard CLI entrypoint.
 */
export const USER_AGENT = `claude-cli/${VERSION} (external, cli)`

/**
 * User-Agent variants for non-Stainless endpoints:
 *   - `claude-code/${VERSION}`       → /api/oauth/account/settings
 *   - `claude-code/${VERSION} (cli)` → mcp-proxy.anthropic.com/v1/mcp/...
 */
export const USER_AGENT_OAUTH = `claude-code/${VERSION}`
export const USER_AGENT_MCP = `claude-code/${VERSION} (cli)`

/**
 * Stainless `@anthropic-ai/sdk` package version bundled into the CLI, sent as
 * `x-stainless-package-version`. 0.94.0 in v2.1.154 (live 2026-05-28 capture).
 */
export const STAINLESS_SDK_VERSION = "0.94.0"

/** Bootstrap endpoint introduced in v2.1.154. */
export const BOOTSTRAP_URL_BASE = "https://api.anthropic.com/api/claude_cli/bootstrap"

/** Models endpoint (`GET /v1/models?beta=true`). */
export const MODELS_URL = "https://api.anthropic.com/v1/models?beta=true"
