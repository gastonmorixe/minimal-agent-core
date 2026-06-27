/**
 * Documentation catalog of the Anthropic beta flags, for the `--list-flags`
 * command. This is the human-facing taxonomy (wire value + effect + attach
 * condition + reverse-engineering provenance), distinct from the assembler in
 * `./beta-flags.ts` which decides which flags an actual request carries.
 *
 * Returned through the neutral `ProviderPlugin.listBetaFlags` hook so the core
 * `--list-flags` command renders it generically across every provider.
 *
 * @module llm/providers/anthropic/beta-flags-catalog
 */

import type { BetaFlagInfo } from "@minimal-agent/plugin-api/llm/provider-plugin"

/**
 * Every Anthropic beta flag the client knows about, with documentation. The
 * `--list-flags` command renders this verbatim; the `condition` text records
 * when (and whether) this agent's transport actually sends each flag.
 */
export const ANTHROPIC_BETA_FLAGS_CATALOG: readonly BetaFlagInfo[] = [
  {
    id: "claude-code-20250219",
    description:
      "Claude Code features: tool schemas, system prompt allowlist validation, billing attribution",
    source: 'L138458: Uw8 = "claude-code-20250219"',
    condition: "Included for non-haiku models (L238657: `if (!_) K.push(Uw8)` where _ is isHaiku)",
  },
  {
    id: "oauth-2025-04-20",
    description: "OAuth authentication support for first-party (claude.ai) tokens",
    source: 'L38022: SX = "oauth-2025-04-20"',
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
    source: 'L138459: p54 = "interleaved-thinking-2025-05-14"',
    condition:
      "Included unless DISABLE_INTERLEAVED_THINKING env is set, and model supports it (L238661-238664)",
  },
  {
    id: "redact-thinking-2026-02-12",
    description:
      "Redacts thinking block content, returns empty thinking with cryptographic signature",
    source: "Observed in v2.1.91 capture — present in ALL request types",
    condition:
      "CC sends it everywhere. WE deliberately exclude it from conversations " +
      "(thinking stays visible in the TUI) and keep it only in the quota/title " +
      "probe sets — see buildBetaFlags. The canonical transport differs (always " +
      "adds it); pinned in the characterization suites.",
  },
  {
    id: "context-management-2025-06-27",
    description: "Server-side context window management (auto-compression, prioritization)",
    source: 'L138461: Qw8 = "context-management-2025-06-27"',
    condition:
      "Included when first-party and USE_API_CONTEXT_MANAGEMENT env or model qualifies via ZB9() (L238677)",
  },
  {
    id: "prompt-caching-scope-2026-01-05",
    description: "Scoped prompt caching: cache_control blocks persist across requests in a session",
    source: 'L138468: tB6 = "prompt-caching-scope-2026-01-05"',
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
  {
    id: "mid-conversation-system-2026-04-07",
    description:
      'Accepts {role:"system"} entries inside messages[] (mid-conversation operator nudges)',
    source: 'cli.patched.cjs L116093 v2.1.154: Yy = qf("mid_conversation_system", "...")',
    condition: "Included for opus-4-6+/sonnet-4-6 conversation requests",
  },
  {
    id: "extended-cache-ttl-2025-04-11",
    description: 'Enables cache_control.ttl:"1h" (default is 5m without this flag)',
    source: 'cli.patched.cjs L116081 v2.1.154: NGH = qf("extended_cache_ttl", "...")',
    condition: "Included when any cache_control entry on the request requests 1h TTL",
  },
  {
    id: "thinking-token-count-2026-05-13",
    description: "Server populates usage.output_tokens_details.thinking_tokens on message_delta",
    source: 'cli.patched.cjs L116084 v2.1.154: cr_ = qf("thinking_token_count", "...")',
    condition:
      "Always-on in CC's captures, but NOT currently sent by either of our " +
      "transports (declared here for the taxonomy/--list-flags only). Add it " +
      "to buildBetaFlags when thinking-token accounting lands.",
  },
  {
    id: "fast-mode-2026-02-01",
    description: 'Enables top-level speed:"fast" — ~2.5x output tok/s at premium pricing',
    source: 'cli.patched.cjs L116082 v2.1.154: bUH = qf("speed", "fast-mode-2026-02-01")',
    condition: "Included when speed:'fast' is set on the request body",
  },
  {
    id: "task-budgets-2026-03-13",
    description: "Enables output_config.task_budget — model self-moderates against a token budget",
    source: 'cli.patched.cjs L116079 v2.1.154: dr_ = qf("task_budgets", "...")',
    condition: "Included when output_config.task_budget is set (min 20_000 total)",
  },
  {
    id: "cache-diagnosis-2026-04-07",
    description: "Enables top-level diagnostics:{previous_message_id} for prompt-cache debugging",
    source: 'cli.patched.cjs L116087 v2.1.154: NKH = qf("cache_diagnosis", "...")',
    condition: "Included for cache-diagnosis debugging sessions only",
  },
]
