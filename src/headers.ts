/**
 * Headers module: request header construction matching current captured CLI traffic.
 *
 * Most constants in this file were extracted from cli.pretty.js and then checked
 * against real captured traffic in .node-net-dbg/. The CLI version is updated
 * from live capture because that is the value the server actually sees.
 */

import { randomUUID } from "node:crypto"
import type { AuthResult } from "./auth.ts"

// ---------------------------------------------------------------------------
// Constants (from cli.pretty.js)
// ---------------------------------------------------------------------------

/**
 * CLI version string observed in the latest captured traffic on 2026-04-25.
 * Used in User-Agent, billing header, and debug output.
 */
export const VERSION = "2.1.118"

/**
 * Per-build hash suffix that appears in the billing header alongside VERSION
 * (`cc_version=${VERSION}.${BUILD_HASH}`). Live 2.1.118 capture sends `3a7`.
 * Rolls per-build, so bump together with VERSION.
 */
export const BUILD_HASH = "3a7"

/**
 * Build timestamp. Not sent in requests, informational only.
 */
export const BUILD_TIME = "2026-04-25T00:00:00Z" // approximate, from v2.1.118

/**
 * Anthropic API version header value.
 * @see cli.pretty.js L8389: `"anthropic-version": "2023-06-01"`
 * Also at L611391: `oYK = "2023-06-01"` and L792388: `var Dhz = "2023-06-01"`.
 * This has been "2023-06-01" across all versions we've tracked (2.1.12 through 2.1.87).
 */
export const ANTHROPIC_VERSION = "2023-06-01"

/**
 * Messages API URL with `?beta=true` query parameter.
 *
 * The `?beta=true` was discovered in captured traffic — all real CLI requests
 * include it. It's set by the Stainless SDK's beta parameter handling, not
 * manually constructed by the CLI code. The SDK's `list()` method at L5069
 * and the request builder add it when beta flags are present.
 */
export const API_URL = "https://api.anthropic.com/v1/messages?beta=true"

/**
 * User-Agent string.
 *
 * Constructed by `eh()` at L240489-240501:
 *   `claude-cli/${VERSION} (external, ${ENTRYPOINT}${sdkVersion}${clientApp}${workload})`
 *
 * For the standard CLI entrypoint without SDK embedding, this simplifies to:
 *   `claude-cli/2.1.118 (external, cli)` (current capture)
 *
 * Note: there's also a `claude-code/` variant (L240516) used by the Agent SDK,
 * and a plain `claude-code/VERSION` variant (L240531). The `claude-cli/` form
 * is what the interactive CLI sends and what the server expects for OAuth.
 */
export const USER_AGENT = `claude-cli/${VERSION} (external, cli)`

/**
 * User-Agent variants for non-Stainless endpoints. Live 2.1.118 capture shows:
 *   - `claude-code/${VERSION}`         → /api/oauth/account/settings
 *   - `claude-code/${VERSION} (cli)`   → mcp-proxy.anthropic.com/v1/mcp/...
 * The standard {@link USER_AGENT} (`claude-cli/...`) is for the Stainless SDK
 * path that hits /v1/messages.
 */
export const USER_AGENT_OAUTH = `claude-code/${VERSION}`
export const USER_AGENT_MCP = `claude-code/${VERSION} (cli)`

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
export enum BetaFlagId {
  CLAUDE_CODE_20250219 = "claude-code-20250219",
  OAUTH_20250420 = "oauth-2025-04-20",
  CONTEXT_1M_20250807 = "context-1m-2025-08-07",
  INTERLEAVED_THINKING_20250514 = "interleaved-thinking-2025-05-14",
  REDACT_THINKING_20260212 = "redact-thinking-2026-02-12",
  CONTEXT_MANAGEMENT_20250627 = "context-management-2025-06-27",
  PROMPT_CACHING_SCOPE_20260105 = "prompt-caching-scope-2026-01-05",
  ADVANCED_TOOL_USE_20251120 = "advanced-tool-use-2025-11-20",
  EFFORT_20251124 = "effort-2025-11-24",
  STRUCTURED_OUTPUTS_20251215 = "structured-outputs-2025-12-15",
}

