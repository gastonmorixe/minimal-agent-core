/**
 * Pure rendering helpers for cron tasks (shared by tools, commands, and
 * the heartbeat status row). Strings only — no harness types, no ANSI
 * dependencies. Handlers wrap these into tool results / notices.
 *
 * @module schedule/lib/format
 */

import { nextFireMs } from "./scheduler.ts"
import type { CronEntry } from "./store.ts"

/**
 * Schedule glyphs. All monochrome, width-1, and SGR-colorable (unlike the
 * old `⏰`/`◷` — the alarm was a color-emoji that ignored color, the thin
 * quarter-circle had almost no ink at terminal size). Filled/heavy strokes so
 * they read at a glance:
 *   - {@link GLYPH_TIME} `⧗` a point in time / "next fire" / a scheduled one-shot
 *   - {@link GLYPH_LOOP} `⟳` a recurring cycle / a `/loop`
 * Painted bold+color at every call site; the glyph carries state through color.
 */
export const GLYPH_TIME = "⧗"
export const GLYPH_LOOP = "⟳"

/** `HH:MM:SS` local-time stamp for a box header. Pure (clock injected as ms). */
export function clockHHMMSS(now: number): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Clip a prompt to a single line of at most `max` chars. */
export function clipPrompt(prompt: string, max = 48): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

/** Human cadence label for an entry. */
export function cadenceLabel(e: CronEntry): string {
  if (e.label) return e.label
  if (e.pace === "dynamic") return "self-paced"
  return e.cron
}

/**
 * Format a ms delta from now as a compact relative string.
 *
 * Sub-hour deltas keep SECONDS precision (`in 1m30s`, not `in 2m`): the
 * live footer redraws every tick, and a minutes-only label looks frozen
 * for up to a minute while the countdown is actually running. Hour/day
 * scales stay coarse — nobody watches those tick.
 */
export function relativeTime(targetMs: number, now: number): string {
  const d = targetMs - now
  if (d <= 0) return "due now"
  const s = Math.round(d / 1000)
  if (s < 60) return `in ${s}s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const remS = s % 60
    return remS > 0 ? `in ${m}m${remS}s` : `in ${m}m`
  }
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h < 24) return rem > 0 ? `in ${h}h ${rem}m` : `in ${h}h`
  const days = Math.round(h / 24)
  return `in ${days}d`
}

/**
 * Per-task kind glyph: {@link GLYPH_LOOP} for recurring, {@link GLYPH_TIME}
 * for a one-shot. See those constants for the rationale.
 */
export function kindGlyph(e: CronEntry): string {
  return e.recurs ? GLYPH_LOOP : GLYPH_TIME
}

/** One-line summary of a task for a list. */
export function formatEntry(e: CronEntry, now: number): string {
  const next = nextFireMs(e, now)
  const when = next === null ? "—" : relativeTime(next, now)
  return `${kindGlyph(e)} ${e.id}  ${cadenceLabel(e)}  (${when})  ${clipPrompt(e.prompt)}`
}

/** Full multi-line listing (header + rows). Empty → a single "no tasks" line. */
export function formatList(entries: CronEntry[], now: number): string[] {
  if (entries.length === 0) return ["No scheduled tasks."]
  const rows = entries
    .slice()
    .sort((a, b) => (nextFireMs(a, now) ?? Infinity) - (nextFireMs(b, now) ?? Infinity))
    .map((e) => formatEntry(e, now))
  return [`${entries.length} scheduled task${entries.length === 1 ? "" : "s"}:`, ...rows]
}

/**
 * Header tail for a task box: cadence + next fire, e.g.
 * `every 10s · next in 8s`. ANSI-free; the box renderer dims it.
 */
export function taskInfo(e: CronEntry, now: number): string {
  const next = nextFireMs(e, now)
  const when = next === null ? "unknown" : relativeTime(next, now)
  return `${cadenceLabel(e)} · next ${when}`
}

/**
 * Footer for a created-task box: id, recurrence, expiry, and the cancel hint.
 * ANSI-free; the box renderer dims it.
 */
export function taskFooter(e: CronEntry, now: number): string {
  const parts = [e.id, e.recurs ? "recurring" : "one-shot"]
  if (e.recurs && e.expiresAt !== undefined) {
    parts.push(`expires ${relativeTime(e.expiresAt, now)}`)
  }
  parts.push(`cancel /schedule cancel ${e.id}`)
  return parts.join(" · ")
}

/**
 * Word-wrap `text` to `width` columns (default 72), never splitting a word.
 * Pure; used to flow a long prompt across the box body lines.
 */
export function wrapText(text: string, width = 72): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ")
  if (words.length === 0 || words[0] === "") return []
  const out: string[] = []
  let line = ""
  for (const w of words) {
    if (line === "") line = w
    else if (line.length + 1 + w.length <= width) line += ` ${w}`
    else {
      out.push(line)
      line = w
    }
  }
  if (line !== "") out.push(line)
  return out
}

/**
 * Model-facing confirmation lines after creating a task (ANSI-free; goes in a
 * tool-result `content`, which the model reads). The colored box for the TUI
 * is built separately via ./box.ts.
 */
export function describeCreated(e: CronEntry, now: number, rounded: boolean): string[] {
  const lines = [
    `${kindGlyph(e)} scheduled ${e.id} — ${taskInfo(e, now)}`,
    `   ${clipPrompt(e.prompt, 72)}`,
  ]
  if (rounded) lines.push(`   (rounded to ${cadenceLabel(e)} for a clean cadence)`)
  return lines
}

// The live-area footer status row moved to ./footer.ts, which imports the
// shared PALETTE and emits real ANSI (the quota footer's approach). Keeping
// this module ANSI-free preserves the invariant that its output is safe for
// model-facing tool-result `content`.
