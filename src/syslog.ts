/**
 * Pure RFC 5424 syslog formatter.
 *
 * Reference: https://datatracker.ietf.org/doc/html/rfc5424
 *
 * Output shape:
 *
 * ```text
 * <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
 * ```
 *
 * Example produced by this formatter:
 *
 * ```text
 * <12>1 2026-05-20T11:14:37.412Z macbookpro.home.arpa minimal-agent 87654 live-area.timeout [ma@local slot="quota-status/quota" timeout-ms="8000"] invoke did not resolve in time
 * ```
 *
 * Notes on our profile:
 *
 * - **TIMESTAMP**: RFC 3339 UTC with milliseconds (`Date.toISOString()`).
 *   Parsers accept this verbatim. We don't emit local TZ — UTC is
 *   unambiguous for machine consumers and round-trips cleanly.
 *
 * - **HOSTNAME / PROCID**: pass through the caller's choice. Default to
 *   NILVALUE `-` if missing. We don't auto-probe `os.hostname()` here
 *   to keep the formatter pure; the {@link FileLogSink} reads
 *   `os.hostname()` and passes it in.
 *
 * - **APP-NAME**: defaults to `minimal-agent`.
 *
 * - **MSGID**: we use the event's `source` field (e.g. `live-area.timeout`)
 *   — it's exactly the grep target a log analyst wants.
 *
 * - **STRUCTURED-DATA**:
 *   - SD-ID defaults to `ma@local`. Per RFC 5424 §6.3.2, the suffix
 *     after `@` should be an IANA Private Enterprise Number for
 *     globally-unique identifiers; we use `local` to be honest about
 *     the fact that we're not registered.
 *   - SD-NAME chars `=`, `]`, `"`, SP are forbidden; we sanitize to `_`.
 *   - SD-PARAM-VALUE chars `"`, `\`, `]` must be backslash-escaped.
 *
 * - **MSG**: CR/LF are unwelcome in a one-line-per-event file format.
 *   We escape them to literal `\n`/`\r` so a single physical line equals
 *   a single logical event.
 *
 * @module syslog
 */

import type { LogEvent, StructuredData } from "./bus/diagnostic-bus.ts"

export interface SyslogFormatOptions {
  /** RFC 5424 HOSTNAME field. Defaults to NILVALUE `-`. */
  hostname?: string
  /** RFC 5424 APP-NAME field. Defaults to `minimal-agent`. */
  appName?: string
  /** RFC 5424 PROCID field. Defaults to NILVALUE `-`. */
  procId?: number | string
  /**
   * SD-ID for the STRUCTURED-DATA block. Default `ma@local` —
   * acknowledges we're not IANA-registered. Override to `ma@<PEN>` if
   * you ever register one.
   */
  sdId?: string
}

const NIL = "-"

/**
 * Format one `LogEvent` as a single RFC 5424 line (no trailing newline).
 *
 * Pure function — no I/O, no time lookups. Caller controls all
 * substituted values.
 */
export function formatRfc5424(event: LogEvent, opts: SyslogFormatOptions = {}): string {
  const pri = event.facility * 8 + event.severity
  const ts = formatTimestamp(event.ts)
  const host =
    opts.hostname && opts.hostname.length > 0 ? sanitizePrintableAscii(opts.hostname) : NIL
  const app =
    opts.appName && opts.appName.length > 0 ? sanitizePrintableAscii(opts.appName) : "minimal-agent"
  const pid =
    opts.procId !== undefined && String(opts.procId).length > 0
      ? sanitizePrintableAscii(String(opts.procId))
      : NIL
  const msgId = event.source && event.source.length > 0 ? sanitizePrintableAscii(event.source) : NIL
  const sd = formatStructuredData(event.structuredData, opts.sdId ?? "ma@local")
  const msg = sanitizeMessage(event.message)
  return `<${pri}>1 ${ts} ${host} ${app} ${pid} ${msgId} ${sd} ${msg}`
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString() // 2026-05-20T11:14:37.412Z
}

function formatStructuredData(sd: StructuredData | undefined, sdId: string): string {
  if (!sd) return NIL
  const keys = Object.keys(sd)
  if (keys.length === 0) return NIL
  const parts: string[] = []
  for (const k of keys) {
    const safeKey = sanitizeSdName(k)
    const safeVal = escapeSdValue(String(sd[k]))
    parts.push(`${safeKey}="${safeVal}"`)
  }
  return `[${sanitizeSdId(sdId)} ${parts.join(" ")}]`
}

/**
 * RFC 5424 §6.3.3 SD-PARAM-VALUE: `"`, `\`, `]` must be backslash-escaped.
 * Order matters: backslash MUST be escaped first so we don't double-escape
 * the backslashes we introduce.
 */
function escapeSdValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\]/g, "\\]")
}

/**
 * RFC 5424 SD-NAME: PRINTUSASCII excluding `=`, `]`, `"`, SP. We replace
 * forbidden chars with `_` so e.g. `"timeout ms"` becomes `timeout_ms`.
 * Also strips control chars (below 0x20) and DEL (0x7f).
 */
function sanitizeSdName(name: string): string {
  let out = ""
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]
    const code = name.charCodeAt(i)
    if (code < 0x21 || code === 0x7f) out += "_"
    else if (ch === "=" || ch === "]" || ch === '"' || ch === " ") out += "_"
    else out += ch
  }
  return out.length > 0 ? out : "_"
}

/** SD-ID has same character restrictions as SD-NAME, but `@` is allowed. */
function sanitizeSdId(id: string): string {
  // Conservative: allow `@` plus everything SD-NAME allows.
  let out = ""
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]
    const code = id.charCodeAt(i)
    if (code < 0x21 || code === 0x7f) out += "_"
    else if (ch === "=" || ch === "]" || ch === '"' || ch === " ") out += "_"
    else out += ch
  }
  return out.length > 0 ? out : "ma@local"
}

/**
 * Strip control chars from header fields (HOSTNAME, APP-NAME, PROCID,
 * MSGID). RFC requires PRINTUSASCII; we replace any byte below 0x21 (incl.
 * SP since fields are space-separated) and DEL with `_`. We DON'T strip
 * non-ASCII bytes — most modern parsers handle UTF-8 in the header
 * gracefully, and the `os.hostname()` value on some systems is UTF-8.
 */
function sanitizePrintableAscii(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x21 || code === 0x7f) out += "_"
    else out += s[i]
  }
  return out
}

/**
 * One-line MSG: escape CR and LF to literal `\r` / `\n` so a single
 * physical line equals a single logical event.
 *
 * Order matters: CRLF must collapse to `\n` (one event terminator, not
 * two), so we handle that pair before the single-byte cases.
 */
function sanitizeMessage(s: string): string {
  return s.replace(/\r\n/g, "\\n").replace(/\n/g, "\\n").replace(/\r/g, "\\r")
}
