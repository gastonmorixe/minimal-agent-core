/**
 * On-disk request/response logger, mirroring Claude Code's ~/.node-net-dbg/
 * file-quad scheme (req-meta.json, req-body.txt, res-meta.json, res-body.txt).
 *
 * Disabled by default. Enable with `MINIMAL_AGENT_NET_DBG=1`. Logs go to
 * `${cwd}/.net-dbg/${epoch}-${human-date}/`. Each call produces four
 * files keyed by a per-process sequence number.
 *
 * Designed to be called from {@link sendMessage} in client.ts. The response
 * body is tee'd so the caller still gets a readable stream for SSE parsing.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { getSessionId } from "./session-id.ts"

/**
 * Captured at module load. Toggling MINIMAL_AGENT_NET_DBG at runtime does NOT
 * take effect — this is intentional so the logger's enabled state is stable
 * for the lifetime of the process. Restart to change.
 */
const ENABLED = process.env.MINIMAL_AGENT_NET_DBG === "1"

let SEQ = 0
let SESSION_DIR: string | null = null

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

function ensureSessionDir(): string | null {
  if (!ENABLED) return null
  if (SESSION_DIR && existsSync(SESSION_DIR)) return SESSION_DIR

  const dir = join(
    process.cwd(),
    ".net-dbg",
    formatSessionDirName(Date.now(), new Date(), getSessionId()),
  )
  mkdirSync(dir, { recursive: true })
  SESSION_DIR = dir
  return dir
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

const NULL_HANDLE: NetDbgHandle = {
  recordResponse() {},
  appendResponseChunk() {},
  finishResponse() {},
}

/**
 * Records a request to disk and returns a handle for streaming the response.
 * Returns a no-op handle when MINIMAL_AGENT_NET_DBG is not set.
 *
 * The `opts` bag carries the request capture data: `url`, `method`,
 * `headers`, `body` (request body to write), and `protocol` (transport
 * label for file naming).
 *
 * @returns Capture handle used to finish response logging.
 */
export function beginRequest(opts: {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  protocol?: string
}): NetDbgHandle {
  const dir = ensureSessionDir()
  if (!dir) return NULL_HANDLE

  const seq = ++SEQ
  const stamp = isoStamp()
  const proto = opts.protocol ?? "fetch"
  const prefix = `${stamp}-${proto}-${pad3(seq)}`

  const reqMeta = {
    id: seq,
    timestamp: new Date().toISOString(),
    url: opts.url,
    method: opts.method,
    headers: redactHeaders(opts.headers),
    protocol: proto,
  }
  writeFileSync(join(dir, `${prefix}-01-req-meta.json`), JSON.stringify(reqMeta, null, 2))
  writeFileSync(join(dir, `${prefix}-02-req-body.txt`), opts.body)

  const resBodyPath = join(dir, `${prefix}-04-res-body.txt`)
  // Pre-create the file so partial streams still leave a trace if the
  // process is killed mid-response.
  writeFileSync(resBodyPath, "")

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
      const resMeta = {
        id: seq,
        timestamp: new Date().toISOString(),
        status,
        headers: headerObj,
        transport,
      }
      writeFileSync(join(dir, `${prefix}-03-res-meta.json`), JSON.stringify(resMeta, null, 2))
    },
    appendResponseChunk(chunk) {
      // Buffer.from accepts both string and Uint8Array; no branch needed.
      appendFileSync(resBodyPath, Buffer.from(chunk))
    },
    finishResponse() {
      // Currently a no-op; reserved for future end-of-stream metadata.
    },
  }
}

/**
 * Returns true if on-disk logging is active for this process.
 */
export function netDbgEnabled(): boolean {
  return ENABLED
}

let LOGGER_ERROR_REPORTED = false

/**
 * Print a single console.warn the first time the logger fails (e.g. disk
 * full, permission denied, parent dir gone). Subsequent failures are silent
 * so we never spam. Tests can call {@link _resetLoggerErrorReportedForTest}
 * between cases to inspect the latched-on behaviour.
 */
export function warnLoggerErrorOnce(err: unknown): void {
  if (LOGGER_ERROR_REPORTED) return
  LOGGER_ERROR_REPORTED = true
  const msg = err instanceof Error ? err.message : String(err)
  console.warn(`[minimal-agent net-dbg] logger failure (further errors suppressed): ${msg}`)
}

/** Test-only: reset the once-flag. Not part of the public API. */
export function _resetLoggerErrorReportedForTest(): void {
  LOGGER_ERROR_REPORTED = false
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
    } else if (key === "x-api-key") {
      out[k] = "[REDACTED]"
    } else {
      out[k] = v
    }
  }
  return out
}
