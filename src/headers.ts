/**
 * Headers module: request header construction matching CLI v2.1.91 traffic.
 *
 * Every constant in this file was extracted from cli.pretty.js and verified
 * against real captured traffic in .node-net-dbg/. Updated from v2.1.87 to
 * v2.1.91 based on live capture from 2026-04-04.
 */

import { randomUUID } from "node:crypto";
import type { AuthResult } from "./auth.ts";

// ---------------------------------------------------------------------------
// Constants (from cli.pretty.js)
// ---------------------------------------------------------------------------

/**
 * CLI version string, embedded in the bundle at L240496.
 * Used in User-Agent, billing header, and debug output.
 */
export const VERSION = "2.1.91";

/**
 * Build timestamp from the bundle at L240499.
 * Not sent in requests — informational only.
 */
export const BUILD_TIME = "2026-04-04T00:00:00Z"; // approximate, from v2.1.91

/**
 * Anthropic API version header value.
 * @see cli.pretty.js L8389: `"anthropic-version": "2023-06-01"`
 * Also at L611391: `oYK = "2023-06-01"` and L792388: `var Dhz = "2023-06-01"`.
 * This has been "2023-06-01" across all versions we've tracked (2.1.12 through 2.1.87).
 */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Messages API URL with `?beta=true` query parameter.
 *
 * The `?beta=true` was discovered in captured traffic — all real CLI requests
 * include it. It's set by the Stainless SDK's beta parameter handling, not
 * manually constructed by the CLI code. The SDK's `list()` method at L5069
 * and the request builder add it when beta flags are present.
 */
export const API_URL = "https://api.anthropic.com/v1/messages?beta=true";

/**
 * User-Agent string.
 *
 * Constructed by `eh()` at L240489-240501:
 *   `claude-cli/${VERSION} (external, ${ENTRYPOINT}${sdkVersion}${clientApp}${workload})`
 *
 * For the standard CLI entrypoint without SDK embedding, this simplifies to:
 *   `claude-cli/2.1.87 (external, cli)`
 *
 * Note: there's also a `claude-code/` variant (L240516) used by the Agent SDK,
 * and a plain `claude-code/VERSION` variant (L240531). The `claude-cli/` form
 * is what the interactive CLI sends and what the server expects for OAuth.
 */
export const USER_AGENT = `claude-cli/${VERSION} (external, cli)`;

/**
 * Beta feature flags sent in the `anthropic-beta` header.
 *
 * These are assembled in `i01()` (L238652-238689) based on auth type,
 * model, and environment. The variable definitions are at L138458-138468.
 *
 * The order and set of flags varies by request type:
 *   - Haiku quota-check: omits "claude-code-20250219" (non-haiku-only flag)
 *   - Full conversation: all 5 flags
 *
 * In captured traffic (.node-net-dbg), the quota check (fetch-002) has 4 flags
 * while conversation requests (fetch-033+) have all 5. We include all 5 since
 * this agent sends real conversation requests.
 *
 * Each flag is documented with:
 *   - id: the string sent in the header
 *   - description: what it enables (inferred from code context and naming)
 *   - source: exact line in cli.pretty.js where the variable is defined
 *   - condition: when the CLI includes it (from the i01() assembly logic)
 */
export interface BetaFlag {
  id: string;
  description: string;
  source: string;
  condition: string;
}

