/**
 * Credential store: platform-aware persistence for Claude Code OAuth tokens.
 *
 * The official `claude` CLI ships two backends and picks one at runtime
 * based on the host OS:
 *
 * - **macOS** → the system Keychain via `security find-generic-password` /
 *   `add-generic-password` (`KeychainBackend` below). Constructed at
 *   cli.pretty.js L238740-238761; service name is `Claude Code-credentials`
 *   (see `HE("-credentials")` at L238742 → L129869).
 * - **Linux, WSL, anything else** → a plaintext JSON file at
 *   `~/.claude/.credentials.json` with mode 0600 (`FileBackend` below).
 *   Mirrors the upstream "plaintext fallback" at cli.pretty.js L238956-238964.
 *
 * Both backends agree on the **payload shape** (`CredentialsData`):
 *
 *     {
 *       claudeAiOauth: {
 *         accessToken: "sk-ant-oat01-...",
 *         refreshToken: "sk-ant-ort01-...",
 *         expiresAt: 1774880291250,         // ms since epoch
 *         scopes: ["user:profile", ...],
 *         subscriptionType: "max",
 *         rateLimitTier: "default_claude_max_20x"
 *       }
 *     }
 *
 * `oauthAccount` (containing `accountUuid`) is **not** part of the credential
 * store — it lives in `~/.claude.json`. The keychain entry historically held
 * it on older CLI versions; the file backend has never stored it. `auth.ts`
 * falls back to `~/.claude.json` when `oauthAccount` is absent from the
 * store, so either layout works.
 *
 * Tests can construct backends directly (`new FileBackend(...)`) and inject
 * via the `CredentialStore` interface — there's no global mutable state.
 *
 * @module credential-store
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of the JSON stored by the credential store (regardless of backend).
 *
 * The CLI writes this via its credential store backend (L238956-238964 for
 * plaintext fallback, or keychain backend `BD7` at L238747-238758 for macOS).
 * Only `claudeAiOauth` is required. `oauthAccount` may appear on legacy
 * keychain entries written by older CLI versions; current versions store
 * the account block in `~/.claude.json` instead.
 */
export interface CredentialsData {
  apiKey?: string
  claudeAiOauth?: {
    accessToken: string
    refreshToken?: string
    /** Milliseconds since epoch when the access token expires */
    expiresAt?: number
    scopes?: string[]
    /** "pro" | "max" | "enterprise" | "team" — cached subscription type */
    subscriptionType?: string
    /** e.g. "default_claude_max_20x" — cached rate limit tier */
    rateLimitTier?: string
  }
  /**
   * Legacy field. New CLI versions write this into `~/.claude.json`.
   * Kept for backwards-read of older keychain entries; new writes by
   * minimal-agent do not populate it here.
   */
  oauthAccount?: {
    accountUuid?: string
    organizationUuid?: string
    displayName?: string
  }
}

/**
 * Persistence backend. Both reads and writes are synchronous because every
 * caller is already on a non-hot path (auth refresh, login, logout) and the
 * sync API keeps the callers simpler.
 */
export interface CredentialStore {
  /** Backend identifier, used for diagnostic messages ("keychain" or "file"). */
  readonly kind: "keychain" | "file"
  read(): CredentialsData | null
  write(data: CredentialsData): void
  /** Returns true if an entry existed and was removed. */
  delete(): boolean
}

// ---------------------------------------------------------------------------
// macOS Keychain backend
// ---------------------------------------------------------------------------

/**
 * Default keychain service name for first-party OAuth.
 * Constructed by `HE("-credentials")` at L238742 → `HE()` at L129869.
 * For non-custom `CLAUDE_CONFIG_DIR` installs this is always
 * `"Claude Code-credentials"`.
 */
export const DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials"

/**
 * Resolve `$USER` for the keychain `-a` (account) flag. Falls back to
 * `whoami` if the env var is missing (e.g. some CI runners).
 */
function resolveUser(): string {
  if (process.env.USER) return process.env.USER
  const r = Bun.spawnSync(["whoami"])
  return r.stdout.toString().trim()
}

/**
 * macOS Keychain backend. Shells out to the `security` CLI; the JSON
 * payload is stored as the "password" of a generic password entry. Reads
 * use `-w` (print password to stdout) and writes use delete-then-add
 * because `security` has no in-place update primitive.
 */
export class KeychainBackend implements CredentialStore {
  readonly kind = "keychain" as const
  constructor(readonly service: string = DEFAULT_KEYCHAIN_SERVICE) {}

  read(): CredentialsData | null {
    const result = Bun.spawnSync(["security", "find-generic-password", "-s", this.service, "-w"])
    if (result.exitCode !== 0) return null
    const raw = result.stdout.toString().trim()
    if (!raw) return null
    try {
      return JSON.parse(raw) as CredentialsData
    } catch {
      return null
    }
  }

