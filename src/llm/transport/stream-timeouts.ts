/**
 * Stream watchdog limits, with env overrides.
 *
 * Precedence for each limit: an explicit `SendOptions` value, then env, then
 * the default below.
 *
 * - **Silent-block idle** (thinking / tool-input block open): 300 s. It drops
 *   to 90 s after the attempt received a canonical `ping` event WHILE a silent
 *   block was open. Such a ping proves a periodic keepalive (the Anthropic
 *   Messages codec maps `event: ping`, sent about every 30 s, and the
 *   Responses codec maps `keepalive`). A ping outside a silent block proves
 *   nothing: the OpenAI-Chat codec maps a role-only first chunk to a `ping`.
 *   Core names no wire: the architecture ratchet bans provider names and
 *   surface ids in core code, so the fact is the codec's own `ping` event.
 * - **Pre-stream** (attempt start → first body byte), two sub-phases. Both
 *   budgets count from the attempt start:
 *   - `pre-headers`: 60 s for a remote endpoint, 120 s for a local URL host
 *     (loopback, private or link-local address, or a LAN name). The budget
 *     starts at the remote value; the request URL sets it before the wire
 *     call. Each pre-stream retry doubles this budget, up to 240 s
 *     (60 → 120 → 240 s), so a slow upload or prefill that repeats can still
 *     succeed (see `pre-stream-streak.ts` for the retry count).
 *   - `headers-wait-body`: 120 s (at least the pre-headers budget). The
 *     server accepted the request; the wait is now prefill, not a dead link.
 * - **Mid-stream idle**: 30 s (unchanged), env-overridable.
 *
 * An explicit `SendOptions.responseHeadersTimeoutMs` (wrap-up, tests) is
 * fixed: it ignores the URL, the sub-phase and the retry count. An env
 * value replaces the 60 s / 120 s base, and it grows with retries the same way.
 *
 * Env (positive integers, ms): {@link STREAM_IDLE_TIMEOUT_ENV},
 * {@link SILENT_BLOCK_IDLE_TIMEOUT_ENV}, {@link RESPONSE_HEADERS_TIMEOUT_ENV}.
 * A bad value is ignored, and a value under the floor is raised to the
 * floor, with one diagnostic for each session, key and value.
 *
 * @module llm/transport/stream-timeouts
 */

import { isIP } from "node:net"

import type { Diagnostics } from "../../diagnostics/hub.ts"

import {
  DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS,
  DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from "./watchdog.ts"

export const STREAM_IDLE_TIMEOUT_ENV = "MINIMAL_AGENT_STREAM_IDLE_TIMEOUT_MS"
export const SILENT_BLOCK_IDLE_TIMEOUT_ENV = "MINIMAL_AGENT_SILENT_BLOCK_IDLE_TIMEOUT_MS"
export const RESPONSE_HEADERS_TIMEOUT_ENV = "MINIMAL_AGENT_RESPONSE_HEADERS_TIMEOUT_MS"

/** Silent-block idle budget after a `ping` inside an open silent block. */
export const KEEPALIVE_SILENT_BLOCK_IDLE_TIMEOUT_MS = 90_000
/** Pre-headers budget for a remote endpoint (first attempt). */
export const REMOTE_RESPONSE_HEADERS_TIMEOUT_MS = 60_000
/** Pre-headers budget for a local endpoint (the old global default). */
export const LOCAL_RESPONSE_HEADERS_TIMEOUT_MS = DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS
/** Pre-stream budget after the headers arrived (the wait is prefill). */
export const HEADERS_WAIT_BODY_TIMEOUT_MS = 120_000
/** Upper bound of the pre-headers budget as it doubles for each retry. */
export const MAX_RESPONSE_HEADERS_TIMEOUT_MS = 240_000
/** Lowest accepted env value for the idle and silent-block limits. */
export const MIN_IDLE_TIMEOUT_ENV_MS = 1000
/** Lowest accepted env value for the pre-stream limit. */
export const MIN_RESPONSE_HEADERS_TIMEOUT_ENV_MS = 5000

/**
 * Session id, env key and value that already got a diagnostic. The key has
 * the session id, so in a process with many sessions each session log gets
 * the warn one time.
 */
const reportedBadEnv = new Set<string>()

/** Test seam: forget which bad env values were reported. */
export function resetStreamTimeoutEnvReports(): void {
  reportedBadEnv.clear()
}

/** Parse a positive-integer ms env value. `undefined` when absent or bad. */
export function parseTimeoutEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return undefined
  const n = Number(raw.trim())
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined
}

