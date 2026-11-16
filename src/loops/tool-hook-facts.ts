/**
 * Session facts shared by the tool hook payloads (`tool.willInvoke`,
 * `tool.didInvoke`): the session id and the active agent mode id.
 *
 * @module loops/tool-hook-facts
 */

import type { ModeManager } from "../modes/modes.ts"

/** The optional `sid` / `agentMode` fields of a tool hook payload. */
export interface ToolHookFacts {
  sid?: string
  agentMode?: string
}

/**
 * Read the active mode id and keep the session id `sid` from the round
 * context (the core `sessionFacts`, so each session has its own id). A
 * field is absent when it is not known. A failure to read a fact never
 * breaks the tool round.
 */
export function toolHookFacts(
  modeManager: Pick<ModeManager, "activeId"> | null,
  sid?: string,
): ToolHookFacts {
  const facts: ToolHookFacts = {}
  if (sid) facts.sid = sid
  try {
    const agentMode = modeManager?.activeId()
    if (typeof agentMode === "string" && agentMode.length > 0) facts.agentMode = agentMode
  } catch {
    /* no mode: leave it out */
  }
  return facts
}
