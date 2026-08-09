import type { Message } from "../../../llm/messages.ts"
import {
  beginHistoryEdit,
  commitHistoryEdit,
  prepareHistoryEdit,
} from "../../../session/session-history-edit.ts"
import type { SessionsWriteApi } from "../capabilities.ts"

export interface HistoryEditCommitNotice {
  targetUserId: string
  backupSid: string
  droppedRecordCount: number
}

export interface HistoryEditCommitInput {
  targetUserId: string
  backupSid: string
}

export interface PreparedHistoryEditCommit extends HistoryEditCommitInput {
  modelMessages: Message[]
}

export interface SessionsWriteDeps {
  dir?: string
  activeSessionId: string
  beforeCommit?: (input: PreparedHistoryEditCommit) => Promise<void>
  onCommitted?: (notice: HistoryEditCommitNotice) => Promise<void>
  canCommit?: () => boolean
}

/** Host adapter for the narrow, transaction-only sessions:write capability. */
export function createSessionsWriteApi(deps: SessionsWriteDeps): SessionsWriteApi {
  return {
    async beginHistoryEdit(input) {
      return beginHistoryEdit({ ...input, sid: deps.activeSessionId }, deps)
    },
    async commitHistoryEdit(input) {
      // Refuse BEFORE the durable cut if no live-session reload coordinator is
      // registered. A disk-only success would leave stale AgentCore history.
      if (!deps.beforeCommit || !deps.onCommitted || !deps.canCommit?.()) {
        return {
          ok: false,
          code: "commit_handler_unavailable",
          message: "history edit cannot safely reload the active conversation",
        }
      }
      const prepared = prepareHistoryEdit({ ...input, sid: deps.activeSessionId }, deps)
      if (!prepared.ok) return prepared
      try {
        await deps.beforeCommit?.({ ...input, modelMessages: prepared.modelMessages })
      } catch (err) {
        return {
          ok: false,
          code: "commit_preflight_failed",
          message: err instanceof Error ? err.message : String(err),
        }
      }
      const committed = commitHistoryEdit({ ...input, sid: deps.activeSessionId }, deps)
      if (!committed.ok) return committed
      try {
        await deps.onCommitted({
          targetUserId: input.targetUserId,
          backupSid: input.backupSid,
          droppedRecordCount: committed.droppedRecordCount,
        })
      } catch (err) {
        return {
          ok: false,
          code: "commit_callback_failed",
          message: err instanceof Error ? err.message : String(err),
        }
      }
      return committed
    },
  }
}
