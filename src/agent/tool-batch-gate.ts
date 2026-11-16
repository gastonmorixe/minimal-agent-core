/**
 * `tool.didBatch` halt gate shared by Agent and AgentCore loops.
 *
 * @module agent/tool-batch-gate
 */

import type { LifecycleDeniedError } from "../errors/lifecycle.ts"
import type { ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import { deniedError, isDenied, type LifecyclePort } from "../sdk/lifecycle.ts"

export type ToolBatchGateResult =
  | { halted: false }
  | { halted: true; reason: string; error: LifecycleDeniedError }

/**
 * After a parallel tool batch, consult `lifecycle.afterToolBatch`.
 * On deny, returns `{halted:true, reason, error}` so the agentic loop can
 * stop before the next model call. The deny `action` decides: a deny with
 * no reason halts with reason "". `error` is the typed deny for the host.
 */
export async function checkToolDidBatch(
  lifecycle: LifecyclePort,
  toolBlocks: ToolUseBlock[],
  toolResults: ToolResultBlock[],
): Promise<ToolBatchGateResult> {
  if (!lifecycle.afterToolBatch) return { halted: false }
  try {
    const batchDecision = await lifecycle.afterToolBatch({
      results: toolResults.map((r, i) => ({
        tool: toolBlocks[i]?.name ?? "unknown",
        toolUseId: r.tool_use_id,
        ok: !r.is_error,
      })),
    })
    if (!isDenied(batchDecision)) return { halted: false }
    const error = deniedError("tool.didBatch", batchDecision)
    return { halted: true, reason: error.reason ?? "", error }
  } catch {
    return { halted: false }
  }
}