export interface BetaFlag {
  id: BetaFlagId
  description: string
  source: string
  condition: string
}

/**
 * Dictionary of beta flags with their details, indexed by BetaFlagId enum
 */
export const BETA_FLAGS_MAP: Record<BetaFlagId, BetaFlag> = {
  [BetaFlagId.CLAUDE_CODE_20250219]: {
    id: BetaFlagId.CLAUDE_CODE_20250219,
    description:
      "Claude Code features: tool schemas, system prompt allowlist validation, billing attribution",
    source: 'L138458: Uw8 = "claude-code-20250219"',
    condition: "Included for non-haiku models (L238657: `if (!_) K.push(Uw8)` where _ is isHaiku)",
  },
  [BetaFlagId.OAUTH_20250420]: {
    id: BetaFlagId.OAUTH_20250420,
    description: "OAuth authentication support for first-party (claude.ai) tokens",
    source: 'L38022: SX = "oauth-2025-04-20"',
    condition: "Always included when using OAuth (p7() is true at L238658)",
  },
  [BetaFlagId.CONTEXT_1M_20250807]: {
    id: BetaFlagId.CONTEXT_1M_20250807,
    description: "Enables 1M token context window for supported models",
    source: "Observed in v2.1.91 capture for opus conversation requests",
    condition: "Included for full conversation requests with large-context models",
  },
  [BetaFlagId.INTERLEAVED_THINKING_20250514]: {
    id: BetaFlagId.INTERLEAVED_THINKING_20250514,
    description: "Extended thinking with interleaved text output (think -> text -> think -> text)",
    source: 'L138459: p54 = "interleaved-thinking-2025-05-14"',
    condition:
      "Included unless DISABLE_INTERLEAVED_THINKING env is set, and model supports it (L238661-238664)",
  },
  [BetaFlagId.REDACT_THINKING_20260212]: {
    id: BetaFlagId.REDACT_THINKING_20260212,
    description:
      "Redacts thinking block content, returns empty thinking with cryptographic signature",
    source: "Observed in v2.1.91 capture — present in ALL request types",
    condition: "Always included for OAuth (replaces visible thinking content with signatures)",
  },
  [BetaFlagId.CONTEXT_MANAGEMENT_20250627]: {
    id: BetaFlagId.CONTEXT_MANAGEMENT_20250627,
    description: "Server-side context window management (auto-compression, prioritization)",
    source: 'L138461: Qw8 = "context-management-2025-06-27"',
    condition:
      "Included when first-party and USE_API_CONTEXT_MANAGEMENT env or model qualifies via ZB9() (L238677)",
  },
  [BetaFlagId.PROMPT_CACHING_SCOPE_20260105]: {
    id: BetaFlagId.PROMPT_CACHING_SCOPE_20260105,
    description: "Scoped prompt caching: cache_control blocks persist across requests in a session",
    source: 'L138468: tB6 = "prompt-caching-scope-2026-01-05"',
    condition: "Always included for first-party auth (L238682: unconditional when Wx() is true)",
  },
  [BetaFlagId.ADVANCED_TOOL_USE_20251120]: {
    id: BetaFlagId.ADVANCED_TOOL_USE_20251120,
    description: "Enhanced tool use capabilities (parallel tool calls, improved JSON streaming)",
    source: "Observed in v2.1.91 capture for full conversation requests",
    condition: "Included for full conversation requests with tool definitions",
  },
  [BetaFlagId.EFFORT_20251124]: {
    id: BetaFlagId.EFFORT_20251124,
    description: "Enables the effort parameter in output_config for controlling model computation",
    source: "Observed in v2.1.91 capture for full conversation requests",
    condition: "Included when output_config.effort is set",
  },
  [BetaFlagId.STRUCTURED_OUTPUTS_20251215]: {
    id: BetaFlagId.STRUCTURED_OUTPUTS_20251215,
    description: "JSON schema-based structured outputs via output_config.format",
    source: "Observed in v2.1.91 capture for title generation requests",
    condition: "Included when output_config.format is set (e.g. title generation)",
  },
}