export const BETA_FLAGS_DETAILED: BetaFlag[] = [
  {
    id: "claude-code-20250219",
    description: "Claude Code features: tool schemas, system prompt allowlist validation, billing attribution",
    source: "L138458: Uw8 = \"claude-code-20250219\"",
    condition: "Included for non-haiku models (L238657: `if (!_) K.push(Uw8)` where _ is isHaiku)",
  },
  {
    id: "oauth-2025-04-20",
    description: "OAuth authentication support for first-party (claude.ai) tokens",
    source: "L38022: SX = \"oauth-2025-04-20\"",
    condition: "Always included when using OAuth (p7() is true at L238658)",
  },
  {
    id: "context-1m-2025-08-07",
    description: "Enables 1M token context window for supported models",
    source: "Observed in v2.1.91 capture for opus conversation requests",
    condition: "Included for full conversation requests with large-context models",
  },
  {
    id: "interleaved-thinking-2025-05-14",
    description: "Extended thinking with interleaved text output (think -> text -> think -> text)",
    source: "L138459: p54 = \"interleaved-thinking-2025-05-14\"",
    condition: "Included unless DISABLE_INTERLEAVED_THINKING env is set, and model supports it (L238661-238664)",
  },
  {
    id: "redact-thinking-2026-02-12",
    description: "Redacts thinking block content, returns empty thinking with cryptographic signature",
    source: "Observed in v2.1.91 capture — present in ALL request types",
    condition: "Always included for OAuth (replaces visible thinking content with signatures)",
  },
  {
    id: "context-management-2025-06-27",
    description: "Server-side context window management (auto-compression, prioritization)",
    source: "L138461: Qw8 = \"context-management-2025-06-27\"",
    condition: "Included when first-party and USE_API_CONTEXT_MANAGEMENT env or model qualifies via ZB9() (L238677)",
  },
  {
    id: "prompt-caching-scope-2026-01-05",
    description: "Scoped prompt caching: cache_control blocks persist across requests in a session",
    source: "L138468: tB6 = \"prompt-caching-scope-2026-01-05\"",
    condition: "Always included for first-party auth (L238682: unconditional when Wx() is true)",
  },
  {
    id: "advanced-tool-use-2025-11-20",
    description: "Enhanced tool use capabilities (parallel tool calls, improved JSON streaming)",
    source: "Observed in v2.1.91 capture for full conversation requests",
    condition: "Included for full conversation requests with tool definitions",
  },
  {
    id: "effort-2025-11-24",
    description: "Enables the effort parameter in output_config for controlling model computation",
    source: "Observed in v2.1.91 capture for full conversation requests",
    condition: "Included when output_config.effort is set",
  },
  {
    id: "structured-outputs-2025-12-15",
    description: "JSON schema-based structured outputs via output_config.format",
    source: "Observed in v2.1.91 capture for title generation requests",
    condition: "Included when output_config.format is set (e.g. title generation)",
  },
];

/** All beta flag IDs */
export const BETA_FLAGS = BETA_FLAGS_DETAILED.map((f) => f.id);

/**
 * Request types that determine which beta flags to include.
 *
 * Observed in v2.1.91 capture:
 *   - "quota": 5 flags (no claude-code-20250219, no conversation-specific flags)
 *   - "title": 6 flags (adds structured-outputs-2025-12-15)
 *   - "conversation": 9 flags (all flags for full agentic behavior)
 */
export type RequestType = "quota" | "title" | "conversation";

/**
 * Build the beta flags array for a specific request type.
 *
 * Observed flag sets in the v2.1.91 capture (April 4, 2026):
 *
 * Quota check (haiku, max_tokens=1):
 *   oauth, interleaved-thinking, redact-thinking, context-management, prompt-caching-scope
 *
 * Title gen (haiku, structured output):
 *   oauth, interleaved-thinking, redact-thinking, context-management, prompt-caching-scope,
 *   structured-outputs
 *
 * Full conversation (opus):
 *   claude-code, oauth, context-1m, interleaved-thinking, redact-thinking,
 *   context-management, prompt-caching-scope, advanced-tool-use, effort
 */
