/**
 * Headers module: request header construction matching current captured CLI traffic.
 *
 * Most constants in this file were extracted from cli.pretty.js and then checked
 * against real captured traffic in .node-net-dbg/. The CLI version is updated
 * from live capture because that is the value the server actually sees.
 */

import { randomUUID } from "node:crypto"

// Anthropic model-gate decisions live in the PROVIDER PLUGIN. This legacy
// module is itself misplaced Anthropic wire code (Wave-4 dissolution
// target), so it reaches into the plugin rather than duplicating the
// logic in core a second time. See plugins/llm-anthropic/beta-gates.ts.
import { omitsInterleavedThinking, wants1mContext } from "../plugins/llm-anthropic/beta-gates.ts"

import type { AuthResult } from "./auth.ts"
import { promptPath, renderPrompt } from "./prompts.ts"

/**
 * Resolve a core prompt file under `src/prompts/`. Prose for the system
 * prompt lives in markdown; see `src/prompts/README.md`.
 *
 * @param segments - Path segments under `src/prompts/`.
 * @returns Absolute path to the prompt file.
 */
function corePrompt(...segments: string[]): string {
  return promptPath(import.meta, "prompts", ...segments)
}

/**
 * The exact Claude-Code identity line Anthropic's server validates for
 * plan/OAuth auth (system[1]). Single source of truth, shared with the
 * `llm-anthropic` provider; rendered from `prompts/anthropic/`.
 */
export const CLAUDE_CODE_IDENTITY: string = renderPrompt(
  corePrompt("anthropic", "identity.claude-code.md"),
)

/**
 * Build the billing-attribution block text (system[0] on Anthropic plan
 * auth). Rendered from `prompts/anthropic/billing.tmpl.md` with the live CLI
 * version + build hash. The server parses this for billing/attribution.
 *
 * @returns The `x-anthropic-billing-header: …` line, byte-exact.
 */
export function buildBillingHeaderText(): string {
  return renderPrompt(corePrompt("anthropic", "billing.tmpl.md"), {
    version: VERSION,
    buildHash: BUILD_HASH,
  })
}

// ---------------------------------------------------------------------------
// Constants (from cli.pretty.js)
// ---------------------------------------------------------------------------

/**
 * CLI version string observed in the latest captured traffic on 2026-05-28.
 * Used in User-Agent, billing header, and debug output.
 */
export const VERSION = "2.1.154"

/**
 * Per-build hash suffix that appears in the billing header alongside VERSION
 * (`cc_version=${VERSION}.${BUILD_HASH}`). Source: `er_(hash)` builder at
 * cli.patched.cjs L117040 in 2.1.154, which derives `hash` per-process via
 * `o9q(salt, VERSION)`. Live 2.1.154 captures observed `d6e`, `1c3`, `23d` —
 * all valid for that build. We pin one deterministic value here; the server
 * doesn't validate the suffix, only logs it.
 */
export const BUILD_HASH = "d6e"

/**
 * Build timestamp + git sha. Not sent in requests, informational only.
 * Source: cli.patched.cjs L166-L212 (the build-info object literal injected
 * by claude-code's bundler) in v2.1.154.
 */
