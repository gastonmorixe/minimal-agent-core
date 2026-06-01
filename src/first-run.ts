/**
 * First-run welcome card.
 *
 * On a genuine cold start (no `~/.minimal-agent` directory yet) we print a
 * short, friendly card that frames the one-time setup the agent is about to
 * do: sign in, fetch the Markdown renderer, fetch the extended plugins. It
 * sets expectations so the auto-download spinners that follow read as
 * "expected setup" instead of "why is it talking to the network".
 *
 * The builder is pure (returns a string, no I/O) so it is unit-testable; the
 * detection + emit wrapper lives in {@link maybeShowFirstRunWelcome}.
 *
 * Visual shape mirrors the startup tree (rounded corners, faint gutter) so the
 * card feels like part of the same UI, just one box higher:
 *
 *   ╭ minimal-agent · first run
 *   │ Setting things up for you. This happens once.
 *   │
 *   │   1  sign in to your Anthropic (Claude) account
 *   │   2  fetch mdstream, the Markdown renderer
 *   │   3  fetch the extended plugins (Fetch, Skill, …)
 *   ╰ takes a few seconds · everything lands in ~/.minimal-agent
 *
 * @module first-run
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Inline ANSI — keep this module free of agent.ts imports so it can be loaded
// on the cold path before the heavier UI modules.
const A = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  faint: (s: string) => `\x1b[2;37m${s}\x1b[22;39m`,
  pink: (s: string) => `\x1b[38;5;211m${s}\x1b[39m`,
  sky: (s: string) => `\x1b[38;5;45m${s}\x1b[39m`,
}

/** One setup step shown as a numbered row. */
export interface FirstRunStep {
  /** Short imperative label, e.g. "sign in to your Anthropic account". */
  label: string
  /** When false, the step is rendered struck-through / dim (already satisfied). */
  pending?: boolean
}

export interface FirstRunCardOptions {
  /** Steps to list, in order. */
  steps: FirstRunStep[]
  /** Where everything is stored (shown in the closer). Default `~/.minimal-agent`. */
  homeLabel?: string
}

/**
 * Build the first-run welcome card as an ANSI string (no trailing newline
 * beyond the final row's). Pure: safe to snapshot in tests.
 */
export function buildFirstRunCard(opts: FirstRunCardOptions): string {
  const home = opts.homeLabel ?? "~/.minimal-agent"
  const gutter = A.faint("│")
  const lines: string[] = []
  lines.push(`  ${A.faint("╭")} ${A.bold(A.pink("minimal-agent"))} ${A.faint("· first run")}`)
  lines.push(`  ${gutter} ${A.dim("Setting things up for you. This happens once.")}`)
  lines.push(`  ${gutter}`)
  opts.steps.forEach((step, i) => {
    const n = A.sky(String(i + 1))
    const label = step.pending === false ? A.dim(step.label) : step.label
    lines.push(`  ${gutter}   ${n}  ${label}`)
  })
  lines.push(
    `  ${A.faint("╰")} ${A.dim("takes a few seconds")} ${A.faint("·")} ${A.dim(`everything lands in ${home}`)}`,
  )
  return lines.join("\n")
}

/**
 * Whether this looks like a genuine cold start: the agent's home directory
 * (`~/.minimal-agent`, or `MINIMAL_AGENT_HOME` when set for tests) does not
 * exist yet. We probe the directory, not individual files, so a user who has
 * logged in once but never triggered a plugin sync is NOT treated as cold.
 */
export function isColdStart(homeDir: string = defaultAgentHome()): boolean {
  return !existsSync(homeDir)
}

/** Resolve the agent's home dir. `MINIMAL_AGENT_HOME` overrides (tests). */
export function defaultAgentHome(): string {
  const override = process.env.MINIMAL_AGENT_HOME?.trim()
  if (override) return override
  return join(homedir(), ".minimal-agent")
}

/**
 * Print the welcome card to stderr when this is a cold start AND the session
 * is interactive (a TTY on stdout). Returns `true` if the card was shown.
 *
 * Non-interactive / piped runs stay silent: a scripted `--prompt` call should
 * not gain a decorative banner. The card is emitted to stderr so it never
 * pollutes captured stdout.
 *
 * Detection is intentionally simple and side-effect-free here — we only READ
 * whether the home dir exists. The dir is created moments later by the auth
 * store / formatter cache, so the card shows exactly once per machine.
 */
export function maybeShowFirstRunWelcome(opts: {
  steps: FirstRunStep[]
  isInteractive: boolean
  homeDir?: string
  write?: (s: string) => void
}): boolean {
  if (!opts.isInteractive) return false
  if (!isColdStart(opts.homeDir ?? defaultAgentHome())) return false
  const write = opts.write ?? ((s: string) => process.stderr.write(s))
  write(`\n${buildFirstRunCard({ steps: opts.steps })}\n\n`)
  return true
}
