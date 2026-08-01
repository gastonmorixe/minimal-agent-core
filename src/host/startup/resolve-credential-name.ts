/**
 * Credential-name precedence for startup / resume.
 *
 * CLI flag wins, then user config, then the pin recorded on the session
 * being resumed. That last fallback is what lets `--resume` keep using the
 * same OAuth / API-key account without re-passing `--credential-name`.
 *
 * Resume pins are **provider-scoped**: `meta.credentialName` is only reused
 * when the session's `meta.provider` is absent (legacy) or matches the
 * effective selected provider. Credential names are per-provider store keys
 * (e.g. `grok-oauth-2` is meaningless under `cursor`).
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
  /** `meta.provider` from the session being resumed, when any. */
  resumeProviderId?: string
  /** Effective provider selected for this run (after CLI / config / env). */
  selectedProviderId?: string
}

/** Why a resume credential pin was ignored (provider mismatch). */
export interface ResumePinSkipped {
  pin: string
  sessionProvider: string
  selectedProvider: string
}

/** Result of {@link resolveCredentialName}. */
export type ResolveCredentialNameResult = {
  credentialName?: string
  resumePinSkipped?: ResumePinSkipped
}

/** Pin fields peeked from a `--resume` target's session meta. */
export type ResumeCredentialPin = {
  credentialName?: string
  providerId?: string
}

/**
 * Pick the effective credential name for auth resolution.
 * Returns `credentialName: undefined` when nothing is pinned (provider
 * default displayName). When a resume pin is ignored because the session
 * provider differs from the selected provider, `resumePinSkipped` is set
 * so startup can print a dim notice.
 */
export function resolveCredentialName(
  input: ResolveCredentialNameInput,
): ResolveCredentialNameResult {
  const cli = input.cliCredentialName?.trim()
  if (cli) return { credentialName: cli }

  const config = input.configCredentialName?.trim()
  if (config) return { credentialName: config }

  const resume = input.resumeCredentialName?.trim()
  if (!resume) return {}

  const sessionProvider = input.resumeProviderId?.trim()
  const selected = input.selectedProviderId?.trim()
  // Legacy sessions omit meta.provider — keep the pin (compat).
  // When both are known and differ, the pin is not valid for this provider.
  if (sessionProvider && selected && sessionProvider !== selected) {
    return {
      resumePinSkipped: {
        pin: resume,
        sessionProvider,
        selectedProvider: selected,
      },
    }
  }

  return { credentialName: resume }
}

/**
 * Best-effort read of credential pin fields for a `--resume` target.
 * Returns an empty object when not resuming, the sid is unknown, or meta
 * has no pin/provider (legacy sessions). Never throws.
 */
export function peekResumeCredentialPin(
  resumeArg: string | undefined,
  cwd: string = process.cwd(),
): ResumeCredentialPin {
  if (!resumeArg) return {}
  try {
    const sid = resolveSessionTarget(resumeArg, cwd)
    if (!sid) return {}
    const meta = loadSession(sid).meta
    const credentialName = meta?.credentialName?.trim() || undefined
    const providerId = meta?.provider?.trim() || undefined
    return {
      ...(credentialName ? { credentialName } : {}),
      ...(providerId ? { providerId } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Best-effort read of `meta.credentialName` for a `--resume` target.
 * @deprecated Prefer {@link peekResumeCredentialPin}.
 */
export function peekResumeCredentialName(
  resumeArg: string | undefined,
  cwd: string = process.cwd(),
): string | undefined {
  return peekResumeCredentialPin(resumeArg, cwd).credentialName
}
