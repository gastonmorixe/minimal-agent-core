/**
 * On-disk request/response logger, writing five files per request
 * (req-meta.json, req-body.txt, res-meta.json, res-body.txt,
 * res-timeline.jsonl).
 *
 * `res-timeline.jsonl` has one JSON line per response event, with `t` in ms
 * since the request was recorded:
 *
 * - `{"t":0,"ev":"request","at":"<ISO>","id":n}` first, anchoring `t`;
 * - `{"t":…,"ev":"headers","status":200}` when the response headers arrive;
 * - `{"t":…,"ev":"chunk","bytes":n,"offset":o}` for every body chunk, where
 *   `offset` is the chunk's start byte in `res-body.txt` (so a reader can
 *   slice the body to see what each chunk carried);
 * - `{"t":…,"ev":"end","bytes":total}` when the body closes or errors.
 *
 * It answers "when did each byte arrive", which the body alone cannot: a
 * 30s silent thinking block and a hung connection look the same in
 * `res-body.txt` (research/2026-11-15-stream-stall-10404ddc).
 *
 * Disabled by default. Enable with `MINIMAL_AGENT_NET_DBG=1` or `"netDbg": true`
 * in `~/.minimal-agent/config.jsonc`. This module reads neither: the caller
 * resolves the level ({@link resolveNetDbgEnabled}) and passes it to the
 * observer (`createNetDebugObserver({ enabled })`). Logs go to
 * `<agent-home>/net-dbg/${epoch}-${human-date}/` (honoring
 * `MINIMAL_AGENT_HOME`), so captures from every project land in one
 * relocation-correct place instead of scattering across working
 * directories. Each call produces four files keyed by a per-process
 * sequence number.
 *
 * Designed to be called from {@link sendMessage} in client.ts. The response
 * body is tee'd so the caller still gets a readable stream for SSE parsing.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { resolveNetDbgDir } from "@minimal-agent/core/plugin-api/utils/agent-paths"

import { Severity } from "../bus/diagnostic-bus.ts"
import { type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"
import { emitTyped } from "../diagnostics/typed.ts"
import { currentSessionScope } from "../infra/session-scope.ts"
import { getSessionId } from "../session/session-id.ts"
import { assertSafeSessionId } from "../session/session-id-safety.ts"

/**
 * Decide whether on-disk logging is on. `CLI/env > config file > default`:
 * `MINIMAL_AGENT_NET_DBG=1` forces on, `=0` forces off, otherwise the
 * `netDbg` boolean from `~/.minimal-agent/config.jsonc` decides (default off).
 * Pure so it is unit-testable without touching the environment.
 */
export function resolveNetDbgEnabled(
  envValue: string | undefined,
  configValue: boolean | undefined,
): boolean {
  if (envValue === "1") return true
  if (envValue === "0") return false
  return configValue === true
}

let SEQ = 0
let SESSION_DIR: string | null = null
/** The folder of each scoped session (`infra/session-scope.ts`), by session id. */
const SCOPED_DIRS = new Map<string, string>()

/**
 * Format a Date's timezone as `±HHMM` (e.g. `-0400` for EDT, `+0530` for IST).
 * Replaces the previous abbreviation guess (which conflated EST and EDT).
 * Exported for testing and for any future caller that wants a stable format.
 */
export function formatTzOffset(d: Date): string {
  const offsetMin = d.getTimezoneOffset() // minutes WEST of UTC
  const sign = offsetMin <= 0 ? "+" : "-"
  const abs = Math.abs(offsetMin)
  const hh = String(Math.floor(abs / 60)).padStart(2, "0")
  const mm = String(abs % 60).padStart(2, "0")
  return `${sign}${hh}${mm}`
}

/**
 * Build the leaf folder name for a recording session.
 *
 * Shape: `<epoch-ms>-<DD>-<MON>-<YYYY>-<WEEKDAY>--<HH>h<MM>m<SS>s<±HHMM>-minimal-agent-<sid>`
 *
 * The leading epoch keeps directories sortable lexicographically by start
 * time; the human chunk is for skim-readability; the trailing `<sid>` lets
 * a recording be cross-referenced with the agent's session id (same UUID
 * `metadata.getSessionId()` returns and `~/.minimal-agent/sessions/<sid>.jsonl`
 * uses).
 *
 * Pure function — exported for testing and for any future caller that wants
 * the naming logic without the mkdir side-effect.
 */
export function formatSessionDirName(epoch: number, d: Date, sessionId: string): string {
  assertSafeSessionId(sessionId, "net-dbg dir")
  const pad = (n: number) => String(n).padStart(2, "0")
  const months = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ]
  const days = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
  const human =
    `${pad(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()}-${days[d.getDay()]}--` +
    `${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}s${formatTzOffset(d)}`
  return `${epoch}-${human}-minimal-agent-${sessionId}`
}

