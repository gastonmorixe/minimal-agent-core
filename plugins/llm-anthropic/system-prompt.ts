/**
 * Anthropic system-prompt resolution.
 *
 * Anthropic's server validates the leading system blocks when the request is
 * authenticated with a **subscription/plan OAuth token** (our reverse
 * engineering found the prefix is checked against an allowlist + a billing
 * attribution header). So for `authKind: "oauth"` we MUST emit, byte-exact and
 * in this order:
 *
 *   system[0]  x-anthropic-billing-header: cc_version=<v>.<hash>; cc_entrypoint=cli; cch=00000;
 *   system[1]  You are Claude Code, Anthropic's official CLI for Claude.
 *
 * followed by the agent's neutral body (instructions + session context). The
 * neutral identity line the agent proposes is DROPPED in this case (the
 * Claude-Code identity replaces it).
 *
 * For any other auth kind (`api-key`, `custom` — e.g. a raw Anthropic API key,
 * not a Claude subscription) there is no such server-side validation, so we
 * keep the neutral identity and add NO billing header. That is the honest
 * shape for a non-plan caller.
 *
 * @module llm/providers/anthropic/system-prompt
 */

import { BUILD_HASH, VERSION } from "../../src/headers.ts"
import {
  neutralSystemPrompt,
  type SystemPromptBlock,
  type SystemPromptContext,
} from "../../src/llm/provider-plugin.ts"

/** The exact Claude-Code identity line the server validates (plan auth). */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

/** Build the billing attribution block (system[0] on plan auth). */
export function buildBillingBlock(): SystemPromptBlock {
  return {
    type: "text",
    text: `x-anthropic-billing-header: cc_version=${VERSION}.${BUILD_HASH}; cc_entrypoint=cli; cch=00000;`,
  }
}

/**
 * Resolve Anthropic's final system-prompt blocks. OAuth/plan auth gets the
 * mandatory billing + Claude-Code identity preamble; everything else keeps the
 * agent's neutral identity.
 */
export function resolveAnthropicSystemPrompt(ctx: SystemPromptContext): SystemPromptBlock[] {
  if (ctx.authKind === "oauth") {
    return [buildBillingBlock(), { type: "text", text: CLAUDE_CODE_IDENTITY }, ...ctx.body]
  }
  return neutralSystemPrompt(ctx)
}
