/**
 * Provider-neutral system-prompt construction.
 *
 * The agent builds a provider-AGNOSTIC skeleton here:
 *
 * ```text
 * [ <neutral identity>, <instructions (cached)>, <session context?> ]
 * ```
 *
 * then asks the request's provider plugin to resolve the FINAL wire blocks
 * via {@link ProviderPlugin.resolveSystemPrompt}. That is the single seam
 * where a provider injects its mandatory preamble:
 *
 *   - Anthropic + OAuth (plan auth) replaces the neutral identity with the
 *     exact `billing` + `"You are Claude Code, …"` blocks their server
 *     validates. (Implemented in `plugins/llm-anthropic`.)
 *   - Every other provider (and Anthropic on an api-key) keeps the neutral
 *     identity `"You are Minimal Agent, …"`.
 *
 * Why a dedicated module (not `headers.ts`): `headers.ts` is the Anthropic-
 * flavored wire layer and hardcodes the Claude-Code identity. This module is
 * provider-neutral and is what the agent + the resume-drift hash both call,
 * so a single resolver keeps the two call sites byte-consistent and lets
 * sub-agents (future) resolve their OWN provider's prompt independently.
 *
 * The legacy `headers.buildSystemPrompt` / `SYSTEM_PROMPT` are kept as a
 * frozen Anthropic-shaped shim for back-compat (the legacy `client.ts`
 * default); new code should route through {@link resolveSystemPromptForModel}.
 *
 * @module llm/system-prompt
 */

import {
  buildInstructionsBlockText,
  type InstructionsBlockOptions,
  type SystemBlock,
} from "../headers.ts"
import { promptPath, renderPrompt } from "../prompts.ts"

import { resolveModel } from "./model-registry.ts"
import type { ProviderAuth } from "./provider.ts"
import {
  findProviderPlugin,
  neutralSystemPrompt,
  type SystemPromptBlock,
  type SystemPromptContext,
} from "./provider-plugin.ts"

/**
 * Default identity for every provider that doesn't override it. Deliberately
 * NOT "You are Claude Code …" — that string is Anthropic-plan-auth specific
 * and is injected by the Anthropic provider only when the auth kind warrants.
 */
export const NEUTRAL_IDENTITY: string = renderPrompt(
  promptPath(import.meta, "..", "prompts", "identity.neutral.md"),
)

/** Options for building the agent's provider-neutral system-prompt body. */
export interface AgentSystemPromptOptions extends InstructionsBlockOptions {
  /** Session-specific guidance block (env, CLAUDE.md, git status, …). */
  sessionContext?: string
}

/**
 * Build the provider-neutral BODY blocks (everything after the identity):
 * the cached instructions block, then the optional session-context block.
 * Cache-control mirrors live traffic (`ttl:"1h"`, `scope:"global"` on
 * instructions; per-session `ttl:"1h"` on session context).
 */
export function buildAgentSystemBody(opts?: AgentSystemPromptOptions): SystemPromptBlock[] {
  const blocks: SystemPromptBlock[] = [
    {
      type: "text",
      text: buildInstructionsBlockText(opts),
      cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
    },
  ]
  if (opts?.sessionContext) {
    blocks.push({
      type: "text",
      text: opts.sessionContext,
      cache_control: { type: "ephemeral", ttl: "1h" },
    })
  }
  return blocks
}

/** Options for {@link resolveSystemPromptForModel}. */
export interface ResolveSystemPromptOptions extends AgentSystemPromptOptions {
  /**
   * Auth kind the request will use. The provider varies its preamble on this
   * (Anthropic injects billing+ClaudeCode only for `"oauth"` plan auth).
   * Defaults to `"oauth"` so the common Anthropic-plan path is unchanged when
   * a caller omits it.
   */
  authKind?: ProviderAuth["kind"]
  /** Override the neutral identity line. Providers may still replace it. */
  identity?: string
}

/**
 * Resolve the final system-prompt blocks for `modelId` by building the
 * neutral skeleton and delegating to the model's provider plugin (via the
 * registry seam — no provider is imported by name). Falls back to the
 * neutral prompt when the model is unknown or its provider declares no hook.
 */
export function resolveSystemPromptForModel(
  modelId: string,
  opts?: ResolveSystemPromptOptions,
): SystemBlock[] {
  const ctx: SystemPromptContext = {
    identity: opts?.identity ?? NEUTRAL_IDENTITY,
    body: buildAgentSystemBody(opts),
    authKind: opts?.authKind ?? "oauth",
    modelId,
  }

  let providerId: string | undefined
  try {
    providerId = resolveModel(modelId).providerId
  } catch {
    providerId = undefined
  }
  const plugin = providerId ? findProviderPlugin(providerId) : undefined
  const resolved = plugin?.resolveSystemPrompt
    ? plugin.resolveSystemPrompt(ctx)
    : neutralSystemPrompt(ctx)

  // `SystemPromptBlock` is structurally identical to `headers.SystemBlock`;
  // the cast documents that equivalence for the legacy callers.
  return resolved as SystemBlock[]
}