/**
 * Array of beta flag details, for backward compatibility
 */
export const BETA_FLAGS_DETAILED = Object.values(BETA_FLAGS_MAP)

/** All beta flag IDs */
export const BETA_FLAGS = Object.keys(BETA_FLAGS_MAP)

/**
 * Request types that determine which beta flags to include.
 *
 * Observed in v2.1.91 capture:
 *   - "quota": 5 flags (no claude-code-20250219, no conversation-specific flags)
 *   - "title": 6 flags (adds structured-outputs-2025-12-15)
 *   - "conversation": 9 flags (all flags for full agentic behavior)
 */
export type RequestType = "quota" | "title" | "conversation"

/**
 * Build the `anthropic-beta` header value as an array of flag IDs.
 *
 * The flag set varies by request type and model. The function picks the
 * right combination based on what was observed in the v2.1.91 capture.
 *
 * **Flag sets observed (April 4, 2026):**
 *
 * | Request type | Flags |
 * |---|---|
 * | `quota` (haiku, max_tokens=1) | oauth, interleaved-thinking, redact-thinking, context-management, prompt-caching-scope |
 * | `title` (haiku, structured output) | quota set + structured-outputs |
 * | `conversation` (non-opus) | claude-code, oauth, interleaved-thinking, redact-thinking, context-management, prompt-caching-scope, advanced-tool-use, effort |
 * | `conversation` (opus or `[1m]` suffix) | conversation set + context-1m |
 *
 * **Model-specific behavior**:
 * - `context-1m-2025-08-07` is opus-only because sonnet returns 429
 *   "Extra usage is required for long context requests" without overage credits.
 * - The `[1m]` suffix on a model ID is a client-side convention (the actual
 *   API model ID has no suffix). We strip it for the request body but use
 *   it here to detect 1M context intent.
 /**
  * Builds the array of beta feature flags based on request type and model.
  *
  * @param requestType - Which beta set to build (default: \"conversation")
  * @param model - Model ID, used to gate model-specific flags like `context-1m`
  * @returns Array of BetaFlagId enum values ready to join with commas
  *
  * @example
  * ```ts
  * buildBetaFlags("conversation", "claude-opus-4-6")
  * // → [BetaFlagId.CLAUDE_CODE_20250219, BetaFlagId.OAUTH_20250420, BetaFlagId.CONTEXT_1M_20250807, ...]
  *
  * buildBetaFlags("quota")
  * // → [BetaFlagId.OAUTH_20250420, BetaFlagId.INTERLEAVED_THINKING_20250514, ...]  (5 flags)
  * ```
  */
export function buildBetaFlags(
  requestType: RequestType = "conversation",
  model?: string,
): BetaFlagId[] {
  switch (requestType) {
    case "quota":
      return [
        BetaFlagId.OAUTH_20250420,
        BetaFlagId.INTERLEAVED_THINKING_20250514,
        BetaFlagId.REDACT_THINKING_20260212,
        BetaFlagId.CONTEXT_MANAGEMENT_20250627,
        BetaFlagId.PROMPT_CACHING_SCOPE_20260105,
      ]
    case "title":
      return [
        BetaFlagId.OAUTH_20250420,
        BetaFlagId.INTERLEAVED_THINKING_20250514,
        BetaFlagId.REDACT_THINKING_20260212,
        BetaFlagId.CONTEXT_MANAGEMENT_20250627,
        BetaFlagId.PROMPT_CACHING_SCOPE_20260105,
        BetaFlagId.STRUCTURED_OUTPUTS_20251215,
      ]
    case "conversation": {
      const flags: BetaFlagId[] = [BetaFlagId.CLAUDE_CODE_20250219, BetaFlagId.OAUTH_20250420]
      // context-1m: enabled when model has [1m] suffix (client-side convention)
      // or for opus models by default (in v2.1.91 capture, opus always had this flag)
      const wants1m = model ? /\[1m\]/i.test(model) || model.includes("opus") : false
      if (wants1m) {
        flags.push(BetaFlagId.CONTEXT_1M_20250807)
      }
      flags.push(
        BetaFlagId.INTERLEAVED_THINKING_20250514,
        // REDACT_THINKING_20260212: Explicitly excluded to ensure thinking steps are visible in normal chat conversations
        // This flag causes thinking to be redacted with cryptographic signatures, but we want to see the thinking process
        // BetaFlagId.REDACT_THINKING_20260212,
        BetaFlagId.CONTEXT_MANAGEMENT_20250627,
        BetaFlagId.PROMPT_CACHING_SCOPE_20260105,
        BetaFlagId.ADVANCED_TOOL_USE_20251120,
        BetaFlagId.EFFORT_20251124,
      )

      return flags
    }
  }

  return buildBetaFlags("conversation", model)
}

