/**
 * Session-store boot warning chrome.
 *
 * Session persistence and liveness decisions belong to startup/session modules;
 * this file owns only the terminal rows for startup warnings.
 *
 * @module ui/chrome/session-store-boot
 */

import { c } from "../style/ansi.ts"

/** Render the warning shown when a persistence store cannot be opened. */
export function renderStoreUnavailableWarning(
  kind: "session" | "blob" | "file-tracking",
  reason: string,
): string[] {
  return [`  ${c.boldYellow("warn")} ${kind} store unavailable: ${reason}`]
}

/** Render the warning shown when resuming from a session that still appears live. */
export function renderLiveSessionWarning(input: {
  sid: string
  pid: number
  since: string
}): string[] {
  return [
    `  ${c.boldYellow("warn")} session ${input.sid} appears live ` +
      `(pid ${input.pid}, since ${input.since}); resuming anyway will ` +
      `fork the conversation`,
  ]
}

/** Render the warning shown when a resumed session's prompts/tools drifted. */
export function renderSessionDriftWarning(): string[] {
  return [
    `  ${c.boldYellow("warn")} system prompt or tool set changed since this session was saved — resuming anyway`,
  ]
}