/**
 * Pure: the absolute leaf directory one recording session writes into,
 * `<agent-home>/net-dbg/<formatSessionDirName(...)>`. The base resolves
 * against the agent home ({@link resolveNetDbgDir}, honoring
 * `MINIMAL_AGENT_HOME`), NOT the cwd. Exported and env-injected so the
 * placement logic is testable without touching the filesystem or the real
 * environment.
 */
export function netDbgSessionDir(
  epoch: number,
  d: Date,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveNetDbgDir(env), formatSessionDirName(epoch, d, sessionId))
}

function ensureSessionDir(): string {
  // A process with many sessions: each scoped session records into its own
  // folder, named by its own id, not by the process id.
  const scopeSid = currentSessionScope()?.sid
  if (scopeSid !== undefined) {
    const known = SCOPED_DIRS.get(scopeSid)
    if (known && existsSync(known)) return known
    const scoped = netDbgSessionDir(Date.now(), new Date(), scopeSid)
    mkdirSync(scoped, { recursive: true })
    SCOPED_DIRS.set(scopeSid, scoped)
    return scoped
  }
  if (SESSION_DIR && existsSync(SESSION_DIR)) return SESSION_DIR

  const dir = netDbgSessionDir(Date.now(), new Date(), getSessionId())
  mkdirSync(dir, { recursive: true })
  SESSION_DIR = dir
  return dir
}

/**
 * Test-only: drop the cached session directory so the next `beginRequest`
 * re-resolves it against the current environment. Needed by tests that
 * relocate `MINIMAL_AGENT_HOME` into a temp dir — the cache is process-wide
 * and would otherwise pin the first resolution. Not part of the public API.
 */
export function _resetNetDbgSessionDirForTest(): void {
  SESSION_DIR = null
  SCOPED_DIRS.clear()
}

/**
 * The folder this process records into, or `null` before the first capture.
 * Inside a scoped run, the folder of that session.
 */
export function currentNetDbgSessionDir(): string | null {
  const scopeSid = currentSessionScope()?.sid
  if (scopeSid !== undefined) return SCOPED_DIRS.get(scopeSid) ?? null
  return SESSION_DIR
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "")
}

function pad3(n: number): string {
  return String(n).padStart(3, "0")
}

export interface NetDbgHandle {
  recordResponse(
    status: number,
    headers: Headers | Record<string, string>,
    transport?: object,
  ): void
  appendResponseChunk(chunk: Uint8Array | string): void
  finishResponse(): void
}

/**
 * Records a request to disk and returns a handle for streaming the response.
 * The caller decides whether logging is on: call this only when it is.
 *
 * The `opts` bag carries the request capture data: `url`, `method`,
 * `headers`, `body` (request body to write), `transportAttempted` (which
 * transport the client was *about to* use), and `requestId` (the client's
 * request id, for correlation).
 *
 * **Attempt vs. reality.** Everything written here happens BEFORE the
 * response exists, so the transport label is necessarily a *pre-flight
 * attempt*, not a statement about the wire. That is why the filename segment
 * is `<label>-attempt-` and the meta field is `transportAttempted`, never
 * `protocol` (IMPROVEMENTS.md item 2). A request attempted on `http2` that
 * actually completes over HTTP/1.1 via the ALPN policy must never look like an
 * HTTP/2 request. The authoritative answer lives on the res-meta's
 * `transport.protocol` / `transport.fallbackUsed`, written post-response.
 *
 * @returns Capture handle used to finish response logging.
 */