export const BUILD_TIME = "2026-05-28T12:27:24Z"
export const GIT_SHA = "b84d2da9ada13121515426fc644786a303e9ac53"

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
  /** Added in v2.1.154 — accepts `role:"system"` mid-`messages[]`. */
  MID_CONVERSATION_SYSTEM_20260407 = "mid-conversation-system-2026-04-07",
  /** Added in v2.1.154 — allows `cache_control.ttl: "1h"` on blocks. */
  EXTENDED_CACHE_TTL_20250411 = "extended-cache-ttl-2025-04-11",
  /** Added in v2.1.154 — surfaces `output_tokens_details.thinking_tokens`. */
  THINKING_TOKEN_COUNT_20260513 = "thinking-token-count-2026-05-13",
  /** Added in v2.1.154 — fast-mode dispatch on the response (`speed:"fast"`). */
  FAST_MODE_20260201 = "fast-mode-2026-02-01",
  /** Added in v2.1.154 — `output_config.task_budget` agentic-loop ceiling. */
  TASK_BUDGETS_20260313 = "task-budgets-2026-03-13",
  /** Added in v2.1.154 — `diagnostics: {previous_message_id}` for cache debugging. */
  CACHE_DIAGNOSIS_20260407 = "cache-diagnosis-2026-04-07",
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
    condition:
      "CC sends it everywhere. WE deliberately exclude it from conversations " +
      "(thinking stays visible in the TUI) and keep it only in the quota/title " +
      "probe sets — see buildBetaFlags. The canonical transport differs (always " +
      "adds it); pinned in the characterization suites.",
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
  [BetaFlagId.MID_CONVERSATION_SYSTEM_20260407]: {
    id: BetaFlagId.MID_CONVERSATION_SYSTEM_20260407,
    description:
      'Accepts {role:"system"} entries inside messages[] (mid-conversation operator nudges)',
    source: 'cli.patched.cjs L116093 v2.1.154: Yy = qf("mid_conversation_system", "...")',
    condition: "Included for opus-4-6+/sonnet-4-6 conversation requests",
  },
  [BetaFlagId.EXTENDED_CACHE_TTL_20250411]: {
    id: BetaFlagId.EXTENDED_CACHE_TTL_20250411,
    description: 'Enables cache_control.ttl:"1h" (default is 5m without this flag)',
    source: 'cli.patched.cjs L116081 v2.1.154: NGH = qf("extended_cache_ttl", "...")',
    condition: "Included when any cache_control entry on the request requests 1h TTL",
  },
  [BetaFlagId.THINKING_TOKEN_COUNT_20260513]: {
    id: BetaFlagId.THINKING_TOKEN_COUNT_20260513,
    description: "Server populates usage.output_tokens_details.thinking_tokens on message_delta",
    source: 'cli.patched.cjs L116084 v2.1.154: cr_ = qf("thinking_token_count", "...")',
    condition:
      "Always-on in CC's captures, but NOT currently sent by either of our " +
      "transports (declared here for the taxonomy/--list-flags only). Add it " +
      "to buildBetaFlags when thinking-token accounting lands.",
  },
  [BetaFlagId.FAST_MODE_20260201]: {
    id: BetaFlagId.FAST_MODE_20260201,
    description: 'Enables top-level speed:"fast" — ~2.5x output tok/s at premium pricing',
    source: 'cli.patched.cjs L116082 v2.1.154: bUH = qf("speed", "fast-mode-2026-02-01")',
    condition: "Included when speed:'fast' is set on the request body",
  },
  [BetaFlagId.TASK_BUDGETS_20260313]: {
    id: BetaFlagId.TASK_BUDGETS_20260313,
    description: "Enables output_config.task_budget — model self-moderates against a token budget",
    source: 'cli.patched.cjs L116079 v2.1.154: dr_ = qf("task_budgets", "...")',
    condition: "Included when output_config.task_budget is set (min 20_000 total)",
  },
  [BetaFlagId.CACHE_DIAGNOSIS_20260407]: {
    id: BetaFlagId.CACHE_DIAGNOSIS_20260407,
    description: "Enables top-level diagnostics:{previous_message_id} for prompt-cache debugging",
    source: 'cli.patched.cjs L116087 v2.1.154: NKH = qf("cache_diagnosis", "...")',
    condition: "Included for cache-diagnosis debugging sessions only",
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
 * - `context-1m-2025-08-07` is sent for 1M-native families (opus 4.6+,
 *   sonnet 4.6, fable 5) and any `[1m]`-suffixed id. Historical caveat:
 *   pre-overage sonnet accounts returned 429 "Extra usage is required for
 *   long context requests"; `parseModelUnavailableError` still catches
 *   that shape and reopens the model picker if an account lacks access.
 * - The `[1m]` suffix on a model ID is a client-side convention (the actual
 *   API model ID has no suffix). We strip it for the request body but use
 *   it here to detect 1M context intent.
 *
 * @param requestType - Which beta set to build (default: "conversation")
 * @param model - Model ID, used to gate model-specific flags like `context-1m`
 * @param opts - Conditional feature-gated betas (fast-mode, task budgets,
 *   cache diagnosis). The caller decides; capability gating happens in
 *   `client.ts` (see the fast-mode gate in `sendMessageOnce`).
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
  opts?: { speedFast?: boolean; taskBudget?: boolean; cacheDiagnosis?: boolean },
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
      // context-1m: decided by the SHARED model-gate module
      // (src/llm/anthropic-beta-gates.ts), the same predicate the canonical
      // transport uses — registry capabilities first, conservative substring
      // fallback for unregistered ids. Wave 2a replaced the hand-mirrored
      // family list that produced the fable-5 context-1m P0; the
      // characterization suites pin per-model membership AND cross-transport
      // agreement.
      if (wants1mContext(model)) {
        flags.push(BetaFlagId.CONTEXT_1M_20250807)
      }
      // Interleaved thinking: omitted only where the model exhibits the
      // tool-batch spiral pathology (opus-4-8; see T-7c3f02 and the full
      // wire evidence cited in src/llm/anthropic-beta-gates.ts). The
      // decision lives in the shared gate module so both transports stay
      // in lockstep; MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING=1 overrides.
      if (!omitsInterleavedThinking(model)) {
        flags.push(BetaFlagId.INTERLEAVED_THINKING_20250514)
      }
      flags.push(
        // REDACT_THINKING_20260212: Explicitly excluded to ensure thinking steps are visible in normal chat conversations
        // This flag causes thinking to be redacted with cryptographic signatures, but we want to see the thinking process
        // BetaFlagId.REDACT_THINKING_20260212,
        BetaFlagId.CONTEXT_MANAGEMENT_20250627,
        BetaFlagId.PROMPT_CACHING_SCOPE_20260105,
        BetaFlagId.ADVANCED_TOOL_USE_20251120,
        BetaFlagId.EFFORT_20251124,
        // mid-conversation-system-2026-04-07: accept role:"system" inside
        // messages[]. Opus 4.6+ / Sonnet 4.6 support it; safe to send to
        // older models (server ignores unknown betas).
        BetaFlagId.MID_CONVERSATION_SYSTEM_20260407,
        // extended-cache-ttl-2025-04-11: allows ttl:"1h" on cache_control.
        // The legacy SYSTEM_PROMPT already uses 1h TTLs, so send the flag.
        BetaFlagId.EXTENDED_CACHE_TTL_20250411,
      )
      if (opts?.speedFast) flags.push(BetaFlagId.FAST_MODE_20260201)
      if (opts?.taskBudget) flags.push(BetaFlagId.TASK_BUDGETS_20260313)
      if (opts?.cacheDiagnosis) flags.push(BetaFlagId.CACHE_DIAGNOSIS_20260407)

      return flags
    }
  }
  // The switch above is exhaustive over RequestType; TypeScript narrows
  // to `never` here. (A previous fallback recursed with the opts dropped,
  // which would have silently lost feature betas if ever reached from
  // untyped JS — removed in the Phase-8 cleanup.)
  return requestType satisfies never
}