function reportOnce(
  diagnostics: Diagnostics | undefined,
  key: string,
  raw: string,
  message: string,
): void {
  const id = `${diagnostics?.sessionId ?? ""}\0${key}=${raw}`
  if (reportedBadEnv.has(id)) return
  reportedBadEnv.add(id)
  diagnostics?.warn("transport.stream-timeouts", message, { key, value: raw })
}

/** Read one env limit: `undefined` when absent or bad; raised to `floorMs`. */
function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  floorMs: number,
  diagnostics: Diagnostics | undefined,
): number | undefined {
  const raw = env[key]
  if (raw === undefined || raw === "") return undefined
  const value = parseTimeoutEnv(raw)
  if (value === undefined) {
    const msg = `ignored ${key}=${JSON.stringify(raw)}: not a positive integer (ms)`
    reportOnce(diagnostics, key, raw, msg)
    return undefined
  }
  if (value < floorMs) {
    const msg = `${key}=${JSON.stringify(raw)} is below the floor: raised to ${floorMs} ms`
    reportOnce(diagnostics, key, raw, msg)
    return floorMs
  }
  return value
}

/** True for loopback, unspecified, private, link-local and CGNAT IPv4. */
function isLocalIPv4(ip: string): boolean {
  const [a = -1, b = -1] = ip.split(".").map((p) => Number(p))
  return (
    a === 127 || // 127.0.0.0/8 loopback
    ip === "0.0.0.0" ||
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 CGNAT (Tailscale)
  )
}

/** True for loopback, unspecified, ULA, link-local and IPv4-mapped local IPv6. */
function isLocalIPv6(ip: string): boolean {
  if (ip === "::1" || ip === "::") return true
  // IPv4-mapped: dotted (`::ffff:127.0.0.1`) or hex (`::ffff:7f00:1`, the URL form).
  const mapped = /^::ffff:(.+)$/.exec(ip)?.[1]
  if (mapped !== undefined) {
    if (isIP(mapped) === 4) return isLocalIPv4(mapped)
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped)
    if (!hex) return false
    const hi = Number.parseInt(hex[1] ?? "0", 16)
    const lo = Number.parseInt(hex[2] ?? "0", 16)
    return isLocalIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  const first = ip.startsWith("::") ? 0 : Number.parseInt(ip.split(":")[0] ?? "", 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 // fc00::/7, fe80::/10
}

/** LAN-only name suffixes (a trailing dot is removed first). */
const LOCAL_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"]

/**
 * True when `host` (a URL hostname) is the local machine or on the local
 * network: a loopback, unspecified, private, link-local or CGNAT address, a
 * `localhost` name, a LAN suffix (`.local`, `.lan`, `.internal`,
 * `.home.arpa`), or a single-label name (no dot). A wrong "local" costs only
 * the longer 120 s wait.
 */
export function isLocalHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (h === "") return false
  const family = isIP(h)
  if (family === 4) return isLocalIPv4(h)
  if (family === 6) return isLocalIPv6(h)
  if (h === "localhost") return true
  if (LOCAL_NAME_SUFFIXES.some((s) => h.endsWith(s))) return true
  return !h.includes(".")
}

