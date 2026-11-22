/**
 * `hooks[]` manifest validation, split out of `manifest.ts` to keep that
 * file under the architecture's line ratchet (the same split as
 * `manifest-host-mode.ts`).
 *
 * @module plugins/manifest-hook-sub
 */

import {
  isObject,
  ManifestError,
  optionalHostOptIn,
  parseHandlerEntry,
  requireString,
} from "./manifest-helpers.ts"
import type { ManifestHookSubscription } from "./types.ts"

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/

/**
 * Validate a single `hooks[i]` entry.
 */
export function parseHookSub(
  raw: unknown,
  index: number,
  manifestPath: string,
  seenIds: Set<string>,
): ManifestHookSubscription {
  const at = `hooks[${index}]`
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("hook subscription must be an object")
  const obj = raw as Record<string, unknown>

  const id = requireString(obj, "id", err)
  if (!ID_RE.test(id)) err(`hook subscription id must match ${ID_RE}`)
  if (seenIds.has(id)) err(`duplicate hook subscription id: ${id}`)
  seenIds.add(id)

  const channel = requireString(obj, "channel", err)
  if (/\s/.test(channel)) {
    err(`channel must not contain whitespace (got: ${JSON.stringify(channel)})`)
  }

  const handler = parseHandlerEntry(obj.handler, at, manifestPath)

  let priority: number | undefined
  if (obj.priority != null) {
    if (typeof obj.priority !== "number" || !Number.isFinite(obj.priority)) {
      err(`priority must be a finite number if present (got: ${JSON.stringify(obj.priority)})`)
    }
    priority = obj.priority as number
  }

  let observeOnly: boolean | undefined
  if (obj.observeOnly != null) {
    if (typeof obj.observeOnly !== "boolean") err("observeOnly must be a boolean if present")
    observeOnly = obj.observeOnly as boolean
  }

  let timeoutMs: number | undefined
  if (obj.timeoutMs != null) {
    if (typeof obj.timeoutMs !== "number" || !Number.isFinite(obj.timeoutMs) || obj.timeoutMs < 0) {
      err(`timeoutMs must be a non-negative number (got: ${JSON.stringify(obj.timeoutMs)})`)
    }
    timeoutMs = obj.timeoutMs as number
  }

  let failClosed: boolean | undefined
  if (obj.failClosed != null) {
    if (typeof obj.failClosed !== "boolean") err("failClosed must be a boolean if present")
    failClosed = obj.failClosed as boolean
    if (failClosed && observeOnly) err("failClosed and observeOnly cannot both be true")
  }

  // `host: true` opts in to `ctx.host` (same rule as for events).
  const hostOptIn = optionalHostOptIn(obj, err)
  const keys = "id channel handler priority observeOnly timeoutMs failClosed host".split(" ")
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) err(`unknown hook subscription key: ${JSON.stringify(k)}`)
  }

  return {
    id,
    channel,
    handler,
    priority,
    observeOnly,
    timeoutMs,
    ...(failClosed !== undefined ? { failClosed } : {}),
    ...hostOptIn,
  }
}