/**
 * Stainless SDK package version.
 *
 * This is the version of the `@anthropic-ai/sdk` package bundled into the
 * CLI. Sent as `x-stainless-package-version` header. Walk:
 *   - 0.70.0 in v2.1.29
 *   - 0.74.0 in v2.1.87
 *   - 0.81.0 in v2.1.118
 *   - 0.94.0 in v2.1.154 (observed in live 2026-05-28 capture)
 */
export const STAINLESS_SDK_VERSION = "0.94.0"

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
 * Reflection-checkpoint defaults moved to `src/agent/reflection.ts`
 * (agent-loop config, not wire constants) in refactor Wave 1. Re-exported
 * here so existing importers keep resolving until the legacy module
 * dissolves (Wave 4). New code: import from `./agent/reflection.ts`.
 */
export {
  DEFAULT_REFLECTION_COOLDOWN_MS,
  DEFAULT_REFLECTION_INTERVAL,
} from "./agent/reflection.ts"

import { DEFAULT_REFLECTION_COOLDOWN_MS, DEFAULT_REFLECTION_INTERVAL } from "./agent/reflection.ts"

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
  // Prose lives in `prompts/loop-safety/*`; the conditional assembly (which
  // fragment, in what order) stays here. The structure mirrors the original
  // string-literal build 1:1 so the rendered output is byte-identical.
  const lp = (file: string): string => corePrompt("loop-safety", file)
  const parts: string[] = [renderPrompt(lp("heading.md")), ""]

  if (hasReflection) {
    parts.push(renderPrompt(lp("intro.md")), "")
    parts.push(
      hasCooldown
        ? renderPrompt(lp("checkpoint-cooldown.tmpl.md"), {
            interval: reflectionInterval,
            cooldownSec,
          })
        : renderPrompt(lp("checkpoint-plain.tmpl.md"), { interval: reflectionInterval }),
    )
    parts.push("", renderPrompt(lp("ack.md")))
  }

  if (hasEmergencyCap) {
    parts.push("", renderPrompt(lp("emergency-cap.tmpl.md"), { maxToolRounds }))
  }

  return parts.join("\n")
}

