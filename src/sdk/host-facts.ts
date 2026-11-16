/**
 * Read the host facts ({@link AgentCoreConfig.sessionFacts}) for the core
 * loop hook payloads. The SDK never reads the session module or the process
 * for them: the host gives the function, and a missing or throwing function
 * gives no facts.
 *
 * @module sdk/host-facts
 */

import type { SessionFacts, ToolExecContext } from "./ports.ts"

/** The identity fields of a `turn.willStop` payload. */
export type IdentityFacts = Pick<SessionFacts, "sid" | "agentId" | "leadSid">

/** Call `read` and keep only the non-empty fields. A throw gives `{}`. */
export function readHostFacts(read: (() => SessionFacts) | undefined): SessionFacts {
  let raw: SessionFacts | undefined
  try {
    raw = read?.()
  } catch {
    return {}
  }
  const facts: SessionFacts = {}
  if (raw?.sid) facts.sid = raw.sid
  if (raw?.agentId) facts.agentId = raw.agentId
  if (raw?.leadSid) facts.leadSid = raw.leadSid
  if (raw?.cwd) facts.cwd = raw.cwd
  return facts
}

/** The identity fields only (no `cwd`), for the `turn.willStop` payload. */
export function identityFacts(read: (() => SessionFacts) | undefined): IdentityFacts {
  const { cwd: _cwd, ...identity } = readHostFacts(read)
  return identity
}

/**
 * Session facts for a compaction (`compactWithLifecycle` input): sid, cwd,
 * the active agent mode, and the sink for the `session.willStart` context.
 */
export function compactSessionFacts(
  read: (() => SessionFacts) | undefined,
  agentMode: string | null | undefined,
  onSessionContext: (lines: string[]) => void,
): { sid?: string; agentMode?: string; cwd: string; onSessionContext: (l: string[]) => void } {
  const { sid, cwd } = readHostFacts(read)
  return {
    ...(sid ? { sid } : {}),
    ...(agentMode ? { agentMode } : {}),
    // TODO: AgentCore has no cwd field of its own. The compact
    // `session.willStart` payload uses the host `sessionFacts().cwd`, and
    // `""` when the host gives none. Pass a live host cwd port in.
    cwd: cwd ?? "",
    onSessionContext,
  }
}

/** The per-call tool facts: the host session id, when it is known. */
export function toolExecContext(read: (() => SessionFacts) | undefined): ToolExecContext {
  const { sid } = readHostFacts(read)
  return sid ? { sid } : {}
}