/**
 * Stainless SDK package version.
 * @see cli.pretty.js L3573: `var ts = "0.74.0"`
 * This is the version of the `@anthropic-ai/sdk` package bundled into the CLI.
 * It was 0.70.0 in v2.1.29 and 0.74.0 in v2.1.87.
 * Sent as X-Stainless-Package-Version header (L3665).
 */
export const STAINLESS_SDK_VERSION = "0.81.0"

/**
 * One block in the system prompt array.
 *
 * `cache_control` enables prompt caching on this block. In live 2.1.118 traffic
 * BOTH system[2] (instructions, with `scope:"global"`) and system[3] (session
 * guidance, no scope) carry `cache_control` with explicit `ttl:"1h"`. The 1h
 * TTL is what keeps the prefix warm across idle gaps; without it the cache
 * defaults to 5 minutes.
 */
export interface SystemBlock {
  /** Always `"text"` for the standard CLI flow. */
  type: "text"
  /** Block content. */
  text: string
  /** Prompt caching control. */
  cache_control?: {
    type: "ephemeral"
    /** Cache TTL. Defaults to 5m when omitted. Live 2.1.118 sends "1h". */
    ttl?: "5m" | "1h"
    /** "global" shares the cache org-wide; omit for per-session caching. */
    scope?: "global"
  }
}

/**
 * Default interval (in tool-execution rounds) between reflection checkpoints
 * within a single `run()` call. Mirrored by `Agent.reflectionInterval` and
 * referenced from {@link buildSystemPrompt} when generating the loop-safety
 * paragraph appended to `system[2]`. Set to 50 because empirically a real
 * agentic session can hit 30+ rounds for a single complex task : 50 is the
 * point past which "still on track?" is a reasonable question for the model.
 * Configurable per-Agent; pass 0 to disable checkpoints entirely.
 */
export const DEFAULT_REFLECTION_INTERVAL = 50

/**
 * Default wall-clock cooldown (in milliseconds) applied at each reflection
 * checkpoint before the next API request is sent. Mirrored by
 * `Agent.reflectionCooldownMs`. Serves two purposes: (1) gives a human
 * watching the agent a window to press Esc and interrupt, (2) surfaces the
 * elapsed wall time to the model via the `cooldown-applied-seconds`
 * attribute on the injected `<ma::reflection-checkpoint>` tag, so the model
 * has a concrete signal that wall-clock time has passed. Configurable
 * per-Agent; pass 0 to keep the checkpoint attachment but skip the pause.
 */
export const DEFAULT_REFLECTION_COOLDOWN_MS = 60_000

/**
 * Build the harness-safety paragraph appended to `system[2]` so the model
 * knows about the reflection checkpoint, the cooldown, the ack/silence
 * opt-out, and (when configured) the emergency hard cap.
 *
 * Text is stable as a function of inputs, so the prompt cache key only
 * changes when the configuration changes : default-config sessions all
 * share the same cached prefix.
 *
 * The emergency-cap paragraph is OMITTED when `maxToolRounds` is
 * non-finite (the default, `Infinity`), so a default-configured session
 * sees no mention of a hard cap : there isn't one.
 */
