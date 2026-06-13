/**
 * Pure argument parsers for the `/loop` and `/schedule` commands.
 *
 * @module schedule/lib/loop-parse
 */

import { parseDuration } from "./interval.ts"

/** Parsed `/loop` argv: an optional leading interval + the prompt. */
export interface LoopArgs {
  /** Leading interval token/clause (`"5m"`, `"every 2 hours"`), or null. */
  interval: string | null
  /** The remaining prompt (may be empty for a bare `/loop` or `/loop 5m`). */
  prompt: string
}

/**
 * Split `/loop` argv into `{interval, prompt}`.
 *
 * Recognizes a leading bare token (`5m check …`) or a leading `every N unit`
 * clause (`every 2 hours check …`). Anything else is treated as all-prompt
 * (a self-paced loop). Whitespace inside the prompt is collapsed.
 *
 * @param argv - The raw argv after `/loop`.
 */
export function parseLoopArgs(argv: string): LoopArgs {
  const trimmed = argv.trim()
  if (trimmed === "") return { interval: null, prompt: "" }
  const tokens = trimmed.split(/\s+/)

  // "every N unit ..."
  if (tokens[0]?.toLowerCase() === "every" && tokens.length >= 3) {
    const clause = `every ${tokens[1]} ${tokens[2]}`
    if (parseDuration(clause) !== null) {
      return { interval: clause, prompt: tokens.slice(3).join(" ") }
    }
  }
  // Leading bare token (e.g. "5m", "2h").
  if (tokens[0] && parseDuration(tokens[0]) !== null) {
    return { interval: tokens[0], prompt: tokens.slice(1).join(" ") }
  }
  return { interval: null, prompt: trimmed }
}

/** Discriminated result of parsing `/schedule` argv. */
export type ScheduleAction =
  | { kind: "list" }
  | { kind: "cancel"; id: string }
  | { kind: "create"; cron: string; prompt: string }
  | { kind: "usage" }
  | { kind: "error"; message: string }

const USAGE = 'usage: /schedule "<cron>" <prompt>  |  /schedule list  |  /schedule cancel <id>'

/**
 * Parse `/schedule` argv into an action.
 *
 * Forms: `list`, `cancel <id>`, `"<cron>" <prompt>` (quoted cron), or
 * `<5 cron fields> <prompt>` (unquoted). Empty argv → usage.
 *
 * @param argv - The raw argv after `/schedule`.
 */
export function parseScheduleArgs(argv: string): ScheduleAction {
  const t = argv.trim()
  if (t === "") return { kind: "usage" }
  if (/^list$/i.test(t)) return { kind: "list" }

  const cancel = /^cancel\s+(\S+)$/i.exec(t)
  if (cancel?.[1]) return { kind: "cancel", id: cancel[1] }

  // Quoted cron: "0 9 * * 1-5" run the report
  const quoted = /^["']([^"']+)["']\s*([\s\S]*)$/.exec(t)
  if (quoted?.[1] !== undefined) {
    const cron = quoted[1].trim()
    const prompt = (quoted[2] ?? "").trim()
    if (!prompt) return { kind: "error", message: `provide a prompt after the cron. ${USAGE}` }
    return { kind: "create", cron, prompt }
  }

  // Unquoted: first 5 whitespace tokens are the cron, the rest is the prompt.
  const tokens = t.split(/\s+/)
  if (tokens.length >= 6) {
    return { kind: "create", cron: tokens.slice(0, 5).join(" "), prompt: tokens.slice(5).join(" ") }
  }

  return { kind: "error", message: USAGE }
}
