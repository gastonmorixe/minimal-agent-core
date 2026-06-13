import type { StatusActivity, StatusDirection } from "../../status.ts"
import { displayWidth } from "../../term-width.ts"

export const LABEL_BYTES_RE = /\(\d+(?:\.\d+)?\s?(?:B|KB|MB)\)\s*$/

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`
}

/** Compact "wall-clock elapsed" formatter for status-row suffixes. */
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const totalSec = Math.floor(safe / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  const sec = totalSec - totalMin * 60
  if (totalMin < 60) return `${totalMin}m ${sec}s`
  const hours = Math.floor(totalMin / 60)
  const min = totalMin - hours * 60
  return `${hours}h ${min}m`
}

/** Render a faint elapsed suffix, including its leading space. */
export function formatElapsedSuffix(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return ""
  return ` ${dim(`(${formatElapsed(ms)})`)}`
}

export const STALL_THRESHOLD_MS = 2_000

function faintWhite(text: string): string {
  return `\x1b[2;37m${text}\x1b[22;39m`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(n)
}

export interface FormatActivityOptions {
  now?: number
  maxWidth?: number
  stallThresholdMs?: number
  entryStartedAt?: number
  hideBytes?: boolean
}

/** Render the structured activity payload as a compact status-row infix. */
export function formatActivityInfix(
  activity: StatusActivity | undefined,
  opts: FormatActivityOptions = {},
): string {
  if (!activity) return ""
  const now = opts.now ?? Date.now()
  const stallThresh = opts.stallThresholdMs ?? STALL_THRESHOLD_MS
  const dir = activity.direction
  const stalled =
    dir === "down" && activity.lastChunkAt != null && now - activity.lastChunkAt > stallThresh

  let arrow: string
  if (stalled) arrow = `\x1b[38;5;214m⋯ stalled\x1b[39m`
  else if (dir === "up") arrow = `\x1b[38;5;45m↑\x1b[39m`
  else if (dir === "down") arrow = `\x1b[38;5;118m↓\x1b[39m`
  else arrow = `\x1b[2m·\x1b[22m`

  const segs: string[] = []

  if (!opts.hideBytes) {
    const b = pickBytesForDirection(activity)
    if (b != null && b > 0) segs.push(faintWhite(fmtBytes(b)))
  }

  const tok = dir === "up" ? activity.sentTokens : activity.recvTokens
  if (tok != null && tok > 0) {
    segs.push(faintWhite(`~${fmtTokens(tok)} tok`))
  }

  if (opts.entryStartedAt != null && opts.entryStartedAt > 0) {
    const elapsedMs = now - opts.entryStartedAt
    if (elapsedMs >= 500) {
      const rate = computeRate(activity, elapsedMs, dir)
      if (rate) segs.push(dim(rate))
    }
  }

  const target = activity.target
  if (target?.host) {
    const proto = target.protocol ? `:${target.protocol}` : ""
    segs.push(faintWhite(`${target.host}${proto}`))
  }

  if (stalled && activity.lastChunkAt != null) {
    const sinceMs = now - activity.lastChunkAt
    const sinceS = Math.max(1, Math.floor(sinceMs / 1000))
    segs.unshift(faintWhite(`last byte ${sinceS}s ago`))
  }

  const sep = dim(" · ")
  const arrowGap = stalled && segs.length > 0 ? sep : " "
  const compose = (parts: string[]): string =>
    parts.length === 0 ? ` ${arrow}` : ` ${arrow}${arrowGap}${parts.join(sep)}`
  let result = compose(segs)

  if (opts.maxWidth != null && Number.isFinite(opts.maxWidth)) {
    while (displayWidth(result) > opts.maxWidth && segs.length > 0) {
      segs.pop()
      result = compose(segs)
    }
    if (displayWidth(result) > opts.maxWidth) return ""
  }
  return result
}

function pickBytesForDirection(activity: StatusActivity): number | undefined {
  if (activity.direction === "up") return activity.sentBytes ?? activity.recvBytes
  if (activity.direction === "down") return activity.recvBytes ?? activity.sentBytes
  return activity.recvBytes ?? activity.sentBytes
}

function computeRate(
  activity: StatusActivity,
  elapsedMs: number,
  dir: StatusDirection | undefined,
): string | null {
  const secs = elapsedMs / 1000
  if (secs <= 0) return null
  const tok = dir === "up" ? activity.sentTokens : activity.recvTokens
  if (tok != null && tok > 0) {
    const tps = tok / secs
    if (tps < 10) return `${tps.toFixed(1)} tok/s`
    return `${Math.round(tps)} tok/s`
  }
  const b = pickBytesForDirection(activity)
  if (b != null && b > 0) {
    const bps = b / secs
    if (bps < 1024) return `${Math.round(bps)} B/s`
    return `${(bps / 1024).toFixed(1)} KB/s`
  }
  return null
}
