/**
 * Turn content collector (G2, R-API-5).
 *
 * Runs the registered providers and returns their blocks. Core holds no text
 * here. A failing provider records a warn diagnostic with an empty message.
 *
 * @module agent/turn-content
 */

import type {
  TurnContentCtx,
  TurnContentProviderDecl,
} from "../../plugin-api/src/types/turn-content.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { ContentBlock } from "../llm/messages.ts"

function frozenCopy(ctx: TurnContentCtx): TurnContentCtx {
  const { modeChange } = ctx
  return Object.freeze({
    ...ctx,
    ...(modeChange ? { modeChange: Object.freeze({ ...modeChange }) } : {}),
  })
}

/**
 * Collect blocks from `providers` in ascending `order`. Ties keep
 * registration order (the sort is stable).
 */
export async function collectTurnContent(
  providers: readonly TurnContentProviderDecl[],
  ctx: TurnContentCtx,
  diagnostics: Diagnostics,
): Promise<ContentBlock[]> {
  const out: ContentBlock[] = []
  const sorted = providers
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.order - b.p.order || a.i - b.i)
  for (const { p } of sorted) {
    try {
      out.push(...(await p.provide(frozenCopy(ctx))))
    } catch {
      diagnostics.warn("turn_content.provider_failed", "", { order: p.order })
    }
  }
  return out
}

/**
 * Placement rule (S3.1): provider blocks go AFTER every existing core slot of
 * the user message. No existing slot moves. S3.4 reorders.
 */
export function initialTurnContentCtx(previousTurn: "aborted" | "resumed" | null): TurnContentCtx {
  return {
    seam: "initial",
    round: 0,
    previousTurn,
    salvaged: false,
    // No producer in core today (S3.1).
    resumingFromCheckpoint: false,
  }
}

/** Context for the round seam. `salvaged` is true when the salvage text was added. */
export function roundTurnContentCtx(round: number, salvaged: boolean): TurnContentCtx {
  return { seam: "round", round, previousTurn: null, salvaged, resumingFromCheckpoint: false }
}

/** Push the provider blocks for `ctx` onto `content` (after the core slots). */
export async function appendTurnContent(
  content: ContentBlock[],
  providers: readonly TurnContentProviderDecl[],
  ctx: TurnContentCtx,
  diagnostics: Diagnostics,
): Promise<void> {
  if (providers.length > 0) content.push(...(await collectTurnContent(providers, ctx, diagnostics)))
}

/** Initial seam: append provider blocks after the core slots. */
export function appendInitialTurnContent(
  content: ContentBlock[],
  providers: readonly TurnContentProviderDecl[],
  previousTurn: "aborted" | "resumed" | null,
  diagnostics: Diagnostics,
): Promise<void> {
  return appendTurnContent(content, providers, initialTurnContentCtx(previousTurn), diagnostics)
}

/** Round seam: append provider blocks after the core slots. */
export function appendRoundTurnContent(
  content: ContentBlock[],
  providers: readonly TurnContentProviderDecl[],
  round: number,
  salvaged: boolean,
  diagnostics: Diagnostics,
): Promise<void> {
  return appendTurnContent(content, providers, roundTurnContentCtx(round, salvaged), diagnostics)
}
