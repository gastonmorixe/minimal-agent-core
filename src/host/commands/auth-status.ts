/**
 * `minimal-agent --auth-status` command.
 *
 * Reads minimal-agent's credential store (`~/.minimal-agent/auth.jsonc`,
 * without refreshing) and prints a compact, human-readable summary per
 * provider with resolvable credentials.
 *
 * Returns exit code 0 when at least one provider is logged in, 1 otherwise.
 *
 * @module commands/auth-status
 */

import { defaultAuthStore } from "../../auth/auth-store.ts"
import {
  type CredentialedProvider,
  clearProviderCredentials,
  discoverCredentialedProviders,
  tryResolveProviderAuth,
} from "../../auth/auth-strategies.ts"
import type { ProviderAuth } from "../../llm/provider.ts"
import { findProviderPlugin } from "../../llm/provider-plugin.ts"
import {
  renderAuthPruneMarkdown,
  renderAuthPruneRows,
  renderAuthStatusMarkdown,
  renderAuthStatusRows,
} from "../ui/chrome/auth-status.ts"
import { writeCommandRows } from "../ui/command-output.ts"

export interface AuthStatusDeps {
  /** Override credential discovery (tests). */
  discover?: () => CredentialedProvider[]
  /** Override per-credential auth resolution (tests). */
  resolveAuth?: (providerId: string, credentialName?: string) => ProviderAuth | null
  /** Where rows go (defaults to stderr). */
  output?: { write: (s: string) => void }
  /** Inject "now" for deterministic expiry rendering. */
  now?: () => number
  /** Print the Markdown pipe table instead of the human rows. */
  table?: boolean
}

export interface AuthStatusRefreshDeps extends AuthStatusDeps {
  /** Credential name or provider id to refresh. */
  credential: string
  /** Disambiguator when one credential name spans providers. */
  providerId?: string
}

export interface AuthStatusRefreshAllDeps extends AuthStatusDeps {
  /** Max parallel refresh workers (default 4, max 8). */
  parallel?: number
}

export interface AuthStatusPruneDeps extends AuthStatusDeps {
  /** Dry run: list verdicts only, delete nothing. */
  dryRun?: boolean
  /** Delete dead entries by exact (providerId, credentialName). */
  force?: boolean
  /** Max parallel probe workers (default 4, max 8). */
  parallel?: number
  /** Override credential deletion (tests). Defaults to clearProviderCredentials. */
  clearCredentials?: typeof clearProviderCredentials
  /**
   * Injected API-key liveness probe (tests). Resolves true on 2xx,
   * rejects with a status-tagged error on failure. Core never fetches
   * provider endpoints itself. Defaults to the plugin listLiveModels
   * probe with a 10s timeout.
   */
  probeApiKey?: (providerId: string, auth: ProviderAuth) => Promise<void>
}

export type AuthPruneVerdict = "dead" | "live" | "unknown"

/** Mask an API key as first 5 plus last 2 chars. Never emits the full key. */
export function maskApiKey(key: string): string {
  if (key.length <= 7) return `${key}…`
  return `${key.slice(0, 5)}…${key.slice(-2)}`
}

function pruneHttpStatus(err: unknown): number | undefined {
  if (err instanceof Error) {
    const m = err.message.match(/\b(\d{3})\b/)
    if (m) {
      const code = Number.parseInt(m[1] as string, 10)
      if (Number.isFinite(code)) return code
    }
  }
  const nested = (err as { status?: unknown; statusCode?: unknown })?.status
  if (typeof nested === "number" && Number.isFinite(nested)) return nested
  const nestedCode = (err as { statusCode?: unknown })?.statusCode
  if (typeof nestedCode === "number" && Number.isFinite(nestedCode)) return nestedCode
  return undefined
}

function isInvalidGrant(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("invalid_grant")
}

function isTimeoutOrNetwork(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("abort") ||
    msg.includes("econn") ||
    msg.includes("enotfound") ||
    msg.includes("socket") ||
    msg.includes("network")
  )
}

/**
 * Default API-key liveness probe. Uses the provider plugin's
 * listLiveModels hook with a 10s timeout. Dead on 401, live on
 * resolution, unknown otherwise. Never logs the key.
 */
