/**
 * TUI rendering for {@link TurnNotice} values: out-of-band conditions the
 * agent loop surfaces (provider refusal / content filter, output-budget
 * events, reflection-ack confirmations).
 *
 * The agent core detects each condition and hands the semantic value to
 * the host via the `onNotice` hook on `Agent.run` opts; THIS module
 * decides what each looks like in the terminal. Keeping the ANSI here
 * (and out of `src/agent.ts`) preserves the core/presentation split:
 * headless hosts and `--json` mode never pay for or depend on terminal
 * styling.
 *
 * @module host/ui/turn-notice
 */

import type { TurnNotice } from "../../agent/turn-notice.ts"

import { c } from "./style/ansi.ts"

/**
 * Render a turn notice as one or more transcript lines. The severity the
 * core attached picks the treatment: `error` → red pill banner, `warn` →
 * yellow bang line, `info` → dim marker. The exhaustive `switch` makes a
 * newly-added notice kind a compile error until it has a rendering.
 *
 * Returned as a single string suitable for the hosts' `onTranscriptLine`
 * writers (which handle the text→transcript boundary + newline
 * bookkeeping).
 */
export function renderTurnNotice(notice: TurnNotice): string {
  switch (notice.kind) {
    case "refusal":
    case "content_filter": {
      const label = notice.kind === "refusal" ? "REFUSAL" : "CONTENT FILTER"
      const category = notice.category ? ` (${notice.category})` : ""
      const message = notice.message ? ` — ${notice.message}` : ""
      return (
        `\n  ${c.redPill(`◼ ${label}`)} ${c.red(
          `The provider's safety layer ended the response${category}${message}`,
        )}` +
        `\n  ${c.dim("The reply above (if any) is incomplete. Rephrasing the request usually gets past a false positive.")}`
      )
    }
    case "max_tokens_salvaged":
      return `\n  ${c.boldYellow("!")} ${c.yellow(
        "Response hit the max_tokens ceiling mid tool-call — salvaged the in-flight call and continuing",
      )}`
    case "max_tokens_continuing":
      return `\n  ${c.boldYellow("!")} ${c.yellow(
        `Response hit the max_tokens ceiling — auto-continuing (${notice.attempt}/${notice.cap})`,
      )}`
    case "max_tokens_capped":
      return `\n  ${c.boldYellow("!")} ${c.yellow(
        `Response hit the max_tokens ceiling ${notice.cap} times in a row — stopping. Consider narrowing the request or raising max_tokens.`,
      )}`
    case "tool_rounds_capped":
      return `\n  ${c.boldYellow("!")} ${c.yellow(
        `Emergency cap reached (${notice.cap} tool rounds) — sending final tools-disabled wrap-up`,
      )}`
    case "reflection_ack": {
      const suffix = notice.reason.length > 0 ? ` — ${notice.reason}` : ""
      const via = notice.fromToolFallback ? " (from tool_use fallback)" : ""
      const plural = notice.silenceFor === 1 ? "" : "s"
      return `  ${c.dim("›")} ${c.dim(
        `reflection ack: silencing next ${notice.silenceFor} checkpoint${plural}${suffix}${via}`,
      )}`
    }
    default: {
      const _exhaustive: never = notice
      return _exhaustive
    }
  }
}
