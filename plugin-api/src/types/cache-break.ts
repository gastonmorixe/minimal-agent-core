/**
 * `cache.didBreak`: one event for each turn where the prompt cache broke.
 *
 * A break is a fact, not a judgement: the previous turn of the same history
 * (session, model, endpoint) left a cached prefix, and this turn did not read
 * it, so the server wrote those tokens again. The cache plugin
 * (`ma-cache-plugin`) sends this event for EVERY break, whatever the cause,
 * with no once-per-code or streak throttle. The diagnostic log is separate,
 * and a frontend must not use the log severity to decide if a break is shown.
 *
 * The cause is a field of the fact. It is decided after the full prefix
 * check, so an idle gap never hides a client change (`idle` says that the gap
 * was above the TTL, also for `prefix_changed`).
 *
 * Wire format: treat as stable. Add only optional fields. A breaking change
 * bumps `v`.
 *
 * @module plugin-api/types/cache-break
 */

/** The bus channel name. */
export const CACHE_DID_BREAK = "cache.didBreak" as const

/**
 * Why the cache broke.
 *
 * - `ttl_expired`: a read of 0, the gap was above the TTL, and the prefix is
 *   unchanged (or one side has no fingerprint, so a change cannot be
 *   shown). Expected.
 * - `prefix_changed`: the client changed the prefix (see `changed`).
 * - `thinking_lookback`: the thinking removal of the previous latest
 *   assistant message, and no older entry was in reach. The detector treats
 *   that removal as expected; whether the client should remove it at all is
 *   still open, so these breaks are `actionable`.
 * - `thinking_older_entry`: the same removal, and the read stays on an older entry.
 * - `server_miss`: the prefix is unchanged and inside the TTL. Likely server-side.
 * - `unknown`: the cause cannot be decided. For example: no fingerprint on
 *   one side; a partial miss with an unchanged prefix that no client cause
 *   tells; a request with no cache markers after a warm turn; or a turn that
 *   neither read nor wrote the cache after a warm turn.
 */
export type CacheBreakCause =
  | "ttl_expired"
  | "prefix_changed"
  | "thinking_lookback"
  | "thinking_older_entry"
  | "server_miss"
  | "unknown"

/**
 * The changed part of the prefix, for `prefix_changed`. `tools_system`: the
 * tools and the system prompt both changed. `shorter`: a message was removed.
 */
export type CacheBreakChanged =
  | "tools"
  | "system"
  | "tools_system"
  | "options"
  | "message"
  | "thinking"
  | "shorter"

/** Payload of {@link CACHE_DID_BREAK}. */
export interface CacheBreakPayload {
  /** Payload version. */
  v: 1
  /** Session id from the request header, or "" when the request had none. */
  sessionId: string
  /** Model id of the request. */
  model: string
  /** Endpoint origin, for example `https://api.anthropic.com`. */
  origin: string
  /** Turn number in this history (counts every request, from 1). */
  turn: number
  /** The previous turn of this history. */
  prevTurn: number
  /**
   * The cached prefix the previous turn left: its read + write tokens. This
   * is the most this turn could read if nothing changed.
   */
  expectedRead: number
  /** Tokens this turn read from the cache. */
  read: number
  /** Tokens this turn wrote to the cache. */
  written: number
  /**
   * Tokens of the previous prefix that were not read: `expectedRead - read`,
   * at least 0. The cost of the break, written again.
   */
  lost: number
  /** Seconds between the previous response end and this request start. */
  gapSec?: number
  /** The longest marker TTL of this request, in seconds. */
  ttlSec: number
  /** True when `gapSec` is above `ttlSec`. Set for every cause. */
  idle: boolean
  cause: CacheBreakCause
  /** For `prefix_changed`: the part that changed. */
  changed?: CacheBreakChanged
  /** For `message`, `thinking`, and the thinking causes: the message index. */
  changedIndex?: number
  /** The server's own reason (Anthropic `cache_miss_reason`), a hint. */
  serverReason?: string
  /** The server-reported miss size. Not the cost; `lost` is. */
  serverMissedTokens?: number
  /** The provider request id, when the host gave it. */
  requestId?: string
  /** Breaks in a row in this history, this one included. */
  streak: number
  /** Tokens lost since the streak started, this one included. */
  streakLost: number
  /**
   * True when someone can act on it: a client change (fix the client) or a
   * likely server miss (report it with `requestId`). False for `ttl_expired`.
   * A frontend can style by it. It must not hide a break by it.
   */
  actionable: boolean
  /** One-line human text, without ANSI. */
  message: string
  /** Epoch ms of this response end. */
  at: number
}
