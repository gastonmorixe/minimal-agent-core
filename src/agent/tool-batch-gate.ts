/**
 * `tool.didBatch` gate shared by Agent and AgentCore loops: the halt
 * decision and the listener context for the next request.
 *
 * @module agent/tool-batch-gate
 */

import type { LifecycleDeniedError } from "../errors/lifecycle.ts"
import type { ContentBlock, ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import { wrapHookContext } from "../sdk/hook-context.ts"
import { deniedError, isDenied, type LifecyclePort } from "../sdk/lifecycle.ts"

export type ToolBatchGateResult =
  | { halted: false; context: ContentBlock[] }
  | { halted: true; reason: string; error: LifecycleDeniedError }

/** The facts of one finished tool round for {@link checkToolDidBatch}. */
export interface ToolBatchRound {
  readonly toolBlocks: ToolUseBlock[]
  readonly toolResults: ToolResultBlock[]
  /** The 1-based round index in the current run (see `ToolDidBatchPayload.round`). */
  readonly round: number
  /** The turn signal. The listeners get it in `ctx.abort`. */
  readonly signal?: AbortSignal
}

/**
 * After a tool batch (all tool calls of one round), consult `lifecycle.afterToolBatch`.
 * On deny, returns `{halted:true, reason, error}` so the agentic loop can
 * stop before the next model call. The deny `action` decides: a deny with
 * no reason halts with reason "". `error` is the typed deny for the host.
 * On allow, `context` holds one text block (one `<ma::agent::policy>` line
 * per entry) of the listener `additionalContext`, or no block. The loop
 * adds it to the user message of the next request.
 */
export async function checkToolDidBatch(
  lifecycle: LifecyclePort,
  batch: ToolBatchRound,
): Promise<ToolBatchGateResult> {
  if (!lifecycle.afterToolBatch) return { halted: false, context: [] }
  const { toolBlocks, toolResults, round, signal } = batch
  try {
    const batchDecision = await lifecycle.afterToolBatch(
      {
        results: toolResults.map((r, i) => ({
          tool: toolBlocks[i]?.name ?? "unknown",
          toolUseId: r.tool_use_id,
          ok: !r.is_error,
        })),
        round,
      },
      signal,
    )
    if (!isDenied(batchDecision)) {
      const text = wrapHookContext(batchDecision.additionalContext)
      return { halted: false, context: text ? [{ type: "text", text }] : [] }
    }
    const error = deniedError("tool.didBatch", batchDecision)
    return { halted: true, reason: error.reason ?? "", error }
  } catch {
    return { halted: false, context: [] }
  }
}
