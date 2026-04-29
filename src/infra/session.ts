// Session ID Fix — Agent-8
// Rule: NEVER redact session IDs. Make them human-readable.

import { randomUUID } from "node:crypto"

/**
 * Generate a human-readable session ID.
 * Format: ma-session-YYYYMMDD-HHMM-xxxx
 * Example: ma-session-20260413-1430-a7x2
 */
export function generateSessionId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, "")
  const time = now.toISOString().slice(11, 16).replace(":", "")
  const rand = randomUUID().slice(0, 4)
  return `ma-session-${date}-${time}-${rand}`
}

/**
 * Should this value be displayed without redaction?
 * Session IDs, request IDs, and model names are always shown.
 */
export function isPublicMetadata(key: string): boolean {
  const PUBLIC_KEYS = [
    "session-id",
    "session_id",
    "sessionId",
    "x-claude-code-session-id",
    "x-client-request-id",
    "model",
    "anthropic-version",
  ]
  return PUBLIC_KEYS.some((pk) => key.toLowerCase().includes(pk.toLowerCase()))
}
