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
import type { SessionPersistence, ToolExecContext, ToolExecutor } from "./ports.ts"
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
  /** Per-call facts for the executor (the session id). Omitted: none. */
  context?: () => ToolExecContext
}

/**
 * Persist a tool result that core made itself, with no tool run. It uses
 * {@link SessionPersistence.appendSyntheticToolResult} when the host has it,
 * else `appendToolResult`.
 */
export function persistSyntheticToolResult(
  persistence: SessionPersistence | null | undefined,
  result: ToolResultBlock,
): void {
  if (!persistence) return
  if (persistence.appendSyntheticToolResult) persistence.appendSyntheticToolResult(result)
  else persistence.appendToolResult(result)
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
    if (signal?.aborted === true) {
      // The turn was aborted: do not start this tool. Give it the same
      // "aborted" result that an aborted tool gives.
      results.push(skipAbortedTool(host, tool, inputSummary))
      continue
    }
    host.emit({ type: "status", phase: "running_tool", toolName: tool.name })
    const startedAt = host.now()
    const result = await host.executor.execute(tool, signal, host.context?.() ?? {})
    const durationMs = Math.max(0, host.now() - startedAt)
    const toolResult: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: tool.id,
      content: result.content,
      is_error: result.isError,
      // Spec v6.1 D1 item 5: keep the mark in the live history. No key when absent.
      ...(result.sideband ? { sideband: result.sideband } : {}),
      // Spec v6.1 D8 rule 8: the live block keeps the outcome. No key when absent.
      ...(result.outcome ? { outcome: result.outcome } : {}),
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

/** Text of the tool result for a tool call that did not start because of an abort. */
const TOOL_ABORTED_RESULT = "tool aborted by user"

/** Record an "aborted" result for a tool call that did not start. */
function skipAbortedTool(
  host: ToolCallHost,
  tool: ToolUseBlock,
  inputSummary: string,
): ToolResultBlock {
  const toolResult: ToolResultBlock = {
    type: "tool_result",
    tool_use_id: tool.id,
    content: TOOL_ABORTED_RESULT,
    is_error: true,
  }
  persistSyntheticToolResult(host.persistence, toolResult)
  host.emit({
    type: "tool_result",
    id: tool.id,
    name: tool.name,
    isError: true,
    inputSummary,
    outputSummary: summarizeToolOutput(TOOL_ABORTED_RESULT),
    durationMs: 0,
  })
  return toolResult
}
