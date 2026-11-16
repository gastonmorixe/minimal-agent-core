/**
 * Host facts for the core loop hook payloads (`AgentCoreConfig.sessionFacts`):
 * the session id, the sub-agent identity, and the working directory. The
 * host side reads them here, so the SDK never reads the session module or
 * the process.
 *
 * @module runtime/host-session-facts
 */

import type { SessionFacts } from "../sdk/ports.ts"
import { peekSessionId } from "../session/session-id.ts"

/**
 * The sub-agent identity. Sub-agent workers stamp
 * `MINIMAL_AGENT_SUBAGENT_ID` / `_LEAD` (spawn-plan). A field is absent
 * when it is not set.
 */
export function subagentIdentity(): { agentId?: string; leadSid?: string } {
  const agentId = process.env.MINIMAL_AGENT_SUBAGENT_ID?.trim() || undefined
  const leadSid = process.env.MINIMAL_AGENT_SUBAGENT_LEAD?.trim() || undefined
  return { ...(agentId ? { agentId } : {}), ...(leadSid ? { leadSid } : {}) }
}

/** Read the host facts. A field is absent when it is not known. Never throws. */
export function hostSessionFacts(): SessionFacts {
  const facts: SessionFacts = { ...subagentIdentity() }
  // Peek, never mint: minting here would make a later setSessionId() throw.
  const sid = peekSessionId()
  if (sid) facts.sid = sid
  try {
    facts.cwd = process.cwd()
  } catch {
    /* no cwd: leave it out */
  }
  return facts
}
