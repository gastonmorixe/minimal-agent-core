/**
 * Anthropic beta-flag taxonomy + assembler.
 *
 * Source of truth: `cli.patched.cjs` L116069-L116093 in claude-code 2.1.154.
 * Each declared `qf(<short>, <header>)` becomes one {@link AnthropicBetaFlag}
 * entry. The assembler picks a subset per request based on capabilities
 * and request shape.
 *
 * The legacy `src/headers.ts` exposes a subset of these as the
 * `BetaFlagId` enum; the canonical adapter migrates to the typed
 * `AnthropicBetaFlag` table so new flags are one append.
 *
 * @module llm/providers/anthropic/beta-flags
 */

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import type { ModelEntry } from "../../src/llm/model-registry.ts"

/** Every known beta header value, in declaration order. */
export const ANTHROPIC_BETA_FLAGS = {
  CLAUDE_CODE: "claude-code-20250219",
  OAUTH: "oauth-2025-04-20",
  INTERLEAVED_THINKING: "interleaved-thinking-2025-05-14",
  CONTEXT_1M: "context-1m-2025-08-07",
  CONTEXT_MANAGEMENT: "context-management-2025-06-27",
  STRUCTURED_OUTPUTS: "structured-outputs-2025-12-15",
  WEB_SEARCH: "web-search-2025-03-05",
  ADVANCED_TOOL_USE: "advanced-tool-use-2025-11-20",
  TOOL_SEARCH_TOOL: "tool-search-tool-2025-10-19",
  EFFORT: "effort-2025-11-24",
  TASK_BUDGETS: "task-budgets-2026-03-13",
  PROMPT_CACHING_SCOPE: "prompt-caching-scope-2026-01-05",
  EXTENDED_CACHE_TTL: "extended-cache-ttl-2025-04-11",
  FAST_MODE: "fast-mode-2026-02-01",
  REDACT_THINKING: "redact-thinking-2026-02-12",
  THINKING_TOKEN_COUNT: "thinking-token-count-2026-05-13",
  AFK_MODE: "afk-mode-2026-01-31",
  ADVISOR_TOOL: "advisor-tool-2026-03-01",
  CACHE_DIAGNOSIS: "cache-diagnosis-2026-04-07",
  CONTEXT_HINT: "context-hint-2026-04-09",
  MCP_SERVERS: "mcp-servers-2025-12-04",
  FILES_API: "files-api-2025-04-14",
  ENVIRONMENTS: "environments-2025-11-01",
  CCR_BYOC: "ccr-byoc-2025-07-29",
  MID_CONVERSATION_SYSTEM: "mid-conversation-system-2026-04-07",
} as const

export type AnthropicBetaFlag = (typeof ANTHROPIC_BETA_FLAGS)[keyof typeof ANTHROPIC_BETA_FLAGS]

/**
 * Anthropic request kinds — drives which flags get included before
 * model + capability gating.
 *
 * - `"quota"`: minimal probe (haiku, max_tokens=1, no system).
 * - `"title"`: structured-output title gen on haiku.
 * - `"subtask"`: a tightly-scoped single-tool conversation (one tool,
 *   simple system, no 1h cache). Drops `advanced-tool-use` and
 *   `extended-cache-ttl`.
 * - `"conversation"`: full agentic loop with 1h cache + multi-tool.
 */
export type AnthropicRequestKind = "quota" | "title" | "subtask" | "conversation"

/** Classify the canonical request into one of the kinds above. */
export function classifyRequest(req: CanonicalRequest): AnthropicRequestKind {
  // Quota probe: max_tokens 1, string content, no tools, no system.
  const onlyMsg = req.messages.length === 1 ? req.messages[0] : undefined
  if (
    req.generation?.maxOutputTokens === 1 &&
    !req.tools?.length &&
    !req.system?.length &&
    onlyMsg?.role === "user"
  ) {
    return "quota"
  }
  // Title: structured json_schema output, no thinking, no tools, simple system.
  if (req.outputFormat?.type === "json_schema" && (req.tools?.length ?? 0) === 0) {
    return "title"
  }
  // Subtask: one user-defined tool, no 1h-ttl breakpoints.
  const has1hCache = hasAny1hTtl(req)
  if ((req.tools?.length ?? 0) <= 1 && !has1hCache) {
    return "subtask"
  }
  return "conversation"
}

function hasAny1hTtl(req: CanonicalRequest): boolean {
  const checkBlocks = (blocks?: { cache?: { ttl?: string } }[]) =>
    !!blocks?.some((b) => b.cache?.ttl === "1h")
  if (checkBlocks(req.system as { cache?: { ttl?: string } }[] | undefined)) return true
  for (const msg of req.messages) {
    if (msg.cache?.ttl === "1h") return true
    if (Array.isArray(msg.content) && checkBlocks(msg.content as { cache?: { ttl?: string } }[])) {
      return true
    }
  }
  return false
}

