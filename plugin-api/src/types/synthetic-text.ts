/**
 * Synthetic text provider contract (G3, R-API-4).
 *
 * A plugin that owns a {@link SyntheticKind} supplies the text core sends in
 * place of a model or user turn (a continue nudge, a placeholder, a tool
 * error result). Core holds no such text. Each kind has at most one provider.
 *
 * @module types/synthetic-text
 */

/** Every synthetic text slot core can ask a provider to fill. */
export type SyntheticKind =
  | "continue.max_tokens"
  | "continue.stream_interrupted"
  | "assistant.placeholder"
  | "tool_result.aborted"
  | "tool_result.interrupted_by_stop"
  | "tool_result.unknown_tool"
  | "tool_result.handler_error"
  | "tool_result.non_tool_result"
  | "tool_result.invalid_input"
  | "tool_result.policy_denied"
  | "tool_result.policy_hook_failed"
  | "tool_result.canceled"
  | "tool_result.no_executor"
  | "tool_result.subprocess_overflow"
  | "user_media.rejected"
  | "user_media.unavailable"

/** Typed facts core passes to a provider. No free message text. */
export type SyntheticFacts = Readonly<Record<string, string | number | boolean>>

/** Supplies text for the kinds it lists. It MUST NOT return "" (R-API-4.2). */
export interface SyntheticTextProvider {
  readonly kinds: readonly SyntheticKind[]
  text(kind: SyntheticKind, facts: SyntheticFacts): string
}
