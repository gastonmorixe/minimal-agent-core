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
 *   │   3  fetch the extended plugins (Fetch, Skill, ...)
 *   ╰ takes a few seconds · everything lands in ~/.minimal-agent
 *
 * @module ui/chrome/first-run
 */

import { existsSync } from "node:fs"

import { ansiStyle as A } from "@minimal-agent/plugin-api/utils/ansi"

import { resolveAgentHome } from "../../agent-paths.ts"

// Keep this module free of agent runtime imports so the cold path stays light.

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
  const gutter = A.faintWhite("│")
  const lines: string[] = []
  lines.push(
    `  ${A.faintWhite("╭")} ${A.bold(A.pink("minimal-agent"))} ${A.faintWhite("· first run")}`,
  )
  lines.push(`  ${gutter} ${A.dim("Setting things up for you. This happens once.")}`)
  lines.push(`  ${gutter}`)
  opts.steps.forEach((step, i) => {
    const n = A.sky(String(i + 1))
    const label = step.pending === false ? A.dim(step.label) : step.label
    lines.push(`  ${gutter}   ${n}  ${label}`)
  })
  lines.push(
    `  ${A.faintWhite("╰")} ${A.dim("takes a few seconds")} ${A.faintWhite("·")} ${A.dim(`everything lands in ${home}`)}`,
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

/**
 * Resolve the agent's home dir. `MINIMAL_AGENT_HOME` overrides (relocation,
 * tests, sandboxes). Delegates to the single source of truth in
 * `src/agent-paths.ts` so the resolution rule lives in exactly one place.
 */
export function defaultAgentHome(): string {
  return resolveAgentHome()
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
