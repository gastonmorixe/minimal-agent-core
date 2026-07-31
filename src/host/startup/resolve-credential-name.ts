/**
 * Credential-name precedence for startup / resume.
 *
 * CLI flag wins, then user config, then the pin recorded on the session
 * being resumed. That last fallback is what lets `--resume` keep using the
 * same ChatGPT OAuth account without re-passing `--credential-name`.
 *
 * @module host/startup/resolve-credential-name
 */

import { loadSession } from "../../session/session-restore.ts"
import { resolveSessionTarget } from "../commands/session-index.ts"

/** Inputs for {@link resolveCredentialName}. */
export interface ResolveCredentialNameInput {
  /** `--credential-name` / `MINIMAL_AGENT_CREDENTIAL_NAME`. */
  cliCredentialName?: string
  /** `credentialName` from user config.jsonc. */
  configCredentialName?: string
  /** `meta.credentialName` from the session being resumed, when any. */
  resumeCredentialName?: string
}

/**
 * Pick the effective credential name for auth resolution.
 * Returns `undefined` when nothing is pinned (provider default displayName).
 */
export function resolveCredentialName(input: ResolveCredentialNameInput): string | undefined {
  const cli = input.cliCredentialName?.trim()
  if (cli) return cli
  const config = input.configCredentialName?.trim()
  if (config) return config
  const resume = input.resumeCredentialName?.trim()
  if (resume) return resume
  return undefined
}

/**
 * Best-effort read of `meta.credentialName` for a `--resume` target.
 * Returns `undefined` when not resuming, the sid is unknown, or meta has
 * no pin (legacy sessions). Never throws.
 */
export function peekResumeCredentialName(
  resumeArg: string | undefined,
  cwd: string = process.cwd(),
): string | undefined {
  if (!resumeArg) return undefined
  try {
    const sid = resolveSessionTarget(resumeArg, cwd)
    if (!sid) return undefined
    return loadSession(sid).meta?.credentialName
  } catch {
    return undefined
  }
}
