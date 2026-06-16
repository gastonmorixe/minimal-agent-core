/**
 * Host-owned login command chrome.
 *
 * Providers describe auth strategies; they do not render terminal UI. The
 * command layer chooses the strategy, and this module owns the rows users see.
 *
 * @module ui/chrome/login
 */

import type { LoginInstallResult } from "../../oauth-login.ts"
import { c } from "../style/ansi.ts"

/** Banner rows shown before resolving/running a login strategy. */
export function renderLoginBanner(): string[] {
  return [`  ${c.bold(c.pink("⮕"))} ${c.bold("Sign in")}`, `  ${c.faintWhite("│")}`]
}

/** Rows for a non-interactive stdin failure. */
export function renderLoginRequiresTty(): string[] {
  return [
    `  ${c.boldRed("✗")} ${c.bold("--login requires an interactive terminal")} ${c.dim(
      "(stdin must be a TTY; PKCE manual-paste flow can't be scripted)",
    )}`,
  ]
}

/** Rows for provider/orchestrator display messages. */
export function renderLoginDisplayMessage(message: string): string[] {
  return message.split("\n").map((line) => `  ${c.faintWhite("│")} ${line}`)
}

/** Success rows for OAuth login. */
export function renderOAuthLoginSuccess(result: LoginInstallResult): string[] {
  const account = result.account
  const acctSuffix = account
    ? ` ${c.dim(`(${account.emailAddress} · ${account.uuid.slice(0, 8)}…)`)}`
    : ""
  const rows = [``, `  ${c.boldGreen("✔")} ${c.bold("Login successful")}${acctSuffix}`]
  if (result.scopes.length > 0) {
    rows.push(`  ${c.dim(`scopes: ${result.scopes.join(" ")}`)}`)
  }
  const expDate = new Date(result.expiresAt).toISOString().replace("T", " ").slice(0, 19)
  rows.push(`  ${c.dim(`expires: ${expDate} UTC`)}`)
  return rows
}

/** Success rows for API-key login. */
export function renderApiKeyLoginSuccess(
  displayName: string,
  providerId: string,
  modelHint?: string,
): string[] {
  const rows = [
    ``,
    `  ${c.boldGreen("✔")} ${c.bold("Login successful")}`,
    `  ${c.dim(`stored: ${displayName}`)}`,
  ]
  if (modelHint) {
    rows.push(
      `  ${c.dim(`next: add "model": "${modelHint}" and "provider": "${providerId}" to ~/.minimal-agent/config.jsonc`)}`,
    )
    rows.push(`  ${c.dim(`or run: minimal-agent --provider ${providerId} --model ${modelHint}`)}`)
  }
  return rows
}

/** Failure rows for either login strategy. */
export function renderLoginFailure(reason: string): string[] {
  return [``, `  ${c.boldRed("✗")} ${c.bold("Login failed")} ${c.dim(`— ${reason}`)}`]
}