async function defaultProbeApiKey(providerId: string, auth: ProviderAuth): Promise<void> {
  const plugin = findProviderPlugin(providerId)
  if (typeof plugin?.listLiveModels !== "function") {
    throw new Error("no live models probe available (manual check needed)")
  }
  const hook = plugin.listLiveModels.bind(plugin)
  await Promise.race([
    hook(auth),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("probe timeout after 10s")), 10_000),
    ),
  ])
}

interface PruneCheckResult {
  verdict: AuthPruneVerdict
  note?: string
}

async function checkOnePruneEntry(
  entry: CredentialedProvider,
  auth: ProviderAuth | null,
  probeApiKey: (providerId: string, auth: ProviderAuth) => Promise<void>,
): Promise<PruneCheckResult> {
  if (!auth) return { verdict: "unknown", note: "credential unreadable" }
  if (auth.kind === "oauth") {
    if (typeof auth.refresh !== "function") {
      return { verdict: "unknown", note: "manual check needed" }
    }
    try {
      await auth.refresh()
      return { verdict: "live" }
    } catch (err) {
      if (isInvalidGrant(err)) return { verdict: "dead", note: "invalid_grant" }
      return { verdict: "unknown", note: shortReason(err) }
    }
  }
  if (auth.kind === "api-key") {
    try {
      await probeApiKey(entry.providerId, auth)
      return { verdict: "live" }
    } catch (err) {
      const status = pruneHttpStatus(err)
      if (status === 401) return { verdict: "dead", note: "401" }
      if (status === 429) return { verdict: "unknown", note: "429 rate limited" }
      if (status !== undefined && status >= 500) {
        return { verdict: "unknown", note: `${status} server error` }
      }
      if (isTimeoutOrNetwork(err)) return { verdict: "unknown", note: "timeout or network error" }
      return { verdict: "unknown", note: shortReason(err) }
    }
  }
  return { verdict: "unknown", note: "unsupported auth kind" }
}

/**
 * Prune dead stored credentials. Discovery order is kept; checks run
 * under a concurrency-limited pool. Dry run lists verdicts only.
 * --force deletes entries with verdict dead via exact
 * (providerId, credentialName). Never deletes live or unknown.
 * Never performs a browser login. Never writes tokens.
 * Returns 0 on a clean run, 1 on check or delete failure.
 */
export async function runAuthStatusPruneCommand(deps: AuthStatusPruneDeps = {}): Promise<number> {
  const out = deps.output ?? { write: (s: string) => process.stderr.write(s) }
  if (deps.dryRun === true && deps.force === true) {
    out.write("auth-status prune: use --dry-run or --force, not both\n")
    return 1
  }
  if (deps.dryRun !== true && deps.force !== true) {
    out.write("auth-status prune requires --dry-run or --force. Rerun with --dry-run or --force.\n")
    return 1
  }
  const modeForce = deps.force === true
  const discover = deps.discover ?? discoverCredentialedProviders
  const resolveAuth =
    deps.resolveAuth ??
    ((providerId: string, credentialName?: string) =>
      tryResolveProviderAuth(providerId, "", credentialName))
  const probeApiKey = deps.probeApiKey ?? defaultProbeApiKey

  const entries = discover()
  const limit = Math.min(8, Math.max(1, Math.floor(deps.parallel ?? 4)))
  const checks: (PruneCheckResult | undefined)[] = new Array(entries.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const index = cursor
      cursor += 1
      const entry = entries[index] as CredentialedProvider
      const auth = resolveAuth(entry.providerId, entry.credentialName)
      checks[index] = await checkOnePruneEntry(entry, auth, probeApiKey)
    }
  }
  const pool: Promise<void>[] = []
  for (let i = 0; i < Math.min(limit, Math.max(1, entries.length)); i += 1) {
    pool.push(worker())
  }
  await Promise.allSettled(pool)

  let checkFailures = 0
  const rows = entries.map((entry, index) => {
    const check = checks[index] ?? { verdict: "unknown" as const, note: "check failed" }
    if (checks[index] === undefined) checkFailures += 1
    const credentialName = entry.credentialName ?? entry.providerId
    const auth = resolveAuth(entry.providerId, entry.credentialName)
    const maskedKey =
      auth?.kind === "api-key" && typeof auth.key === "string" && auth.key.length > 0
        ? maskApiKey(auth.key)
        : undefined
    return {
      providerId: entry.providerId,
      credentialName,
      kind: entry.authKind,
      verdict: check.verdict,
      ...(check.note ? { note: check.note } : {}),
      ...(maskedKey ? { maskedKey } : {}),
    }
  })
  if (modeForce) {
    let deleteFailures = 0
    for (const [index, row] of rows.entries()) {
      if (row.verdict !== "dead") continue
      const entry = entries[index] as CredentialedProvider
      const clear = deps.clearCredentials ?? clearProviderCredentials
      try {
        const removed = clear(row.providerId, defaultAuthStore(), entry.credentialName)
        if (removed) {
          rows[index] = { ...row, note: [row.note, "deleted"].filter(Boolean).join("; ") }
        } else {
          rows[index] = {
            ...row,
            note: [row.note, "delete failed"].filter(Boolean).join("; "),
          }
          deleteFailures += 1
        }
      } catch (err) {
        rows[index] = {
          ...row,
          note: [row.note, `delete failed: ${shortReason(err)}`].filter(Boolean).join("; "),
        }
        deleteFailures += 1
      }
    }
    writeCommandRows(deps.table ? renderAuthPruneMarkdown(rows) : renderAuthPruneRows(rows), out)
    return deleteFailures + checkFailures === 0 ? 0 : 1
  }
  writeCommandRows(deps.table ? renderAuthPruneMarkdown(rows) : renderAuthPruneRows(rows), out)
  return checkFailures === 0 ? 0 : 1
}