export function buildLoopSafetyParagraph(opts: {
  reflectionInterval: number
  reflectionCooldownMs: number
  maxToolRounds: number
}): string {
  const { reflectionInterval, reflectionCooldownMs, maxToolRounds } = opts
  const hasReflection = reflectionInterval > 0
  const hasCooldown = hasReflection && reflectionCooldownMs > 0
  const hasEmergencyCap = Number.isFinite(maxToolRounds)
  if (!hasReflection && !hasEmergencyCap) return ""

  const cooldownSec = Math.round(reflectionCooldownMs / 1000)
  const parts: string[] = ["# Tool-use loop safety", ""]

  if (hasReflection) {
    parts.push(
      "The agentic tool-use loop has no fixed turn cap by default. Long autonomous tasks (multi-file refactors, audits, sustained research) can run for many rounds without interruption.",
      "",
    )
    if (hasCooldown) {
      parts.push(
        `A reflection checkpoint fires every ${reflectionInterval} tool rounds: the harness applies a ${cooldownSec}-second wall-clock cooldown (a human watching can press Esc to interrupt during the countdown), then injects a \`<ma::reflection-checkpoint round="N" cooldown-applied-seconds="${cooldownSec}" />\` attachment in the next user content. It is a soft checkpoint, not a stop signal. Briefly consider whether you are still on track, then continue, change strategy, or pause and ask the user.`,
      )
    } else {
      parts.push(
        `A reflection checkpoint fires every ${reflectionInterval} tool rounds. The harness injects a \`<ma::reflection-checkpoint round="N" cooldown-applied-seconds="0" />\` attachment in the next user content. It is a soft checkpoint, not a stop signal. Briefly consider whether you are still on track, then continue, change strategy, or pause and ask the user.`,
      )
    }
    parts.push(
      "",
      'To suppress the next K checkpoints during sustained autonomous work (skipping both the cooldown and the attachment), emit `<ma::reflection-ack silence-for="K" reason="..." />` anywhere in your assistant response. The `reason` appears in the user-visible transcript so the human running you can see why you opted out.',
    )
  }

  if (hasEmergencyCap) {
    parts.push(
      "",
      `An emergency hard cap is configured at ${maxToolRounds} rounds for this session. Reaching it disables tools for one final response and surfaces a \`<ma::emergency-cap-triggered round="${maxToolRounds}" />\` attachment : use that turn to summarize what you accomplished and surface anything the user should know.`,
    )
  }

  return parts.join("\n")
}

/**
 * Build the "Tool output conventions" paragraph appended to `system[2]`
 * so the model knows about the per-session raw-output blob store and
 * the `[raw-output: …]` pointer footer convention. One short section,
 * tool-agnostic: every tool that returns a large or clamped body lands
 * a full copy at `<sid>.blobs/<tool_use_id>.raw` and the path is
 * appended to the model-visible `tool_result.content`. The model uses
 * `Read` (or `Bash`) on that path when the inline body isn't enough.
 *
 * Returns an empty string when the blob store is disabled, so the
 * cache key is identical to a session without the feature.
 *
 * Pure function of `opts.blobStoreEnabled` (and a stable copy text):
 * default-config sessions all share the same cached prefix.
 */
export function buildToolOutputConventionsParagraph(opts: { blobStoreEnabled: boolean }): string {
  if (!opts.blobStoreEnabled) return ""
  return [
    "# Tool output conventions",
    "",
    "Every tool result whose body is large or got clamped by the universal 64KB / 1000-line cap also lands intact at `~/.minimal-agent/sessions/<sid>.blobs/<tool_use_id>.raw`. The agent appends a single line `[raw-output: <abs-path>  <size> · sha256=<hex>]` to the `tool_result.content` whenever that file was written. Use `Read({file_path: ...})` or `Bash({command: \"wc -l '...'\"})` on that path when the inline body isn't enough : the file is the FULL pre-clamp, pre-annotation output. The blob also survives session resume, so a later turn can analyze the original bytes without re-running the tool. Small bodies (under the configured `minBytesToPersist`, default 4096 B) are NOT persisted and emit no footer : the `content` IS the full output in that case.",
  ].join("\n")
}