export function beginRequest(opts: {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  /** Pre-flight transport label. Preferred spelling. */
  transportAttempted?: string
  /** @deprecated Legacy alias of {@link transportAttempted}. */
  protocol?: string
  /** Client-side request id, so a record can be joined to other logs. */
  requestId?: string
}): NetDbgHandle {
  const dir = ensureSessionDir()

  const seq = ++SEQ
  const stamp = isoStamp()
  const attempted = opts.transportAttempted ?? opts.protocol ?? "unknown"
  // `-attempt-` in the filename makes the semantics legible in `ls` alone:
  // a request that ends up on HTTP/1.1 is not named `http2`.
  const prefix = `${stamp}-${attempted}-attempt-${pad3(seq)}`

  const reqMeta = {
    id: seq,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    timestamp: new Date().toISOString(),
    url: opts.url,
    method: opts.method,
    headers: redactHeaders(opts.headers),
    /** Pre-flight: which transport the client was about to use. Not the wire. */
    transportAttempted: attempted,
    /** Request body bytes as built by the caller (pre-redaction wire size). */
    requestBodyBytes: byteLength(opts.body),
  }
  writeFileSync(join(dir, `${prefix}-01-req-meta.json`), JSON.stringify(reqMeta, null, 2))
  writeFileSync(join(dir, `${prefix}-02-req-body.txt`), redactBody(opts.body))

  const resMetaPath = join(dir, `${prefix}-03-res-meta.json`)
  const resBodyPath = join(dir, `${prefix}-04-res-body.txt`)
  const timelinePath = join(dir, `${prefix}-05-res-timeline.jsonl`)
  // Pre-create the files so partial streams still leave a trace if the
  // process is killed mid-response.
  writeFileSync(resBodyPath, "")
  const startedAt = performance.now()
  // First line anchors `t` to the wall clock, so a reader can line the
  // timeline up with session logs and other requests.
  writeFileSync(
    timelinePath,
    `${JSON.stringify({ t: 0, ev: "request", at: new Date().toISOString(), id: seq })}\n`,
  )
  const timeline = (entry: Record<string, unknown>): void => {
    const t = Math.round(performance.now() - startedAt)
    appendFileSync(timelinePath, `${JSON.stringify({ t, ...entry })}\n`)
  }

  let responseBodyBytes = 0
  let ended = false
  let pendingResMeta: Record<string, unknown> | null = null

  /** Rewrite the res-meta with the running byte count (idempotent). */
  const flushResMeta = () => {
    if (!pendingResMeta) return
    writeFileSync(resMetaPath, JSON.stringify({ ...pendingResMeta, responseBodyBytes }, null, 2))
  }

  return {
    recordResponse(status, headers, transport) {
      const headerObj: Record<string, string> = {}
      if (headers instanceof Headers) {
        headers.forEach((v, k) => {
          headerObj[k] = v
        })
      } else {
        Object.assign(headerObj, headers)
      }
      pendingResMeta = {
        id: seq,
        timestamp: new Date().toISOString(),
        status,
        headers: redactHeaders(headerObj),
        transport,
      }
      flushResMeta()
      timeline({ ev: "headers", status })
    },
    appendResponseChunk(chunk) {
      // Buffer.from accepts both string and Uint8Array; no branch needed.
      const buf = Buffer.from(chunk)
      const offset = responseBodyBytes
      responseBodyBytes += buf.byteLength
      appendFileSync(resBodyPath, buf)
      timeline({ ev: "chunk", bytes: buf.byteLength, offset })
    },
    finishResponse() {
      // Body is complete (or the stream died): persist the final byte count.
      // Without this the count would only reflect whatever had arrived when
      // `recordResponse` ran, which is always zero.
      flushResMeta()
      if (!ended) {
        ended = true
        timeline({ ev: "end", bytes: responseBodyBytes })
      }
    },
  }
}

/** Byte length of a UTF-8 string; 0 for empty/nullish. */
function byteLength(body: string): number {
  return body ? Buffer.byteLength(body, "utf8") : 0
}

/** Diagnostics handles that already got the logger-failure warning. */
let LOGGER_ERROR_REPORTED = new WeakSet<Diagnostics>()

/**
 * Emit one warning diagnostic the first time the logger fails (e.g. disk
 * full, permission denied, parent dir gone). The latch is per diagnostics
 * handle, not per process. Each session handle gets its own warning. Later
 * failures on the same handle are silent, so we never spam. Tests can call
 * {@link _resetLoggerErrorReportedForTest} between cases.
 */
export function warnLoggerErrorOnce(
  err: unknown,
  diagnostics: Diagnostics = processDiagnostics(),
): void {
  if (LOGGER_ERROR_REPORTED.has(diagnostics)) return
  LOGGER_ERROR_REPORTED.add(diagnostics)
  const msg = err instanceof Error ? err.message : String(err)
  emitTyped(
    diagnostics,
    Severity.Warning,
    "net-dbg.logger-failure",
    `logger failure (further errors suppressed): ${msg}`,
    {
      detail: msg,
    },
  )
}

/** Test-only: reset the once-latch of every handle. Not part of the public API. */
export function _resetLoggerErrorReportedForTest(): void {
  LOGGER_ERROR_REPORTED = new WeakSet<Diagnostics>()
}

/**
 * Strip secrets from headers before writing them to disk. Bearer tokens are
 * collapsed to just `Bearer [REDACTED]` (no token bytes leak). Other auth
 * schemes pass through unchanged so a future debugger can see what scheme was
 * actually in use. Non-secret headers are preserved verbatim.
 */
export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase()
    if (key === "authorization" && v.startsWith("Bearer ")) {
      out[k] = "Bearer [REDACTED]"
    } else if (key === "proxy-authorization") {
      out[k] = "[REDACTED]"
    } else if (key === "x-api-key" || key === "cookie" || key === "set-cookie") {
      out[k] = "[REDACTED]"
    } else {
      out[k] = v
    }
  }
  return out
}

/** Redacts sensitive content from the request body. */
export function redactBody(body: string): string {
  if (!body) return body
  if (body.startsWith("{") || body.startsWith("[")) {
    try {
      const parsed = JSON.parse(body)
      const redactNode = (node: any) => {
        if (!node || typeof node !== "object") return
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === "string" && /secret|token|password|code/i.test(k)) {
            node[k] = "[REDACTED]"
          } else if (typeof v === "object") {
            redactNode(v)
          }
        }
      }
      redactNode(parsed)
      return JSON.stringify(parsed)
    } catch {
      // Fall through to regex
    }
  }
  return body.replace(
    /([&?]?(?:client_secret|refresh_token|access_token|token|password|code)=)([^&]*)/gi,
    "$1[REDACTED]",
  )
}
