/**
 * Tool view port (spec S24, S29).
 *
 * The engine (`loops/tool-round.ts`) emits plain events for each tool call.
 * The events tell a host what happened: a refusal, an input error, the start
 * of a run, the live output chunks, and the final outcome. A host decides
 * whether and how to show them. The CLI builds its transcript rows from
 * them. A headless host gives no port.
 *
 * The events never carry terminal bytes made by core, and core reads no
 * terminal state for them. They never change the model-facing text.
 *
 * Hosts import these types from `@minimal-agent/core/host-kit/tool-executor-adapter`.
 *
 * @module agent/tool-view-port
 */

import type { ToolUseBlock } from "../llm/messages.ts"
import type { Finding } from "../sdk/tool-lifecycle.ts"
import type { TruncationInfo } from "../tools/truncation.ts"

/**
 * The presentation fields a plugin tool result gave, passed through as is.
 * Core does not read them, except that a body (`display`) tells core the
 * host shows a custom body, so the model gets no preview-gap note.
 */
export interface PluginToolView {
  /** Body text the plugin wants the host to show in place of `content`. */
  display?: string
  /** Header text the plugin wants the host to show in place of the input. */
  displayHeader?: string
  /** Footer text the plugin wants the host to show under the body. */
  displayFooter?: string
  /** True when the plugin shows its own time in the header. */
  suppressToolTime: boolean
}

/** The final, host-facing outcome of one tool call. */
export interface ToolViewOutcome {
  /**
   * The result text at the point a host shows it: after the binary guard,
   * the data-URI scrub, and the diagnostics note. Before the raw-output
   * footer, the preview-gap note, the policy notes, and the mode stamp.
   */
  content: string
  isError: boolean | undefined
  /** True when the call was cancelled. */
  aborted: boolean
  /** What the output clamp cut, when it ran. */
  truncInfo?: TruncationInfo
  /** A plugin body (after the scrub) or the binary-output summary. */
  display?: string
  /** A plugin footer, passed through. */
  displayFooter?: string
  /** The plain unified diff of an Edit or Write call. */
  diff?: { patch: string; newFile: boolean }
  /** Plugin diagnostics findings for this call. Empty for none. */
  findings: Finding[]
}

/**
 * One event of a tool call. `tool` always carries the input the round
 * runs with (after alias fixes and policy rewrites), not the raw model
 * input.
 */
export type ToolViewEvent =
  /** The active mode or a policy hook refused the call. */
  | { type: "refused"; tool: ToolUseBlock; message: string; refusedBy: string }
  /** The input failed validation. The call did not run. */
  | { type: "input_error"; tool: ToolUseBlock; message: string }
  /** The built-in `Mode` tool ran. `label` names the active mode. */
  | { type: "mode"; tool: ToolUseBlock; label: string }
  /** The call starts to run. `pluginTool` is true for a plugin tool. */
  | { type: "started"; tool: ToolUseBlock; pluginTool: boolean }
  /** A plugin tool handler returned. */
  | { type: "plugin_result"; tool: ToolUseBlock; view: PluginToolView }
  /** One live output chunk of a streaming tool (Bash). Not awaited. */
  | { type: "output"; tool: ToolUseBlock; chunk: string }
  /** A built-in tool returned, before the post-processing steps. */
  | {
      type: "executed"
      tool: ToolUseBlock
      isError: boolean | undefined
      truncInfo?: TruncationInfo
    }
  /** The call is complete. */
  | { type: "outcome"; tool: ToolUseBlock; outcome: ToolViewOutcome }

/**
 * Receives {@link ToolViewEvent}s. The round awaits each event except
 * `output`, so a host can keep its rows in order. A throw or a rejection
 * is ignored: the view can never break the tool round.
 */
export interface ToolViewPort {
  onToolEvent(event: ToolViewEvent): void | Promise<void>
}
