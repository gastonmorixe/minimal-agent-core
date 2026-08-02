/**
 * `tool.didBatch` halt gate shared by Agent and AgentCore loops.
 *
 * @module agent/tool-batch-gate
 */

import type { ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import { isDenied, type LifecyclePort } from "../sdk/lifecycle.ts"

export type ToolBatchGateResult = { halted: false } | { halted: true; reason: string }

/**
 * After a parallel tool batch, consult `lifecycle.afterToolBatch`.
 * On deny, returns `{halted:true, reason}` so the agentic loop can stop
 * before the next model call.
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
    const reason =
      batchDecision.action === "deny" || batchDecision.action === "ask"
        ? batchDecision.reason
        : "Agentic loop stopped by tool.didBatch hook."
    return { halted: true, reason }
  } catch {
    return { halted: false }
  }
}
