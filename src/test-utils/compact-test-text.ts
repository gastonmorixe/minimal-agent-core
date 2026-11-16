/**
 * A stub synthetic text resolver for compaction behavior tests.
 *
 * Core owns no compaction text (15d.3b): the 3 `compact.*` kinds come from
 * ma-turn-recovery-plugin. Tests that check compaction BEHAVIOR (retries,
 * auth, send hooks, events) need some non-empty text, or local mode throws
 * `CompactNoProviderError` (15d.4). This resolver answers the 3 kinds with
 * a short tag that names the kind and its facts, and "" for every other kind
 * (the same as a core with no providers). Tests that check the English bytes
 * use `fixtureSyntheticTextResolver` (text-fixture-providers.ts) instead.
 *
 * @module test-utils/compact-test-text
 */

import type {
  SyntheticFacts,
  SyntheticKind,
  SyntheticTextProvider,
} from "../../plugin-api/src/types/synthetic-text.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"

/** Stub text for one compaction kind: `[kind {facts json}]`. */
export function compactTestTextFor(kind: SyntheticKind, facts: SyntheticFacts): string {
  return `[${kind} ${JSON.stringify(facts)}]`
}

/** Answers the 3 `compact.*` kinds with {@link compactTestTextFor}, "" for the rest. */
export const COMPACT_TEST_TEXT: SyntheticTextResolver = Object.freeze({
  resolve: (kind: SyntheticKind, facts: SyntheticFacts) =>
    kind.startsWith("compact.") ? compactTestTextFor(kind, facts) : "",
})

/** The same text as a provider, for hosts built from providers (`buildTestCore`). */
export function compactTestTextProvider(): SyntheticTextProvider {
  return {
    kinds: ["compact.summary_system", "compact.tail_checkpoint", "compact.local_checkpoint"],
    text: compactTestTextFor,
  }
}
