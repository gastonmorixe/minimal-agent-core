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

import { type CacheTtl, DEFAULT_CACHE_TTL } from "../cache/cache-ttl.ts"
import { promptPath, renderPrompt } from "../prompts/prompts.ts"

import { buildInstructionsBlockText, type InstructionsBlockOptions } from "./instructions-block.ts"
import { resolveModel } from "./model-registry.ts"
import type { ProviderAuth } from "./provider.ts"
import {
  findProviderPlugin,
  neutralSystemPrompt,
  type SystemPromptBlock,
  type SystemPromptContext,
} from "./provider-plugin.ts"
import { applyPromptPartOverride, type SystemPromptOverrides } from "./system-prompt-overrides.ts"
import type { SystemBlock } from "./transport/types.ts"

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
  /**
   * TTL bucket for the ephemeral cache breakpoints placed on the system
   * blocks. Defaults to {@link DEFAULT_CACHE_TTL} (`"5m"`). Resolved upstream
   * from `--cache-ttl` / `MINIMAL_AGENT_CACHE_TTL` / config; see
   * `src/cache-ttl.ts`. The rolling tail breakpoint in `src/agent/cache.ts`
   * must be given the SAME value so the whole cached prefix uses one TTL.
   */
  cacheTtl?: CacheTtl
}

/**
 * Build the provider-neutral BODY blocks (everything after the identity):
 * the cached instructions block, then the optional session-context block.
 * Cache-control mirrors live traffic (`scope:"global"` on instructions;
 * per-session on session context). The `ttl` bucket is configurable via
 * `opts.cacheTtl` and defaults to {@link DEFAULT_CACHE_TTL} (`"5m"`).
 */
export function buildAgentSystemBody(opts?: AgentSystemPromptOptions): SystemPromptBlock[] {
  const ttl = opts?.cacheTtl ?? DEFAULT_CACHE_TTL
  const overrides = opts?.overrides
  const instructionsText = buildInstructionsBlockText(opts)
  const blocks: SystemPromptBlock[] = []
  if (instructionsText.length > 0) {
    blocks.push({
      type: "text",
      text: instructionsText,
      cache_control: { type: "ephemeral", ttl, scope: "global" },
    })
  }
  const sessionContext = applyPromptPartOverride(opts?.sessionContext, overrides?.sessionContext)
  if (sessionContext) {
    blocks.push({
      type: "text",
      text: sessionContext,
      cache_control: { type: "ephemeral", ttl },
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
  /** Resolved system-prompt overrides for identity/full/sessionContext/providerPreamble. */
  overrides?: SystemPromptOverrides
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
  const overrides = opts?.overrides

  // full override: replace or omit the entire core-controllable body.
  if (overrides?.full) {
    if (overrides.full.kind === "omit") return []
    if (overrides.full.kind === "replace") {
      return [{ type: "text", text: overrides.full.text }] as SystemBlock[]
    }
  }

  const identity =
    applyPromptPartOverride(opts?.identity ?? NEUTRAL_IDENTITY, overrides?.identity) ??
    NEUTRAL_IDENTITY

  const ctx: SystemPromptContext = {
    identity,
    body: buildAgentSystemBody(opts),
    authKind: opts?.authKind ?? "oauth",
    modelId,
  }
  if (overrides?.providerPreamble && overrides.providerPreamble.kind !== "default") {
    ctx.providerPreambleOverride = overrides.providerPreamble as
      | { readonly kind: "replace"; readonly text: string }
      | { readonly kind: "omit" }
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