export function buildBetaFlags(
  requestType: RequestType = "conversation",
  model?: string,
): string[] {
  switch (requestType) {
    case "quota":
      return [
        "oauth-2025-04-20",
        "interleaved-thinking-2025-05-14",
        "redact-thinking-2026-02-12",
        "context-management-2025-06-27",
        "prompt-caching-scope-2026-01-05",
      ];
    case "title":
      return [
        "oauth-2025-04-20",
        "interleaved-thinking-2025-05-14",
        "redact-thinking-2026-02-12",
        "context-management-2025-06-27",
        "prompt-caching-scope-2026-01-05",
        "structured-outputs-2025-12-15",
      ];
    case "conversation": {
      const flags = [
        "claude-code-20250219",
        "oauth-2025-04-20",
      ];
      // context-1m: enabled when model has [1m] suffix (client-side convention)
      // or for opus models by default (in v2.1.91 capture, opus always had this flag)
      const wants1m = model
        ? /\[1m\]/i.test(model) || model.includes("opus")
        : false;
      if (wants1m) {
        flags.push("context-1m-2025-08-07");
      }
      flags.push(
        "interleaved-thinking-2025-05-14",
        "redact-thinking-2026-02-12",
        "context-management-2025-06-27",
        "prompt-caching-scope-2026-01-05",
        "advanced-tool-use-2025-11-20",
        "effort-2025-11-24",
      );
      return flags;
    }
  }
}

/**
 * Stainless SDK package version.
 * @see cli.pretty.js L3573: `var ts = "0.74.0"`
 * This is the version of the `@anthropic-ai/sdk` package bundled into the CLI.
 * It was 0.70.0 in v2.1.29 and 0.74.0 in v2.1.87.
 * Sent as X-Stainless-Package-Version header (L3665).
 */
export const STAINLESS_SDK_VERSION = "0.80.0";

/** Type for a system prompt block */
export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; scope?: "global" };
}

/**
 * System prompt: 4 text blocks sent in the `system` array of Messages API calls.
 *
 * Verified against v2.1.91 capture (fetch-014, fetch-024):
 *
 * system[0]: Billing attribution (no cache_control)
 *   Format: `x-anthropic-billing-header: cc_version=<ver>; cc_entrypoint=<ep>; cch=<hash>;`
 *   The server parses this for billing/attribution.
 *
 * system[1]: Identity prompt (no cache_control)
 *   "You are Claude Code, Anthropic's official CLI for Claude."
 *   Server validates against allowlist in `tP8`.
 *
 * system[2]: Full behavioral instructions (cache_control with scope:"global")
 *   Contains tool usage guidelines, security policies, output rules, etc.
 *   ~11,696 chars in v2.1.91. This is the block worth caching.
 *
 * system[3]: Session-specific guidance (no cache_control)
 *   Contains environment details, available skills, CLAUDE.md content, git status.
 *   Changes every request so not cached. ~15,751 chars in v2.1.91.
 *
 * IMPORTANT: In v2.1.87, cache_control was on system[1]. In v2.1.91, it moved
 * to system[2] with added scope:"global". system[0] and system[1] have NO
 * cache_control. This makes sense: cache the large instructions block, not the
 * tiny identity string.
 */
export function buildSystemPrompt(opts?: {
  instructions?: string;
  sessionContext?: string;
}): SystemBlock[] {
  const blocks: SystemBlock[] = [
    {
      type: "text",
      text: `x-anthropic-billing-header: cc_version=${VERSION}.b42; cc_entrypoint=cli; cch=00000;`,
    },
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    },
  ];

  // system[2]: Instructions block with cache_control (the big one worth caching)
  const instructions = opts?.instructions ?? DEFAULT_INSTRUCTIONS;
  blocks.push({
    type: "text",
    text: instructions,
    cache_control: { type: "ephemeral", scope: "global" },
  });

  // system[3]: Session-specific context (changes per request, no caching)
  if (opts?.sessionContext) {
    blocks.push({
      type: "text",
      text: opts.sessionContext,
    });
  }

  return blocks;
}

/**
 * Minimal instructions block for system[2].
 * The real CLI sends ~11K chars of detailed behavioral instructions.
 * This is a minimal version for research use. Override via buildSystemPrompt({instructions:...}).
 */
