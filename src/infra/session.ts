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
 * Session IDs, request IDs, model names, and API-version markers are
 * always shown. Pattern-based so PROVIDER-specific header spellings
 * (any vendor's `x-<vendor>-session-id` / `<vendor>-version`) match
 * without core naming a provider.
 */
const PUBLIC_METADATA_RE = /(session[-_]?id|request[-_]?id|model|-version$)/i

export function isPublicMetadata(key: string): boolean {
  return PUBLIC_METADATA_RE.test(key)
}
