/**
 * Reflection-checkpoint utilities used by the agent's run() loop.
 *
 * Two primitives live here, both pure (no keyboard, no timer, no I/O):
 *
 *  - {@link parseReflectionAck} extracts the reflection-ack tag
 *    (`<ma::agent::reflection-ack silence-for="K" reason="..." />`)
 *    out of an assistant response.
 *  - {@link buildReflectionCheckpointBlock} produces the user-content
 *    attachment injected after a cooldown.
 *
 * The wall-clock pause itself (Esc-skip, raw input capture, the status
 * countdown) is a host concern: `AgentCore` only calls the optional
 * `reflectionGate` port (`src/sdk/host-ports.ts`, S17) before it builds the
 * checkpoint attachment, and awaits whatever the host does. The TUI's
 * implementation of that pause (formerly `runReflectionCooldown`, here)
 * moved to `minimal-agent-cli/src/reflection-cooldown.ts` in S30, which is the one file
 * that may still import the input capture stack.
 *
 * Split out of the legacy `src/agent.ts` (since removed) to keep it under
 * the `max-lines` lint budget. `AgentCore` imports these directly.
 *
 * @module agent/reflection
 */

import type { ContentBlock } from "../llm/messages.ts"

import { reflectionCheckpointText } from "./synthetic-fallbacks.ts"
import type { SyntheticTextResolver } from "./synthetic-text.ts"

/**
 * Default interval (in tool-execution rounds) between reflection
 * checkpoints within a single `run()` call. 50 because a real agentic
 * session can hit 30+ rounds on one complex task; past 50, "still on
 * track?" is a fair question. Configurable per-Agent; 0 disables.
 *
 * Owned here (agent-loop config) as of refactor Wave 1; `src/headers.ts`
 * re-exports for back-compat until the legacy module dissolves.
 */
export const DEFAULT_REFLECTION_INTERVAL = 50

/**
 * Default wall-clock cooldown (ms) applied at each reflection checkpoint
 * before the next API request: (1) gives a watching human an Esc window,
 * (2) surfaces elapsed wall time to the model via the
 * `cooldown-applied-seconds` attribute. Configurable per-Agent; 0 keeps
 * the checkpoint attachment but skips the pause.
 *
 * Owned here (agent-loop config) as of refactor Wave 1.
 */
export const DEFAULT_REFLECTION_COOLDOWN_MS = 60_000

/**
 * Regex matching a `<ma::agent::reflection-ack silence-for="K" reason="..." />`
 * tag in assistant response text. Both attributes are optional in either
 * order. Anchored to `\b` boundaries on the attribute names so a typo
 * like `silencefor` doesn't accidentally match.
 *
 * Captures: group 1 = silence-for value (digits), group 2 = reason text.
 * When the attribute is absent the capture is `undefined`. The model is
 * expected to emit this tag at most once per response : when multiple
 * tags appear the LAST well-formed one wins (see {@link parseReflectionAck}).
 */
const REFLECTION_ACK_RE =
  /<ma::agent::reflection-ack(?:\s+(?:silence-for="(\d+)"|reason="([^"]*)")){0,2}\s*\/>/g

/**
 * Parse `<ma::agent::reflection-ack ... />` tags out of an assistant response.
 *
 * Returns the LAST well-formed tag's parsed values (or `null` if none),
 * so a model that hedges by emitting multiple acks ends with the value
 * it most recently committed to. `silenceFor` defaults to 1 when the
 * attribute is omitted; a 0 disables the ack (no silence applied).
 * Reason is stored verbatim for transcript logging.
 *
 * @param responseText - The assistant response body to scan.
 * @returns The parsed ack, or `null` when no well-formed tag is present.
 */
export function parseReflectionAck(
  responseText: string,
): { silenceFor: number; reason: string } | null {
  let result: { silenceFor: number; reason: string } | null = null
  for (const m of responseText.matchAll(REFLECTION_ACK_RE)) {
    const silenceForRaw = m[1]
    const reason = m[2] ?? ""
    const silenceFor = silenceForRaw === undefined ? 1 : Number.parseInt(silenceForRaw, 10)
    if (!Number.isFinite(silenceFor) || silenceFor < 0) continue
    result = { silenceFor, reason }
  }
  return result
}

/**
 * Build the `<ma::agent::reflection-checkpoint ... />` attachment text that
 * gets injected into the next user content after a cooldown. The
 * `cooldown-applied-seconds` attribute carries the wall-clock penalty
 * the model can reason about; the trailing prose restates the soft-
 * checkpoint contract so a model that didn't read the system-prompt
 * paragraph carefully still has the ack syntax right next to where it
 * matters.
 *
 * @param round - The current tool-loop round.
 * @param cooldownMs - The wall-clock pause that was applied (or 0 when
 *   the checkpoint fired without a cooldown).
 * @param text - The core's synthetic text resolver (kind
 *   `runtime.reflection_checkpoint`). Omitted: the fallback text.
 * @returns A user-content `ContentBlock` ready to prepend on the next turn.
 */
export function buildReflectionCheckpointBlock(
  round: number,
  cooldownMs: number,
  text?: SyntheticTextResolver,
): ContentBlock {
  const cooldownSec = Math.max(0, Math.round(cooldownMs / 1000))
  return {
    type: "text",
    text: reflectionCheckpointText(round, cooldownSec, text),
  }
}
