/**
 * Startup auth prompt chrome.
 *
 * Startup decides whether credentials are missing/stale; this module owns the
 * terminal rows for the inline "sign in now?" offer.
 *
 * @module ui/chrome/auth-prompt
 */

import { c } from "../style/ansi.ts"

export type StartupAuthPromptKind = "missing" | "stale"

/** Headline shown above the inline login offer. */
export function startupAuthPromptHeadline(kind: StartupAuthPromptKind): string {
  return kind === "missing"
    ? `${c.bold("Welcome to minimal-agent")} — you're not signed in yet.`
    : `${c.bold("Credentials expired")} — refresh token rejected.`
}

/** Diagnosis rows shown before asking whether to run login inline. */
export function renderStartupAuthPromptIntro(
  kind: StartupAuthPromptKind,
  message: string,
): string[] {
  return [
    "",
    `  ${c.bold(c.pink("⮕"))} ${startupAuthPromptHeadline(kind)}`,
    `  ${c.faintWhite("│")} ${c.dim(message)}`,
  ]
}

/** Prompt text for the yes/no inline login question. No trailing newline. */
export function renderStartupAuthPromptQuestion(defaultYes: boolean): string {
  return `  ${c.faintWhite("│")} Sign in now? ${c.dim(defaultYes ? "[Y/n]" : "[y/N]")} `
}

/** Rows shown when the user declines inline login. */
export function renderStartupAuthPromptAborted(): string[] {
  return [
    `  ${c.faintWhite("╰")} ${c.dim("aborted — run `minimal-agent --login` later to sign in.")}`,
  ]
}

/** Rows shown before handing off to the login command. */
export function renderStartupAuthPromptStarting(): string[] {
  return [`  ${c.faintWhite("╰")} ${c.dim("starting login…")}`, ""]
}