/**
 * Build the "Tool output conventions" paragraph appended to `system[2]`
 * so the model knows about the per-session raw-output blob store and
 * the `<ma::agent::raw-output …/>` pointer footer convention. One short section,
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
  return renderPrompt(corePrompt("tool-output-conventions.md"))
}

/**
 * Options shared by the instructions-block text builder. Pulled out so the
 * provider-neutral system-prompt builder (`src/llm/system-prompt.ts`) and the
 * legacy {@link buildSystemPrompt} produce a byte-identical instructions block.
 */
export interface InstructionsBlockOptions {
  instructions?: string
  reflectionInterval?: number
  reflectionCooldownMs?: number
  maxToolRounds?: number
  blobStoreEnabled?: boolean
}

/**
 * Assemble the text of the cached instructions block (the big system[2]
 * block): the base instructions, then the loop-safety paragraph, then the
 * tool-output-conventions paragraph. Empty fragments are dropped so the
 * "everything-off" case is byte-stable (the cache key depends on it).
 *
 * This is the provider-NEUTRAL portion of the system prompt. The leading
 * identity/billing blocks differ per provider and are resolved separately
 * (see `src/llm/system-prompt.ts` + each provider's `resolveSystemPrompt`).
 */
export function buildInstructionsBlockText(opts?: InstructionsBlockOptions): string {
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
  const conventionsParagraph = buildToolOutputConventionsParagraph({ blobStoreEnabled })
  return [instructionsBase, safetyParagraph, conventionsParagraph]
    .filter((s) => s.length > 0)
    .join("\n\n")
}

/**
 * LEGACY / Anthropic-shaped system prompt builder. Hardcodes the Anthropic
 * billing header + the `"You are Claude Code, …"` identity for EVERY caller,
 * so it is only correct for Anthropic plan-auth.
 *
 * @deprecated New code must use `resolveSystemPromptForModel` from
 * `src/llm/system-prompt.ts`, which builds a provider-neutral skeleton and
 * lets the request's provider resolve its own preamble (Anthropic billing for
 * OAuth, neutral `"You are Minimal Agent, …"` otherwise). This function is
 * kept only as the back-compat default for the legacy `client.ts` `sendMessage`
 * path (`SYSTEM_PROMPT`) and its instructions block is assembled via the shared
 * `buildInstructionsBlockText` so the neutral builder stays byte-identical.
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
   * `<ma::agent::raw-output …/>` pointer footer. Default `false`: matches
   * behavior of older sessions that pre-date the blob store.
   */
  blobStoreEnabled?: boolean
}): SystemBlock[] {
  const blocks: SystemBlock[] = [
    { type: "text", text: buildBillingHeaderText() },
    { type: "text", text: CLAUDE_CODE_IDENTITY },
  ]

  // system[2]: Instructions block with cache_control (the big one worth caching).
  // ttl:"1h" matches live 2.1.118 traffic; scope:"global" shares the cache
  // across sessions for the same org. Text assembled by the shared
  // `buildInstructionsBlockText` so the provider-neutral builder
  // (`src/llm/system-prompt.ts`) produces a byte-identical block.
  const instructions = buildInstructionsBlockText(opts)
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
 * Minimal instructions block for system[2], rendered from
 * `src/prompts/instructions.md`. The real CLI sends ~11K chars of detailed
 * behavioral instructions; this is a minimal version for research use.
 * Override via `buildSystemPrompt({ instructions: … })`.
 */
const DEFAULT_INSTRUCTIONS = renderPrompt(corePrompt("instructions.md"))

/**
 * Legacy: flat system prompt for backward compatibility.
 * Prefer buildSystemPrompt() for new code.
 */
export const SYSTEM_PROMPT = buildSystemPrompt()

/**
 * Convenience tier ids for the legacy client path. NOT the model catalog:
 * the canonical, complete catalog lives in `plugins/llm-anthropic/models.ts`
 * (claude-fable-5, opus 4.8/4.7/4.6, sonnet 4.6/4.5, haiku 4.5). These three
 * constants only feed DEFAULT_MODEL and a couple of legacy callers, so they
 * track "a sensible id per tier", not "the newest model" (OPUS deliberately
 * stays 4-7 here; bump deliberately, with a capture). Last reviewed
 * 2026-06-09.
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
  /** Conditional feature-gated betas (forwarded to buildBetaFlags). */
  betaOpts?: { speedFast?: boolean; taskBudget?: boolean; cacheDiagnosis?: boolean },
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
    headers["anthropic-beta"] = buildBetaFlags(requestType, model, betaOpts).join(",")
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