/**
 * System prompt: 4 text blocks sent in the `system` array of Messages API calls.
 *
 * Verified against v2.1.118 capture (fetch-024 in
 * .node-net-dbg/1777147064608-25-APR-2026-SATURDAY--15h57m44s-EDT/):
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
 *   ~9,925 chars in v2.1.118. This is the block worth caching.
 *
 * system[3]: Session-specific guidance (no cache_control)
 *   Contains environment details, available skills, CLAUDE.md content, git status.
 *   ~17,625 chars in v2.1.118. NOW carries cache_control with ttl:"1h".
 *
 * IMPORTANT: In v2.1.87 cache_control was on system[1]. In v2.1.91 it moved
 * to system[2] with scope:"global". In v2.1.118, ttl:"1h" was added AND a
 * second cache_control was added on system[3] (without scope, per-session).
 * system[0] and system[1] still have no cache_control.
 *
 * @param opts.instructions - Custom system[2] content. Defaults to a short
 *   minimal instructions block. Pass the full real-CLI instructions here if
 *   you want behavior identical to the real Claude Code.
 * @param opts.sessionContext - Optional system[3] content. Omit to send only
 *   3 blocks (the minimum). Real CLI always includes this with environment
 *   details, CLAUDE.md, git status, etc.
 * @param opts.reflectionInterval - Reflection checkpoint cadence (rounds)
 *   used to generate the loop-safety paragraph appended to system[2].
 *   Defaults to {@link DEFAULT_REFLECTION_INTERVAL}. Pass 0 to omit the
 *   reflection section of the safety paragraph.
 * @param opts.reflectionCooldownMs - Wall-clock cooldown (ms) used to
 *   generate the loop-safety paragraph. Defaults to
 *   {@link DEFAULT_REFLECTION_COOLDOWN_MS}. Pass 0 to describe a
 *   checkpoint without a wall-clock pause.
 * @param opts.maxToolRounds - Emergency hard cap (rounds) used to generate
 *   the loop-safety paragraph. Defaults to `Number.POSITIVE_INFINITY` (no
 *   emergency cap, no mention in the prompt). Pass a finite value to add
 *   the emergency-cap paragraph.
 * @returns Array of system blocks ready to send in the API request body.
 *
 * @example
 * ```ts
 * // Minimal 3-block prompt:
 * const sys = buildSystemPrompt();
 *
 * // Full 4-block prompt with custom instructions:
 * const sys = buildSystemPrompt({
 *   instructions: "You are a code reviewer...",
 *   sessionContext: "cwd: /tmp\nGit status: clean",
 * });
 * ```
 */