/**
 * Build the `anthropic-beta` header value as an ordered list of flag
 * values. Order matches what the live CLI sends (decoded from the
 * 2026-05-28 capture).
 *
 * `auth.kind === "oauth"` is required for first-party betas.
 *
 * Caller-supplied overrides (`req.vendor?.anthropic?.betaOverrides`)
 * apply LAST so an opt-out can drop a default flag.
 */
export function buildBetaFlags(opts: {
  kind: AnthropicRequestKind
  req: CanonicalRequest
  model: ModelEntry
  authKind: "oauth" | "api-key" | "custom"
}): AnthropicBetaFlag[] {
  const { kind, req, model, authKind } = opts
  const flags = new Set<AnthropicBetaFlag>()

  const isOAuth = authKind === "oauth"
  if (isOAuth) flags.add(ANTHROPIC_BETA_FLAGS.OAUTH)
  // Interleaved thinking is OMITTED for opus-4-8: under this beta it emits huge
  // parallel tool batches whose interleaved thinking hallucinates same-turn
  // tool results, spiraling into ever-larger batches. Wire-proven, and absent
  // on opus-4.7 under the same flag (model-behavior change, not transport). See
  // TODOS.md T-7c3f02 + private/tool-bugs-and-improvements/08-ROOT-CAUSE-corrected.md.
  // Kept for every other model (they sequence tool use correctly). Escape
  // hatch: MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING=1. Mirrors the legacy
  // src/headers.ts gate so both transports agree.
  const forceInterleaved = process.env.MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING === "1"
  if (forceInterleaved || !model.id.includes("opus-4-8")) {
    flags.add(ANTHROPIC_BETA_FLAGS.INTERLEAVED_THINKING)
  }
  flags.add(ANTHROPIC_BETA_FLAGS.REDACT_THINKING)
  flags.add(ANTHROPIC_BETA_FLAGS.CONTEXT_MANAGEMENT)
  if (isOAuth) flags.add(ANTHROPIC_BETA_FLAGS.PROMPT_CACHING_SCOPE)

  switch (kind) {
    case "quota":
      break
    case "title":
      flags.add(ANTHROPIC_BETA_FLAGS.STRUCTURED_OUTPUTS)
      break
    case "subtask":
    case "conversation":
      flags.add(ANTHROPIC_BETA_FLAGS.CLAUDE_CODE)
      // 1M context: opt-in via [1m] alias OR if model supports it natively.
      // Live capture shows opus-4-8 sends it by default.
      if (
        req.modelId.includes("[1m]") ||
        model.id === "claude-opus-4-8" ||
        model.id === "claude-opus-4-7" ||
        model.id === "claude-opus-4-6" ||
        model.capabilities.contextWindow >= 1_000_000
      ) {
        flags.add(ANTHROPIC_BETA_FLAGS.CONTEXT_1M)
      }
      if (model.capabilities.midConversationSystem) {
        flags.add(ANTHROPIC_BETA_FLAGS.MID_CONVERSATION_SYSTEM)
      }
      if (req.effort && model.capabilities.effort.levels.length > 0) {
        flags.add(ANTHROPIC_BETA_FLAGS.EFFORT)
      }
      if (kind === "conversation") {
        if (model.capabilities.tools.parallel || model.capabilities.tools.fineGrainedStreaming) {
          flags.add(ANTHROPIC_BETA_FLAGS.ADVANCED_TOOL_USE)
        }
        if (hasAny1hTtl(req)) {
          flags.add(ANTHROPIC_BETA_FLAGS.EXTENDED_CACHE_TTL)
        }
      }
      if (req.vendor?.anthropic?.taskBudget) {
        flags.add(ANTHROPIC_BETA_FLAGS.TASK_BUDGETS)
      }
      if (req.speed === "fast" && model.capabilities.speedFast) {
        flags.add(ANTHROPIC_BETA_FLAGS.FAST_MODE)
      }
      if (req.vendor?.anthropic?.cacheDiagnostics) {
        flags.add(ANTHROPIC_BETA_FLAGS.CACHE_DIAGNOSIS)
      }
      break
  }

  // Caller overrides (additions first, then removals).
  const overrides = req.vendor?.anthropic?.betaOverrides
  if (overrides?.add) for (const flag of overrides.add) flags.add(flag as AnthropicBetaFlag)
  if (overrides?.remove)
    for (const flag of overrides.remove) flags.delete(flag as AnthropicBetaFlag)

  // Preserve declaration order so snapshots are stable.
  const ordered: AnthropicBetaFlag[] = []
  for (const value of Object.values(ANTHROPIC_BETA_FLAGS)) {
    if (flags.has(value)) ordered.push(value)
  }
  return ordered
}
