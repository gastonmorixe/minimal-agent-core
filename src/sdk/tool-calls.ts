/**
 * The tool step of `AgentCore.run` (stop-table rows 2 and 7): run each
 * tool call of one model response through the {@link ToolExecutor} port,
 * persist its result, and emit its events (spec S19).
 *
 * Per call, in order: `tool_call`, a `running_tool` `status`, then after the
 * tool ran, `tool_output` (only for a sink that asked for it) and
 * `tool_result` with the input and output summaries and the duration.
 *
 * @module sdk/tool-calls
 */

import type { ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"

import type { AgentEvent } from "./events.ts"
import type { SessionPersistence, ToolExecutor } from "./ports.ts"
import {
  summarizeToolInput,
  summarizeToolOutput,
  toolCallEvent,
  toolOutputEvent,
} from "./tool-facts.ts"

/** What the tool step needs from the core. */
export interface ToolCallHost {
  executor: ToolExecutor
  persistence: SessionPersistence | null
  emit(event: AgentEvent): void
  /** Whether the sink asked for `tool_output`. */
  wantsToolOutput: boolean
  /** Clock for `durationMs`, in ms. */
  now(): number
}

/** Run the tool calls in order and return their results for the next user message. */
export async function runToolCalls(
  host: ToolCallHost,
  toolBlocks: readonly ToolUseBlock[],
  signal: AbortSignal | undefined,
): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = []
  for (const tool of toolBlocks) {
    const inputSummary = summarizeToolInput(tool.input)
    host.emit(toolCallEvent(tool, inputSummary))
    host.emit({ type: "status", phase: "running_tool", toolName: tool.name })
    const startedAt = host.now()
    const result = await host.executor.execute(tool, signal)
    const durationMs = Math.max(0, host.now() - startedAt)
    const toolResult: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: tool.id,
      content: result.content,
      is_error: result.isError,
    }
    results.push(toolResult)
    host.persistence?.appendToolResult(toolResult)
    if (host.wantsToolOutput) host.emit(toolOutputEvent(tool, result.content))
    // The tool result joins back to its item_started on the SAME id (the
    // tool_use block id), per the frozen correlation contract.
    host.emit({
      type: "tool_result",
      id: tool.id,
      name: tool.name,
      isError: result.isError,
      inputSummary,
      outputSummary: summarizeToolOutput(result.content),
      durationMs,
    })
  }
  return results
}