  write(data: CredentialsData): void {
    const user = resolveUser()
    const json = JSON.stringify(data)
    // Delete-then-add: `security` has no atomic update.
    Bun.spawnSync(["security", "delete-generic-password", "-a", user, "-s", this.service])
    const result = Bun.spawnSync([
      "security",
      "add-generic-password",
      "-a",
      user,
      "-s",
      this.service,
      "-w",
      json,
    ])
    if (result.exitCode !== 0) {
      throw new Error(`Failed to write keychain: ${result.stderr.toString()}`)
    }
  }

  delete(): boolean {
    const user = resolveUser()
    const result = Bun.spawnSync([
      "security",
      "delete-generic-password",
      "-a",
      user,
      "-s",
      this.service,
    ])
    return result.exitCode === 0
  }
}

// ---------------------------------------------------------------------------
// File backend (Linux + everything else)
// ---------------------------------------------------------------------------

/**
 * Default credentials file path used by the upstream CLI on Linux.
 * Confirmed empirically against `cc-03312026-2.1.88` and the on-disk file
 * a logged-in Linux Claude CLI install produces.
 */
export function defaultCredentialsFilePath(home: string = homedir()): string {
  return join(home, ".claude", ".credentials.json")
}

/**
 * Plaintext credentials backend. The official CLI writes the same shape
 * the keychain backend stores, just to a regular file with mode 0600.
 * We match: 0600 perms, parent directory auto-created if missing.
 *
 * The path defaults to `~/.claude/.credentials.json` but is overridable
 * for tests via the constructor argument.
 */
export class FileBackend implements CredentialStore {
  readonly kind = "file" as const
  constructor(readonly path: string = defaultCredentialsFilePath()) {}

  read(): CredentialsData | null {
    if (!existsSync(this.path)) return null
    let raw: string
    try {
      raw = readFileSync(this.path, "utf-8")
    } catch {
      return null
    }
    const trimmed = raw.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed) as CredentialsData
    } catch {
      return null
    }
  }

  write(data: CredentialsData): void {
    const dir = dirname(this.path)
    // mkdir is best-effort: if it already exists we move on, if it can't
    // be created the writeFileSync below surfaces a real error.
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const json = JSON.stringify(data)
    writeFileSync(this.path, json, { mode: 0o600 })
  }

  delete(): boolean {
    if (!existsSync(this.path)) return false
    try {
      unlinkSync(this.path)
      return true
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Platform-aware picker
// ---------------------------------------------------------------------------

/**
 * Pick the platform-appropriate backend. The upstream CLI uses the same
 * mapping (keychain on macOS, file fallback everywhere else), and we
 * keep parity so a user can switch between `claude` and `minimal-agent`
 * on the same machine without re-logging in.
 *
 * Override with `MINIMAL_AGENT_CREDENTIAL_STORE`:
 *   - `keychain` — force macOS keychain (errors on non-Darwin if invoked)
 *   - `file`     — force the plaintext file backend
 *
 * The env override exists mainly for tests and for users who have an
 * unusual setup (e.g. macOS with the keychain disabled, or a Linux box
 * using Apple's open-source `security` shim).
 */
export function pickCredentialStore(): CredentialStore {
  const override = process.env.MINIMAL_AGENT_CREDENTIAL_STORE?.toLowerCase().trim()
  if (override === "keychain") return new KeychainBackend()
  if (override === "file") return new FileBackend()
  if (process.platform === "darwin") return new KeychainBackend()
  return new FileBackend()
}

/**
 * Lazily-initialized default credential store. Memoized so callers all share
 * one backend instance per process — both for cheap reuse and so tests that
 * mutate `MINIMAL_AGENT_CREDENTIAL_STORE` after first use stay deterministic
 * (they'd need to call `resetDefaultCredentialStore()` to re-pick).
 */
let cachedDefault: CredentialStore | null = null

function defaultStore(): CredentialStore {
  if (!cachedDefault) cachedDefault = pickCredentialStore()
  return cachedDefault
}

/**
 * Drop the memoized default. Tests use this when they need
 * `pickCredentialStore` to re-evaluate `process.platform` or the
 * env override.
 */
export function resetDefaultCredentialStore(): void {
  cachedDefault = null
}

// ---------------------------------------------------------------------------
// Top-level convenience API
// ---------------------------------------------------------------------------

/**
 * Read credentials from the default backend. Returns `null` if no entry
 * exists, the entry is empty, or the stored JSON is malformed.
 */
export function readCredentials(): CredentialsData | null {
  return defaultStore().read()
}

/**
 * Persist credentials to the default backend. Used after a successful
 * token refresh or fresh login so other processes pick up the new tokens.
 */
export function writeCredentials(data: CredentialsData): void {
  defaultStore().write(data)
}

/**
 * Remove credentials from the default backend. Returns `true` when a
 * row/file was actually removed, `false` when there was nothing there.
 * Idempotent: calling twice in a row is safe.
 */
export function deleteCredentials(): boolean {
  return defaultStore().delete()
}