export function buildSystemPrompt(opts?: {
  instructions?: string
  sessionContext?: string
  reflectionInterval?: number
  reflectionCooldownMs?: number
  maxToolRounds?: number
  /**
   * Whether the per-session blob store is active for this run. When
   * `true`, `buildSystemPrompt` appends a one-paragraph "Tool output
   * conventions" section so the model knows about the
   * `[raw-output: …]` pointer footer. Default `false`: matches
   * behavior of older sessions that pre-date the blob store.
   */
  blobStoreEnabled?: boolean
}): SystemBlock[] {
  const blocks: SystemBlock[] = [
    {
      type: "text",
      text: `x-anthropic-billing-header: cc_version=${VERSION}.${BUILD_HASH}; cc_entrypoint=cli; cch=00000;`,
    },
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    },
  ]

  // system[2]: Instructions block with cache_control (the big one worth caching).
  // ttl:"1h" matches live 2.1.118 traffic; scope:"global" shares the cache
  // across sessions for the same org.
  //
  // We append a "Tool-use loop safety" paragraph so the model knows about
  // the reflection checkpoint cadence, the cooldown wall-clock penalty,
  // the ack/silence opt-out, and the emergency cap (when one is set). The
  // paragraph is a pure function of the three opts below : default values
  // produce stable text, so the cache key is stable across default-config
  // sessions and only diverges when a host overrides the defaults.
  const reflectionInterval = opts?.reflectionInterval ?? DEFAULT_REFLECTION_INTERVAL
  const reflectionCooldownMs = opts?.reflectionCooldownMs ?? DEFAULT_REFLECTION_COOLDOWN_MS
  const maxToolRounds = opts?.maxToolRounds ?? Number.POSITIVE_INFINITY
  const blobStoreEnabled = opts?.blobStoreEnabled ?? false
  const instructionsBase = opts?.instructions ?? DEFAULT_INSTRUCTIONS
  const safetyParagraph = buildLoopSafetyParagraph({
    reflectionInterval,
    reflectionCooldownMs,
    maxToolRounds,
  })
  const conventionsParagraph = buildToolOutputConventionsParagraph({
    blobStoreEnabled,
  })
  // Chain the optional sections, glueing each with a blank line. Skip
  // empty fragments so the resulting text is stable for the
  // "everything-off" case (matches the legacy cache key shape).
  const instructions = [instructionsBase, safetyParagraph, conventionsParagraph]
    .filter((s) => s.length > 0)
    .join("\n\n")
  blocks.push({
    type: "text",
    text: instructions,
    cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
  })

  // system[3]: Session-specific guidance + environment + git status, etc.
  // Live 2.1.118 carries `cache_control: { type:"ephemeral", ttl:"1h" }` here
  // (no scope, this content is per-session). This is the second of the three
  // active breakpoints and is what lets cache_read grow turn-over-turn.
  if (opts?.sessionContext) {
    blocks.push({
      type: "text",
      text: opts.sessionContext,
      cache_control: { type: "ephemeral", ttl: "1h" },
    })
  }

  return blocks
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
`.trim()

/**
 * Legacy: flat system prompt for backward compatibility.
 * Prefer buildSystemPrompt() for new code.
 */
export const SYSTEM_PROMPT = buildSystemPrompt()

/**
 * Latest model IDs as of capture 2026-04-25 (claude-cli/2.1.118). Use these
 * constants instead of string literals so a future model bump touches one
 * place. Live 2.1.118 capture confirms `claude-opus-4-7` as the canonical
 * opus ID (the previous `claude-opus-4-6` is gone).
 */
export const MODELS = {
  OPUS: "claude-opus-4-7",
  SONNET: "claude-sonnet-4-6",
  HAIKU: "claude-haiku-4-5-20251001",
} as const

/**
 * Default model for conversation requests.
 *
 * The real CLI's default depends on subscription tier (Max → opus, Pro →
 * sonnet). We default to sonnet because it works for all tiers and avoids
 * unnecessary opus quota consumption when the user has not asked for it.
 * Override via `--model claude-opus-4-7` (or `[1m]` suffix) on the CLI, or
 * `model:` on programmatic calls.
 */
export const DEFAULT_MODEL: string = MODELS.SONNET

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
  }

  if (auth.type === "api-key") {
    headers["x-api-key"] = auth.token
  } else {
    headers["authorization"] = `Bearer ${auth.token}`
    headers["anthropic-beta"] = buildBetaFlags(requestType, model).join(",")
    // Required for OAuth — see L8383-8387 in the SDK client
    headers["anthropic-dangerous-direct-browser-access"] = "true"
  }

  // Stainless SDK platform metadata (cK5() at L3662-3675 for node runtime)
  // These are computed once and cached in $$7 via j$7() (L3716-3718).
  // The OS mapping is in O$7() at L3703-3713: "darwin" → "MacOS".
  // The arch mapping is in A$7() at L3695-3701: "arm64" stays "arm64".
  headers["x-stainless-arch"] = process.arch
  headers["x-stainless-lang"] = "js"
  headers["x-stainless-os"] = process.platform === "darwin" ? "MacOS" : process.platform
  headers["x-stainless-package-version"] = STAINLESS_SDK_VERSION
  headers["x-stainless-retry-count"] = "0"
  headers["x-stainless-runtime"] = "node"
  headers["x-stainless-runtime-version"] = process.version
  headers["x-stainless-timeout"] = "600"

  return headers
}