/** Print the auth status rows and return `true` when any provider is logged in. */
export function renderAuthStatus(deps: AuthStatusDeps = {}): boolean {
  const out = deps.output ?? { write: (s: string) => process.stderr.write(s) }
  const now = deps.now ? deps.now() : Date.now()
  const discover = deps.discover ?? discoverCredentialedProviders
  const resolveAuth =
    deps.resolveAuth ??
    ((providerId: string, credentialName?: string) =>
      tryResolveProviderAuth(providerId, "", credentialName))

  const providers = discover()
  const views = providers.map((p) => ({
    providerId: p.providerId,
    displayName: p.displayName,
    authKind: p.authKind,
    source: p.source,
    credentialLabel: p.credentialLabel,
    credentialName: p.credentialName,
    credentialInfo: p.credentialInfo,
    updatedAt: p.updatedAt,
    auth: resolveAuth(p.providerId, p.credentialName),
  }))
  writeCommandRows(
    deps.table
      ? renderAuthStatusMarkdown({ providers: views, now })
      : renderAuthStatusRows({ providers: views, now }),
    out,
  )
  return providers.length > 0
}

/**
 * Run the auth-status command. Returns 0 when logged in, 1 otherwise.
 */
export async function runAuthStatusCommand(deps: AuthStatusDeps = {}): Promise<number> {
  return renderAuthStatus(deps) ? 0 : 1
}

function invalidGrantHint(err: unknown, providerId: string, credentialName?: string): unknown {
  const msg = err instanceof Error ? err.message : String(err)
  if (!msg.includes("invalid_grant")) return err
  const slot = credentialName ?? providerId
  return new Error(
    `${msg}\nThe stored refresh token for "${slot}" was rejected. ` +
      `Run \`minimal-agent provider ${providerId} login --name ${slot}\` to sign in again.`,
    { cause: err },
  )
}

function shortReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const first = msg.split("\n")[0] ?? msg
  return first.length > 80 ? `${first.slice(0, 77)}...` : first
}

function resolveRefreshTarget(
  entries: CredentialedProvider[],
  credential: string,
): CredentialedProvider[] {
  const byName = entries.filter((e) => e.credentialName === credential)
  if (byName.length > 0) return byName
  const byLabel = entries.filter((e) => e.credentialLabel === credential && !e.credentialName)
  if (byLabel.length > 0) return byLabel
  return entries.filter((e) => e.providerId === credential)
}

/**
 * Refresh one stored OAuth credential. Returns 0 on success, 1 on failure.
 * No console calls. Never prints tokens.
 */