/** Local-endpoint decision from the request URL host (`false` when unknown or bad). */
export function isLocalEndpoint(url: string | undefined): boolean {
  if (url === undefined) return false
  try {
    return isLocalHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/** `base * 2^retries`, at most {@link MAX_RESPONSE_HEADERS_TIMEOUT_MS} (never below `base`). */
export function grownPreStreamBudget(base: number, retries: number): number {
  const n = Math.max(0, Math.min(Math.floor(retries), 16))
  return Math.max(base, Math.min(base * 2 ** n, MAX_RESPONSE_HEADERS_TIMEOUT_MS))
}

export interface StreamTimeoutInput {
  /** Explicit `SendOptions` values. A defined value always wins. */
  explicit: { streamIdleTimeoutMs?: number; responseHeadersTimeoutMs?: number }
  /** Process env (injected for tests). */
  env: Readonly<Record<string, string | undefined>>
  /** Where a bad env value is reported. */
  diagnostics?: Diagnostics
}

/** What the pre-stream budget depends on. */
export interface PreStreamFact {
  /** Request URL (`undefined` = not known yet: the remote value). */
  url?: string
  /** Pre-stream retries before this attempt (0 on the first attempt). */
  retries?: number
}

export interface ResolvedStreamTimeouts {
  streamIdleTimeoutMs: number
  /** Silent-block budget while no in-block `ping` was seen. */
  silentBlockIdleTimeoutMs: number
  /** Silent-block budget after a `ping` inside an open silent block. */
  keepaliveSilentBlockIdleTimeoutMs: number
  /** Pre-headers budget, from the attempt start. */
  responseHeadersTimeoutMs: (fact?: PreStreamFact) => number
  /** Pre-stream budget once the headers arrived, from the attempt start. */
  headersWaitBodyTimeoutMs: (fact?: PreStreamFact) => number
}

/** Resolve the watchdog limits for one send. */
export function resolveStreamTimeouts(input: StreamTimeoutInput): ResolvedStreamTimeouts {
  const { explicit, env, diagnostics } = input
  const envIdle = readEnv(env, STREAM_IDLE_TIMEOUT_ENV, MIN_IDLE_TIMEOUT_ENV_MS, diagnostics)
  const envSilent = readEnv(
    env,
    SILENT_BLOCK_IDLE_TIMEOUT_ENV,
    MIN_IDLE_TIMEOUT_ENV_MS,
    diagnostics,
  )
  const envHeaders = readEnv(
    env,
    RESPONSE_HEADERS_TIMEOUT_ENV,
    MIN_RESPONSE_HEADERS_TIMEOUT_ENV_MS,
    diagnostics,
  )

  const streamIdleTimeoutMs =
    explicit.streamIdleTimeoutMs ?? envIdle ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  // An env value replaces both silent-block budgets.
  const silentBlockIdleTimeoutMs = envSilent ?? DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS
  const keepaliveSilentBlockIdleTimeoutMs = envSilent ?? KEEPALIVE_SILENT_BLOCK_IDLE_TIMEOUT_MS
  const fixed = explicit.responseHeadersTimeoutMs

  const responseHeadersTimeoutMs = (fact: PreStreamFact = {}): number => {
    if (fixed !== undefined) return fixed
    const local = isLocalEndpoint(fact.url)
    const base =
      envHeaders ?? (local ? LOCAL_RESPONSE_HEADERS_TIMEOUT_MS : REMOTE_RESPONSE_HEADERS_TIMEOUT_MS)
    return grownPreStreamBudget(base, fact.retries ?? 0)
  }
  const headersWaitBodyTimeoutMs = (fact: PreStreamFact = {}): number =>
    fixed ?? Math.max(HEADERS_WAIT_BODY_TIMEOUT_MS, responseHeadersTimeoutMs(fact))

  return {
    streamIdleTimeoutMs,
    silentBlockIdleTimeoutMs,
    keepaliveSilentBlockIdleTimeoutMs,
    responseHeadersTimeoutMs,
    headersWaitBodyTimeoutMs,
  }
}
