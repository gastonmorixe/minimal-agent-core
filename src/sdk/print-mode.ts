/**
 * Non-interactive output-mode helpers for the SDK core (Phase 4).
 *
 * A pure, host-free module: no `process.stdout` writes, no host imports, no
 * side effects. Every function maps inputs to a string (or a value), so the
 * host adapter (CLI `--print` / `--json`, a test harness, a future SDK
 * consumer) decides where bytes actually go. This keeps the decision of
 * "what to render" in the functional core and the decision of "where to
 * write it" in the imperative shell.
 *
 * Behavioral model mirrors Codex's non-interactive surface:
 *   - `--json` selects a machine-readable JSONL event stream (one
 *     {@link AgentEvent} per line) regardless of TTY.
 *   - human mode renders progress to stderr and the final answer to stdout.
 *   - the final answer is printed to stdout only when stdout is NOT a TTY
 *     (piped / redirected), matching Codex's
 *     `should_print_final_message_to_stdout`: interactive runs already showed
 *     the answer in the transcript, so re-printing it would double it.
 *
 * Design principles (from software-best-design-patterns):
 *   - Functional core, imperative shell: these are pure transforms.
 *   - Single source of truth for event types: {@link AgentEvent} and
 *     {@link EventSink} are imported type-only from `./events` (Betty's
 *     canonical module); this file never re-defines them.
 *
 * @module sdk/print-mode
 */

import { formatTurnNoticePlain } from "../agent/turn-notice.ts"

import type { AgentEvent } from "./events.ts"
import { serializeEvent } from "./events.ts"

// ---------------------------------------------------------------------------
// Output mode
// ---------------------------------------------------------------------------

/**
 * The non-interactive output mode. `human` renders progress + a final answer
 * for a person reading a terminal or a log; `json` emits a JSONL event stream
 * for a program to parse.
 */
export type OutputMode = "human" | "json"

/**
 * Resolved options for a non-interactive run. `mode` is the selected output
 * mode; `outputSchema`, when present, is a JSON Schema object the host uses
 * to constrain / validate the model's final structured answer (Codex
 * `--output-schema`). The schema is carried, not interpreted, here.
 */
export interface PrintModeOptions {
  mode: OutputMode
  outputSchema?: object
}

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

/**
 * Pick the output mode from the CLI flags + terminal shape.
 *
 * `--json` always wins: a caller that asked for machine output gets JSONL
 * even on a TTY. Otherwise the mode is `human`. (TTY-ness does not change the
 * MODE; it changes whether the final answer is echoed to stdout — see
 * {@link shouldPrintFinalToStdout}.)
 */
export function selectOutputMode(opts: { isTTY: boolean; jsonFlag: boolean }): OutputMode {
  return opts.jsonFlag ? "json" : "human"
}

/**
 * Whether the final assistant message should be written to stdout.
 *
 * Mirrors Codex `should_print_final_message_to_stdout`: in `json` mode the
 * final answer is already carried by the event stream, so we do not also
 * print it as prose. In `human` mode we print it to stdout only when stdout
 * is NOT a TTY (piped or redirected) — an interactive transcript already
 * showed it, and re-printing would duplicate the answer.
 */
export function shouldPrintFinalToStdout(opts: { mode: OutputMode; isTTY: boolean }): boolean {
  if (opts.mode === "json") return false
  return !opts.isTTY
}

// ---------------------------------------------------------------------------
// Final message
// ---------------------------------------------------------------------------

/**
 * Format the run's final assistant message for the chosen mode.
 *
 * - `human`: the text trimmed of trailing whitespace, with exactly one
 *   trailing newline (so piping into a file ends cleanly). An empty / blank
 *   answer yields the empty string (nothing to print).
 * - `json`: a single terminal {@link AgentEvent} of type `item_completed`
 *   (itemType `text`) serialized as one JSONL line, so a `--json` consumer
 *   sees the final answer as a normal event rather than as out-of-band prose.
 */
export function formatFinalMessage(text: string, mode: OutputMode): string {
  if (mode === "json") {
    const event: AgentEvent = {
      type: "item_completed",
      itemType: "text",
      id: "final",
      text,
    }
    return serializeEvent(event)
  }
  const trimmed = text.replace(/\s+$/u, "")
  return trimmed.length === 0 ? "" : `${trimmed}\n`
}

// ---------------------------------------------------------------------------
// Per-event rendering
// ---------------------------------------------------------------------------

/**
 * Render one structured event as a single JSONL line for `--json` mode.
 *
 * Thin wrapper over {@link serializeEvent} so a host can route every event
 * through one rendering entry point. The returned string already ends in a
 * newline; concatenating successive calls yields a valid JSON Lines stream.
 */
export function renderJsonEvent(event: AgentEvent): string {
  return serializeEvent(event)
}

/**
 * Render one structured event as a short, human-readable progress line for
 * `human` mode (written to stderr by the host, NOT stdout). Returns the empty
 * string for events that carry no useful progress signal, so the host can
 * skip empty writes.
 *
 * The exhaustive `switch (event.type)` narrows the discriminated union; the
 * `_exhaustive: never` default makes a newly-added event variant a compile
 * error here until it is handled.
 */
export function renderHumanProgressLine(event: AgentEvent): string {
  switch (event.type) {
    case "turn_started":
      return `· turn ${event.turn} started`
    case "item_started":
      return `· ${event.itemType} …`
    case "item_completed": {
      if (event.itemType === "tool_use") {
        return `· tool ${event.text ?? "?"}`
      }
      // text / thinking: a completed item is not itself progress-worthy
      return ""
    }
    case "text_delta":
    case "thinking_delta":
      // Per-token deltas are the realtime `stream-json` surface, not a human
      // progress line: rendering one line per token would flood stderr. The
      // completed item (or the streamed stdout) carries the body.
      return ""
    case "tool_result": {
      const status = event.isError ? "error" : "ok"
      return `· ${event.name} → ${status}`
    }
    case "turn_completed": {
      const { inputTokens, outputTokens } = event.usage
      const stop = event.stopReason ?? "—"
      return `· turn ${event.turn} done (${stop}; in ${inputTokens} / out ${outputTokens})`
    }
    case "notice": {
      // Reuse the core's style-free one-liner: `human` progress lines are
      // plain text, and the fallback formatter is exactly that.
      const marker = event.notice.severity === "error" ? "✗" : "·"
      return `${marker} ${formatTurnNoticePlain(event.notice)}`
    }
    case "error":
      return `✗ ${event.message}`
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

/**
 * Route one event to the correct renderer for the active mode. `json` →
 * {@link renderJsonEvent}; `human` → {@link renderHumanProgressLine}. The
 * single dispatch a host loop needs.
 */
export function renderEvent(event: AgentEvent, mode: OutputMode): string {
  return mode === "json" ? renderJsonEvent(event) : renderHumanProgressLine(event)
}