const DEFAULT_INSTRUCTIONS = `
You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

# Instructions
- Be concise and direct in responses.
- When given a task, do it without unnecessary explanation.
- If you need to use tools, use them efficiently.
`.trim();

/**
 * Legacy: flat system prompt for backward compatibility.
 * Prefer buildSystemPrompt() for new code.
 */
export const SYSTEM_PROMPT = buildSystemPrompt();

/**
 * Default model for conversation requests.
 * The CLI's default depends on subscription tier:
 *   - Max subscribers: opus-4-6 (with 1M context by default)
 *   - Pro subscribers: sonnet-4-6
 * We default to sonnet since it works for all tiers.
 */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// buildHeaders
// ---------------------------------------------------------------------------

/**
 * Build the full set of HTTP headers for a Messages API request.
 *
 * This combines headers from several sources in the CLI:
 *
 * 1. Anthropic SDK client defaults (L8374-8395):
 *    accept, content-type, anthropic-version, anthropic-dangerous-direct-browser-access
 *
 * 2. CLI default headers (L238033-238053):
 *    x-app, user-agent, x-claude-code-session-id
 *
 * 3. Stainless SDK platform metadata (cK5() at L3638-3694):
 *    x-stainless-arch, x-stainless-lang, x-stainless-os,
 *    x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version
 *
 * 4. Per-request headers (AB9() at L238226-238243):
 *    x-client-request-id (a new UUID for each request, for server-side log correlation)
 *
 * 5. Auth-dependent headers:
 *    - OAuth: authorization (Bearer token), anthropic-beta (5 flags),
 *      anthropic-dangerous-direct-browser-access
 *    - API key: x-api-key
 *
 * The `anthropic-dangerous-direct-browser-access: true` header is required
 * because the SDK sets `dangerouslyAllowBrowser: true` (L8383-8387).
 * Without it, the SDK would refuse to send requests that look like they
 * come from a browser environment.
 *
 * @param auth - The authentication result (determines OAuth vs API key headers)
 * @param sessionId - The session UUID (used in x-claude-code-session-id and metadata)
 * @param requestType - Controls which beta flags to include (default: "conversation")
 * @param model - Model ID, used to determine model-specific flags (e.g. context-1m for opus)
 */
export function buildHeaders(
  auth: AuthResult,
  sessionId: string,
  requestType: RequestType = "conversation",
  model?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    // SDK client defaults
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,

    // CLI defaults (L238033-238036)
    "user-agent": USER_AGENT,
    "x-app": "cli",
    "x-claude-code-session-id": sessionId,

    // Per-request UUID for log correlation (L238231, var kZ6 at L238245)
    "x-client-request-id": randomUUID(),
  };

  if (auth.type === "api-key") {
    headers["x-api-key"] = auth.token;
  } else {
    headers["authorization"] = `Bearer ${auth.token}`;
    headers["anthropic-beta"] = buildBetaFlags(requestType, model).join(",");
    // Required for OAuth — see L8383-8387 in the SDK client
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }

  // Stainless SDK platform metadata (cK5() at L3662-3675 for node runtime)
  // These are computed once and cached in $$7 via j$7() (L3716-3718).
  // The OS mapping is in O$7() at L3703-3713: "darwin" → "MacOS".
  // The arch mapping is in A$7() at L3695-3701: "arm64" stays "arm64".
  headers["x-stainless-arch"] = process.arch;
  headers["x-stainless-lang"] = "js";
  headers["x-stainless-os"] =
    process.platform === "darwin" ? "MacOS" : process.platform;
  headers["x-stainless-package-version"] = STAINLESS_SDK_VERSION;
  headers["x-stainless-retry-count"] = "0";
  headers["x-stainless-runtime"] = "node";
  headers["x-stainless-runtime-version"] = process.version;
  headers["x-stainless-timeout"] = "600";

  return headers;
}