export async function runAuthStatusRefreshCommand(deps: AuthStatusRefreshDeps): Promise<number> {
  const out = deps.output ?? { write: (s: string) => process.stderr.write(s) }
  const discover = deps.discover ?? discoverCredentialedProviders
  const resolveAuth =
    deps.resolveAuth ??
    ((providerId: string, credentialName?: string) =>
      tryResolveProviderAuth(providerId, "", credentialName))

  const entries = discover()
  let matches = resolveRefreshTarget(entries, deps.credential)
  if (deps.providerId) {
    matches = matches.filter((e) => e.providerId === deps.providerId)
  }
  if (matches.length === 0) {
    out.write(`no stored credential "${deps.credential}"\n`)
    return 1
  }
  if (matches.length > 1) {
    const ids = [...new Set(matches.map((e) => e.providerId))].join(", ")
    out.write(
      `ambiguous credential "${deps.credential}" matches providers: ${ids}. Use --provider <id>.\n`,
    )
    return 1
  }
  const entry = matches[0] as CredentialedProvider
  const auth = resolveAuth(entry.providerId, entry.credentialName)
  if (!auth) {
    out.write(`credential "${entry.credentialName ?? deps.credential}" unreadable\n`)
    return 1
  }
  if (auth.kind !== "oauth" || typeof auth.refresh !== "function") {
    out.write(`refresh not supported for "${entry.credentialName ?? deps.credential}"\n`)
    return 1
  }
  try {
    await auth.refresh()
  } catch (err) {
    const hinted = invalidGrantHint(err, entry.providerId, entry.credentialName)
    const msg = hinted instanceof Error ? hinted.message : String(hinted)
    out.write(`${msg.split("\n")[0]}\n`)
    const rest = msg.split("\n").slice(1)
    for (const line of rest) out.write(`${line}\n`)
    return 1
  }
  const refreshed = resolveAuth(entry.providerId, entry.credentialName)
  void refreshed
  const info = discover().find(
    (e) => e.providerId === entry.providerId && e.credentialName === entry.credentialName,
  )?.credentialInfo
  const expiry =
    info && typeof info.expiresAt === "number" && Number.isFinite(info.expiresAt)
      ? ` (expires ${new Date(info.expiresAt).toISOString()})`
      : ""
  out.write(`refreshed "${entry.credentialName ?? deps.credential}"${expiry}\n`)
  return 0
}

/**
 * Refresh every stored OAuth credential with a refresh hook.
 * Per row: refreshed, skipped-fresh, skipped-no-refresh, failed with reason.
 * Exit 0 only when zero failures.
 */
export async function runAuthStatusRefreshAllCommand(
  deps: AuthStatusRefreshAllDeps = {},
): Promise<number> {
  const out = deps.output ?? { write: (s: string) => process.stderr.write(s) }
  const now = deps.now ? deps.now() : Date.now()
  const discover = deps.discover ?? discoverCredentialedProviders
  const resolveAuth =
    deps.resolveAuth ??
    ((providerId: string, credentialName?: string) =>
      tryResolveProviderAuth(providerId, "", credentialName))

  const entries = discover()
  const limit = Math.min(8, Math.max(1, Math.floor(deps.parallel ?? 4)))
  const results: string[] = new Array(entries.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const index = cursor
      cursor += 1
      const entry = entries[index] as CredentialedProvider
      const name = entry.credentialName ?? entry.providerId
      const auth = resolveAuth(entry.providerId, entry.credentialName)
      if (!auth || auth.kind !== "oauth") {
        results[index] = `${entry.providerId} ${name}: skipped-no-refresh`
        continue
      }
      if (typeof auth.refresh !== "function") {
        results[index] = `${entry.providerId} ${name}: skipped-no-refresh`
        continue
      }
      const expiresAt = entry.credentialInfo?.expiresAt
      const fresh =
        typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt - now > 300_000
      if (fresh) {
        results[index] = `${entry.providerId} ${name}: skipped-fresh`
        continue
      }
      try {
        await auth.refresh()
        results[index] = `${entry.providerId} ${name}: refreshed`
      } catch (err) {
        const hinted = invalidGrantHint(err, entry.providerId, entry.credentialName)
        results[index] = `${entry.providerId} ${name}: failed ${shortReason(hinted)}`
      }
    }
  }
  const pool: Promise<void>[] = []
  for (let i = 0; i < Math.min(limit, Math.max(1, entries.length)); i += 1) {
    pool.push(worker())
  }
  await Promise.allSettled(pool)
  let failures = 0
  for (const line of results) {
    if (line === undefined) continue
    out.write(`${line}\n`)
    if (line.includes(": failed")) failures += 1
  }
  return failures === 0 ? 0 : 1
}
