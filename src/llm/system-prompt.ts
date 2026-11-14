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
 * flavored wire layer and hardcodes a provider-specific identity. This module is
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
import { resolveBaseIdentity, type SystemPromptBaseHolder } from "../plugins/system-prompt-base.ts"
import { promptPath, renderPrompt } from "../prompts/prompts.ts"

import {
  buildInstructionsBlockParts,
  type InstructionsBlockOptions,
  type InstructionsBlockPart,
} from "./instructions-block.ts"
import { findModelForProvider, resolveModel } from "./model-registry.ts"
import type { ProviderAuth } from "./provider.ts"
import {
  findProviderPlugin,
  neutralSystemPrompt,
  type SystemPromptBlock,
  type SystemPromptContext,
} from "./provider-plugin.ts"
import {
  recordSystemBlock,
  type SystemSlotId,
  type SystemSlotSpan,
} from "./system-block-origins.ts"
import { getSystemPromptBase } from "./system-prompt-base-registry.ts"
import {
  applyPromptPartOverride,
  isActivePromptOverride,
  type SystemPromptOverrides,
} from "./system-prompt-overrides.ts"
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
  /**
   * Plain-markdown block inserted immediately AFTER the instructions block
   * and BEFORE {@link sessionContext}. For plugin/host content that should
   * read as first-class guidance (not a plugin `<ma::sys::…>` section).
   * Per-session cache (no `scope:"global"`).
   */
  afterInstructions?: string
  /** Session-specific guidance block (plugin prompts, env snapshot, …). */
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
 * the cached instructions block, then optional after-instructions (plain
 * markdown), then the optional session-context block.
 * Cache-control mirrors live traffic (`scope:"global"` on instructions;
 * per-session on after-instructions and session context). The `ttl` bucket
 * is configurable via `opts.cacheTtl` and defaults to {@link DEFAULT_CACHE_TTL}
 * (`"5m"`).
 */
export function buildAgentSystemBody(opts?: AgentSystemPromptOptions): SystemPromptBlock[] {
  const ttl = opts?.cacheTtl ?? DEFAULT_CACHE_TTL
  const overrides = opts?.overrides
  const parts = buildInstructionsBlockParts(opts)
  const instructionsText = parts.map((p) => p.text).join("\n\n")
  const blocks: SystemPromptBlock[] = []
  if (instructionsText.length > 0) {
    blocks.push({
      type: "text",
      text: instructionsText,
      cache_control: { type: "ephemeral", ttl, scope: "global" },
    })
    recordSystemBlock(instructionsText, instructionsSpans(parts))
  }
  const afterInstructions = opts?.afterInstructions?.trim()
  if (afterInstructions) {
    blocks.push({
      type: "text",
      text: afterInstructions,
      cache_control: { type: "ephemeral", ttl },
    })
    recordWholeBlock(afterInstructions, "afterInstructions", false)
  }
  const sessionContext = applyPromptPartOverride(opts?.sessionContext, overrides?.sessionContext)
  if (sessionContext) {
    blocks.push({
      type: "text",
      text: sessionContext,
      cache_control: { type: "ephemeral", ttl },
    })
    recordWholeBlock(
      sessionContext,
      "sessionContext",
      isActivePromptOverride(overrides?.sessionContext),
    )
  }
  return blocks
}

/** Slot spans of the instructions block: each part, then a 2-char `"\n\n"` gap. */
function instructionsSpans(parts: readonly InstructionsBlockPart[]): SystemSlotSpan[] {
  const spans: SystemSlotSpan[] = []
  let offset = 0
  for (const p of parts) {
    spans.push({
      slot: p.slot,
      start: offset,
      end: offset + p.text.length,
      overridden: p.overridden,
    })
    offset += p.text.length + 2
  }
  return spans
}

/** Record a block that one slot owns from start to end. */
function recordWholeBlock(text: string, slot: SystemSlotId, overridden: boolean): void {
  recordSystemBlock(text, [{ slot, start: 0, end: text.length, overridden }])
}

/**
 * Record each block a provider hook added as slot `providerPreamble`.
 *
 * A block whose text equals the neutral identity or a body block is a
 * pass-through: core already recorded it, so it keeps that origin. Data
 * only: the block objects and the request bytes do not change.
 */
function recordProviderBlocks(
  blocks: readonly SystemPromptBlock[],
  ctx: SystemPromptContext,
  providerId: string,
): void {
  const known = new Set<string>([ctx.identity, ...ctx.body.map((b) => b.text)])
  const override = ctx.providerPreambleOverride
  for (const b of blocks) {
    if (known.has(b.text)) continue
    recordSystemBlock(b.text, [
      {
        slot: "providerPreamble",
        start: 0,
        end: b.text.length,
        overridden: override?.kind === "replace" && override.text === b.text,
        providerId,
      },
    ])
  }
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
  /**
   * Provider id that owns this request (e.g. `--provider anthropic`).
   * When set, prompt resolution uses the provider-scoped model entry so a
   * bare model id claimed by several providers resolves to THIS provider's
   * plugin hook. Without it the global last-write-wins entry wins and a
   * colliding provider can steal the preamble.
   */
  providerId?: string
  /** Override the neutral identity line. Providers may still replace it. */
  identity?: string
  /** Resolved system-prompt overrides for identity/full/sessionContext/providerPreamble. */
  overrides?: SystemPromptOverrides
  /** The base prompt providers of the calling host. Falls back to the global registry. */
  systemPromptBase?: SystemPromptBaseHolder
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
      // Record BEFORE returning: the host reads the origin back by block text,
      // so an early return made a full-override prompt read as unrecorded. The
      // whole block belongs to the identity slot because `full` replaces the
      // identity too, and `SystemSlotId` has no `full` member.
      recordWholeBlock(overrides.full.text, "identity", true)
      return [{ type: "text", text: overrides.full.text }] as SystemBlock[]
    }
  }

  const holder = opts?.systemPromptBase ?? getSystemPromptBase()
  const base =
    (holder === undefined
      ? undefined
      : resolveBaseIdentity(holder, { authKind: opts?.authKind ?? "oauth", modelId })) ??
    NEUTRAL_IDENTITY
  const identity = applyPromptPartOverride(opts?.identity ?? base, overrides?.identity) ?? base
  recordWholeBlock(identity, "identity", isActivePromptOverride(overrides?.identity))

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

  let providerId: string | undefined = opts?.providerId
  if (!providerId) {
    try {
      providerId = resolveModel(modelId).providerId
    } catch {
      providerId = undefined
    }
  } else {
    // Prefer the scoped entry so a colliding bare id resolves to this
    // provider. Fall back to the global entry when this provider does not
    // claim the id (alias-only or ad-hoc registrations).
    const scoped = findModelForProvider(modelId, providerId)
    if (!scoped) {
      try {
        providerId = resolveModel(modelId).providerId
      } catch {
        providerId = undefined
      }
    }
  }
  const plugin = providerId ? findProviderPlugin(providerId) : undefined
  const resolved = plugin?.resolveSystemPrompt
    ? plugin.resolveSystemPrompt(ctx)
    : neutralSystemPrompt(ctx)
  if (plugin?.resolveSystemPrompt && providerId) {
    recordProviderBlocks(resolved, ctx, providerId)
  }

  // `SystemPromptBlock` is structurally identical to `headers.SystemBlock`;
  // the cast documents that equivalence for the legacy callers.
  return resolved as SystemBlock[]
}
