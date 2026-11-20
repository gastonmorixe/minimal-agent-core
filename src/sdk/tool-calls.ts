/**
 * The tool step of `AgentCore.run` (stop-table rows 2 and 7): run each
 * tool call of one model response through the {@link ToolExecutor} port,
 * persist its result, and emit its events (spec S19).
 *
 * Per call, in order: `tool_call`, a `running_tool` `status`, then after the
 * tool ran, `tool_output` (only for a sink that asked for it) and
 * `tool_result` with the input and output summaries and the duration.
 *
 * A batch with a wave of concurrency-safe calls goes to the wave scheduler
 * (`tool-call-waves.ts`). It keeps the same events and records in call
 * order; only the runs of a wave overlap.
 *
 * @module sdk/tool-calls
 */

import { normalizeMaxConcurrentToolCalls } from "../config/concurrency-cap.ts"
import { type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"
import type { ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"

import type { AgentEvent } from "./events.ts"
import type {
  SessionPersistence,
  ToolConcurrencyPolicy,
  ToolExecContext,
  ToolExecResult,
  ToolExecutor,
} from "./ports.ts"
import {
  summarizeToolInput,
  summarizeToolOutput,
  toolCallEvent,
  toolOutputEvent,
} from "./tool-facts.ts"
import {
  internalOutcomeOf,
  outcomeTextOf,
  TOOL_OUTCOME_RECORD_DROPPED,
  validatePersistedToolOutcome,
  withBlockOutcome,
} from "./tool-outcome-record.ts"

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
  /** Sink of the outcome record diagnostics. Omitted: the process hub (no session id). */
  diagnostics?: Diagnostics
  /**
   * Concurrency cap of a wave (`AgentCoreConfig.maxConcurrentToolCalls`).
   * Omitted or 1: the serial path.
   */
  maxConcurrentToolCalls?: number
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

/**
 * Run the tool calls of one round and return their results for the next
 * user message, in call order (`results[i]` pairs `toolBlocks[i]`).
 *
 * With a concurrency cap of 1, or when the batch has no two consecutive
 * concurrency-safe calls (by the tool flag), the calls run one after another
 * on the serial path, as before (SPEC X1). Else the wave scheduler
 * (`tool-call-waves.ts`) runs each wave of concurrency-safe calls at the
 * same time, up to the cap. The saved records and the SDK events stay in
 * call order on both paths.
 */
export async function runToolCalls(
  host: ToolCallHost,
  toolBlocks: readonly ToolUseBlock[],
  signal: AbortSignal | undefined,
): Promise<ToolResultBlock[]> {
  // Omitted or invalid (not an integer of 1 or more): 1, the serial path.
  const cap = normalizeMaxConcurrentToolCalls(host.maxConcurrentToolCalls) ?? 1
  const policy = host.executor.concurrency
  if (cap > 1 && policy && hasWave(policy, toolBlocks)) {
    const { runToolCallsInWaves } = await import("./tool-call-waves.ts")
    return runToolCallsInWaves(host, toolBlocks, signal, { cap, policy })
  }
  return runToolCallsSerially(host, toolBlocks, signal)
}

/**
 * The tool flag of `toolName` (before admission). A throw of the policy
 * gives false: the call is a serial call.
 */
export function toolFlagOf(policy: ToolConcurrencyPolicy, toolName: string): boolean {
  try {
    return policy.toolFlag(toolName).flag === true
  } catch {
    return false
  }
}

/** True when two consecutive calls of the batch have the tool flag (a wave). */
function hasWave(policy: ToolConcurrencyPolicy, toolBlocks: readonly ToolUseBlock[]): boolean {
  let previous = false
  for (const tool of toolBlocks) {
    const flag = toolFlagOf(policy, tool.name)
    if (flag && previous) return true
    previous = flag
  }
  return false
}

/** The serial path: run the tool calls one after another, in order. */
async function runToolCallsSerially(
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
    results.push(deliverToolResult(host, tool, inputSummary, result, durationMs))
  }
  return results
}

/**
 * Make the result block of one tool call that ran, save it, and emit its
 * `tool_output` (when the sink asked for it) and `tool_result` events. The
 * wave scheduler calls it in call order.
 */
export function deliverToolResult(
  host: ToolCallHost,
  tool: ToolUseBlock,
  inputSummary: string,
  result: ToolExecResult,
  durationMs: number,
): ToolResultBlock {
  // Spec v6.1 D8 rule 8: only core's own executor gives an outcome, through
  // the internal channel. An `outcome` key from a host executor is not read.
  const outcome = checkedInternalOutcome(host, tool, result)
  const toolResult: ToolResultBlock = {
    type: "tool_result",
    tool_use_id: tool.id,
    content: result.content,
    is_error: result.isError,
    // Spec v6.1 D1 item 5: keep the mark in the live history. No key when absent.
    ...(result.sideband ? { sideband: result.sideband } : {}),
    // Spec v6.1 D8 rule 8: the live block keeps the outcome. No key when absent.
    ...(outcome ? { outcome } : {}),
  }
  // Review W2 M2: core's own `SessionStorePersistence` reads the record of
  // this block through a private channel (not through the `outcome` key).
  withBlockOutcome(toolResult, outcome)
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
    // Metadata for the host. The keys are absent (not undefined) when empty.
    ...(outcome?.data !== undefined ? { data: outcome.data } : {}),
    ...(outcome !== undefined && outcome.annotations.length > 0
      ? {
          annotations: outcome.annotations.map(({ kind, attrs }) =>
            attrs === undefined ? { kind } : { kind, attrs },
          ),
        }
      : {}),
    durationMs,
  })
  return toolResult
}

/**
 * The internal outcome of `result`, checked again against the content that
 * `runToolCalls` reads now (review W2 M3). A wrapper of core's executor can
 * change `result.content` in place after core registered the record. Then the
 * record offsets can refer to a different text. This uses the restore check,
 * so the live block and the restored block hold the same value. On a
 * mismatch: no outcome, and ONE {@link TOOL_OUTCOME_RECORD_DROPPED}
 * `{ tool, reason: "content-changed" }`.
 */
function checkedInternalOutcome(
  host: ToolCallHost,
  tool: ToolUseBlock,
  result: { content: unknown },
): ToolResultBlock["outcome"] {
  const registered = internalOutcomeOf(result)
  if (registered === undefined) return undefined
  const checked = validatePersistedToolOutcome(registered, outcomeTextOf(result.content))
  if (checked !== undefined) return checked
  const diagnostics = host.diagnostics ?? processDiagnostics()
  diagnostics.warn(TOOL_OUTCOME_RECORD_DROPPED, "", { tool: tool.name, reason: "content-changed" })
  return undefined
}

/** Text of the tool result for a tool call that did not start because of an abort. */
const TOOL_ABORTED_RESULT = "tool aborted by user"

/** Record an "aborted" result for a tool call that did not start. */
export function skipAbortedTool(
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
