/**
 * Synthetic text resolver (G3, R-API-4).
 *
 * Asks the provider that owns a {@link SyntheticKind} for its text. Core holds
 * no text: with no owner, or when the owner throws or answers "", the result
 * is "" (bare core).
 *
 * Diagnostics use an empty message. The `source` and `structuredData.kind`
 * carry the facts.
 *
 * @module agent/synthetic-text
 */

import type {
  SyntheticFacts,
  SyntheticKind,
  SyntheticTextProvider,
} from "../../plugin-api/src/types/synthetic-text.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { TextBlock } from "../llm/messages.ts"

/** A provider returned "" for a kind (R-API-4.2). The message is always empty. */
export class SyntheticTextEmptyError extends Error {
  static readonly kind = "SyntheticTextEmptyError"
  readonly kind: string = SyntheticTextEmptyError.kind
  readonly syntheticKind: SyntheticKind

  constructor(syntheticKind: SyntheticKind) {
    super("")
    this.name = SyntheticTextEmptyError.kind
    this.syntheticKind = syntheticKind
  }
}

/** Resolves synthetic text through providers. Returns "" when no provider answers. */
export interface SyntheticTextResolver {
  resolve(kind: SyntheticKind, facts: SyntheticFacts): string
}

/**
 * Build a resolver. At most one provider owns a kind: the first wins and a
 * duplicate records `synthetic.duplicate_owner`. An empty answer records
 * `synthetic.empty_text`. A throw records `synthetic.provider_failed`. Both
 * return "". A kind with no owner returns "" and records nothing.
 */
export function createSyntheticTextResolver(
  providers: readonly SyntheticTextProvider[],
  diagnostics: Diagnostics,
): SyntheticTextResolver {
  const owners = new Map<SyntheticKind, SyntheticTextProvider>()
  for (const provider of providers) {
    for (const kind of provider.kinds) {
      if (owners.has(kind)) diagnostics.warn("synthetic.duplicate_owner", "", { kind })
      else owners.set(kind, provider)
    }
  }
  return {
    resolve(kind, facts) {
      const owner = owners.get(kind)
      if (!owner) return ""
      try {
        const text = owner.text(kind, facts)
        if (typeof text !== "string" || text === "") throw new SyntheticTextEmptyError(kind)
        return text
      } catch (e) {
        const source =
          e instanceof SyntheticTextEmptyError
            ? "synthetic.empty_text"
            : "synthetic.provider_failed"
        diagnostics.warn(source, "", { kind })
        return ""
      }
    },
  }
}

/**
 * The shared guard for a synthetic text that becomes its own block: one
 * text block, or `null` when `text` is "" (bare core, or a provider that
 * failed). An empty text block is invalid on some providers (Anthropic:
 * "text content blocks must be non-empty"). The caller only decides whether
 * to add the block; it must not branch on the emptiness for anything else.
 */
export function textBlockOrNull(text: string): TextBlock | null {
  return text ? { type: "text", text } : null
}

/**
 * A resolver with no provider: every call returns "" and records nothing.
 * The default for pure helpers and for tool runs with no core.
 */
export const EMPTY_SYNTHETIC_TEXT: SyntheticTextResolver = Object.freeze({
  resolve: (_kind: SyntheticKind, _facts: SyntheticFacts) => "",
})
