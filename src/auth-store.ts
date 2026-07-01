/**
 * Independent credential store for minimal-agent.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  WHY THIS EXISTS
 * ───────────────────────────────────────────────────────────────────────────
 * minimal-agent owns its credentials in a single self-owned file:
 *
 *     ~/.minimal-agent/auth.jsonc
 *
 * This is the sole credential source. It is not shared with, and does not
 * read or fall back to, any other tool's storage. There is one place to put
 * credentials for every provider, OAuth or API-key alike, keyed by slug.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  DESIGN GOALS (and the future this is built for)
 * ───────────────────────────────────────────────────────────────────────────
 * Today minimal-agent has exactly one provider — Anthropic, authenticated via
 * the Claude Pro/Max subscription OAuth flow. Tomorrow it will have many, and
 * each will be implemented by an **auth plugin** rather than hard-coded here.
 * Different providers authenticate in wildly different ways (OAuth bearer
 * tokens, refreshable token pairs, long-lived API keys, device-code grants,
 * cloud STS credentials, mTLS client certs, …). A store that bakes in the
 * shape of any one of them would have to be rewritten for the next.
 *
 * So this store deliberately knows **nothing** about credentials. It is a
 * namespaced key/value vault:
 *
 *   - A provider is identified by a **slug** (`id`) — lowercase, dash-joined
 *     ASCII words (`anthropic`, `anthropic-plan-oauth`, `openai-api-key`).
 *     Slugs are case-insensitive and normalized to lowercase on the way in.
 *     A future auth plugin "claims" a slug and owns everything stored under
 *     it; the matching between a stored entry and the plugin that understands
 *     it happens purely by slug.
 *
 *   - Because one plugin may be used more than once with different
 *     credentials (e.g. two Anthropic Enterprise OAuth logins for two orgs),
 *     a slug may appear in **multiple entries**, disambiguated by a
 *     human-facing **`name`** ("Anthropic Enterprise (OAuth)",
 *     "Anthropic Enterprise (OAuth) 2"). The pair `(id, name)` is the unique
 *     key of an entry. Two entries may share an `id`; they may NOT share both
 *     `id` and `name`. The `name` is what a TUI shows; the `id` is the stable
 *     machine identifier a plugin matches on.
 *
 *   - Each entry carries an opaque **`secrets`** bag: a JSON object whose
 *     internal shape is entirely the owning plugin's business. This store
 *     persists and returns it verbatim; it never inspects, validates, or
 *     depends on any field inside it. (The only constraints are that it must
 *     be a JSON object and must round-trip through `JSON.stringify`.)
 *
 * The single provider that exists right now ("anthropic-plan-oauth", see
 * `auth.ts`) is just the first consumer of this generic store — it stores its
 * OAuth access/refresh tokens, expiry, scopes, and account/org ids as the
 * fields of one entry's secret bag. When auth becomes a plugin surface, that
 * code moves into a plugin and this store does not change.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  FILE FORMAT  (~/.minimal-agent/auth.jsonc, schema version 1)
 * ───────────────────────────────────────────────────────────────────────────
 *   \{
 *     "version": 1,
 *     "entries": [
 *       \{
 *         "id": "anthropic-plan-oauth",      // provider slug (normalized)
 *         "name": "Anthropic Plan (OAuth)",  // display name; unique within id
 *         "secrets": \{ ...opaque, plugin-owned... \},
 *         "createdAt": "2026-05-25T23:00:00.000Z",
 *         "updatedAt": "2026-05-25T23:00:00.000Z"
 *       \}
 *     ]
 *   \}
 *
 * It is a `.jsonc` file: it carries a leading comment banner documenting what
 * it is. The file is **machine-managed** — every save regenerates it, so the
 * banner is fixed and hand-edited comments do not survive a write. Comments
 * and trailing commas are tolerated on read (via {@link parseJsonc}) so a
 * user poking at the file by hand won't brick their login.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  PERSISTENCE & CONCURRENCY
 * ───────────────────────────────────────────────────────────────────────────
 * Writes are atomic: serialize to a per-process temp file then `rename(2)`
 * into place (same-filesystem rename is atomic on POSIX), so a concurrent
 * reader sees either the whole old file or the whole new one, never a
 * half-written blob. The file is created mode 0600 (owner read/write only).
 * This is plaintext at rest by design (it must be a readable `.jsonc`); the
 * 0600 bit, not encryption, is the protection. A future encrypted backend
 * can slot in behind the same API.
 *
 * This store does NOT lock across processes — that is the caller's job where
 * it matters. `auth.ts` already serializes token refreshes through a
 * `withLock(~/.minimal-agent/.refresh-<id>.lock)` advisory lock and re-reads
 * the store under it, which is exactly the mutation that races between
 * concurrent agents. All other mutations (login, logout) are interactive and
 * single-process.
 *
 * @module auth-store
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/plugin-api/utils/agent-paths"

import { parseJsonc } from "./jsonc.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Any JSON-serializable value. The store persists these verbatim. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

/**
 * The opaque per-entry secret bag. Its shape is owned entirely by the auth
 * plugin (today: `auth.ts`) that wrote it; this store never reads a field.
 */
export type SecretBag = { [k: string]: JsonValue }

/** A full stored entry, including its secret bag. */
export interface AuthEntry {
  /** Provider slug, normalized to lowercase dash-case. */
  id: string
  /** Human-facing display name. Unique within a given `id`. */
  name: string
  /** Opaque, plugin-owned credential data. */
  secrets: SecretBag
  /** ISO-8601 timestamp of first creation. */
  createdAt: string
  /** ISO-8601 timestamp of the last write. */
  updatedAt: string
}

/** A summary of an entry WITHOUT its secrets — safe to log / show in a TUI. */
export type AuthEntryRef = Omit<AuthEntry, "secrets">

/** Current on-disk schema. `version` gates any future migration. */
interface AuthFileV1 {
  version: 1
  entries: AuthEntry[]
}

const SCHEMA_VERSION = 1 as const

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown for all store-level problems: invalid slug/name, non-object secrets,
 * or a corrupt file. Kept as a distinct class so callers can `instanceof`
 * it and render a friendlier message (e.g. "delete the file and re-login").
 */
export class AuthStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "AuthStoreError"
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Slug grammar: one or more lowercase-ASCII-alphanumeric words joined by
 * single dashes. No leading/trailing/double dashes, no spaces, no unicode.
 * Examples: `anthropic`, `anthropic-plan-oauth`, `openai-api-key`.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Normalize and validate a provider slug. Case-insensitive: input is lowered
 * and trimmed before validation, so `"Anthropic"` and `"anthropic"` map to
 * the same id. Throws {@link AuthStoreError} on anything that isn't a clean
 * dash-case ASCII slug.
 */
export function normalizeProviderId(raw: string): string {
  const id = raw.trim().toLowerCase()
  if (!SLUG_RE.test(id)) {
    throw new AuthStoreError(
      `Invalid provider id ${JSON.stringify(raw)}: expected lowercase dash-case ASCII ` +
        `(e.g. "acme-plan-oauth"), matching ${SLUG_RE}`,
    )
  }
  return id
}

/** Validate a display name: non-empty after trimming. Returns the trimmed value. */
function normalizeName(raw: string): string {
  const name = raw.trim()
  if (name.length === 0) {
    throw new AuthStoreError("Invalid provider name: must be a non-empty string")
  }
  return name
}

/** Case-insensitive name comparison used for `(id, name)` uniqueness. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Validate that `secrets` is a plain JSON object and return a deep,
 * JSON-safe clone of it. The round-trip both enforces serializability
 * (functions, undefined, BigInt, circular refs all throw) and decouples the
 * stored copy from the caller's mutable object.
 */
function cloneSecrets(secrets: unknown): SecretBag {
  if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new AuthStoreError("secrets must be a JSON object (got " + describe(secrets) + ")")
  }
  try {
    return JSON.parse(JSON.stringify(secrets)) as SecretBag
  } catch (err) {
    throw new AuthStoreError("secrets must be JSON-serializable", { cause: err })
  }
}

function describe(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  return typeof v
}

// ---------------------------------------------------------------------------
// Default path
// ---------------------------------------------------------------------------

/**
 * Resolve the auth file path. Defaults to `~/.minimal-agent/auth.jsonc`;
 * override with `MINIMAL_AGENT_AUTH_FILE` (used by tests and by anyone who
 * keeps their dotfiles somewhere unusual).
 */
export function defaultAuthFilePath(): string {
  const override = process.env.MINIMAL_AGENT_AUTH_FILE?.trim()
  if (override) return override
  return join(resolveAgentHome(), "auth.jsonc")
}

/** Leading banner regenerated into the file on every save. */
const FILE_BANNER = `// minimal-agent credential store — DO NOT edit by hand while the agent is running.
//
// This file is managed by minimal-agent (src/auth-store.ts). It is a namespaced
// key/value vault: each entry is keyed by a provider "id" (slug) plus a display
// "name", and carries an opaque "secrets" object owned by that provider's auth
// plugin. The store never interprets the contents of "secrets".
//
// Permissions are 0600 (owner-only). Tokens are stored in plaintext here by
// design; protect the file, not the bytes. Comments and trailing commas are
// tolerated on read but this banner is rewritten on every save.
`

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface AuthStoreOptions {
  /** Override the file path (defaults to {@link defaultAuthFilePath}). */
  path?: string
  /** Injectable clock for deterministic timestamps in tests. */
  now?: () => number
}

/**
 * Provider-agnostic credential vault backed by a single `.jsonc` file.
 *
 * The class holds no in-memory cache: every public method reads the file
 * fresh, mutates, and (for writes) atomically rewrites it. This keeps a
 * long-lived `AuthStore` instance correct in the face of another process
 * (or the refresh lock holder) having changed the file underneath it —
 * important for the multi-agent token-refresh path in `auth.ts`.
 */
export class AuthStore {
  readonly path: string
  private readonly now: () => number

  constructor(opts: AuthStoreOptions = {}) {
    this.path = opts.path ?? defaultAuthFilePath()
    this.now = opts.now ?? Date.now
  }

  // ── reads ────────────────────────────────────────────────────────────

  /**
   * List entry summaries (no secrets). Optionally filter to a single
   * provider slug. Order matches file order (insertion order).
   */
  list(providerId?: string): AuthEntryRef[] {
    const id = providerId !== undefined ? normalizeProviderId(providerId) : undefined
    return this.load()
      .entries.filter((e) => id === undefined || e.id === id)
      .map(({ secrets: _secrets, ...ref }) => ref)
  }

  /**
   * Resolve a single entry. When `name` is omitted, succeeds only if the
   * slug has exactly one entry (the common single-account case); throws if
   * the slug is ambiguous (multiple entries) so callers can't silently grab
   * the wrong account. Returns `null` when no matching entry exists.
   */
  get(providerId: string, name?: string): AuthEntry | null {
    const id = normalizeProviderId(providerId)
    const matches = this.load().entries.filter((e) => e.id === id)
    if (name !== undefined) {
      const wanted = normalizeName(name)
      return matches.find((e) => sameName(e.name, wanted)) ?? null
    }
    if (matches.length === 0) return null
    if (matches.length > 1) {
      throw new AuthStoreError(
        `Provider ${JSON.stringify(id)} has ${matches.length} entries ` +
          `(${matches.map((e) => JSON.stringify(e.name)).join(", ")}); ` +
          `specify a name to disambiguate`,
      )
    }
    return matches[0] ?? null
  }

  /** Convenience: the opaque secret bag of an entry, or `null` if absent. */
  getSecrets(providerId: string, name?: string): SecretBag | null {
    return this.get(providerId, name)?.secrets ?? null
  }

  /** Whether an entry exists for `(providerId, name?)`. */
  has(providerId: string, name?: string): boolean {
    return this.get(providerId, name) !== null
  }

  // ── writes ───────────────────────────────────────────────────────────

  /**
   * Suggest a free credential name for `providerId` based on `baseName`.
   *
   * When `baseName` is not taken, returns it as-is (first login uses the
   * provider's displayName). When taken, generates `{serviceId}-2`,
   * `{serviceId}-3`, etc. using the provider slug (already a clean
   * dash-separated identifier) so auto-generated names are CLI-friendly.
   *
   * Case-insensitive collision check (uses `sameName`).
   */
  suggestCredentialName(providerId: string, baseName: string): string {
    const id = normalizeProviderId(providerId)
    const base = normalizeName(baseName)
    const file = this.load()
    const taken = new Set<string>()
    for (const e of file.entries) {
      if (e.id === id) taken.add(e.name.toLowerCase())
    }
    // First login: use the displayName if free
    if (!taken.has(base.toLowerCase())) return base
    // Subsequent: use {serviceId}-2, {serviceId}-3, ...
    // Cap at 100 to avoid unbounded loops; if someone has 100+ credentials
    // for one provider the fallback uses a timestamp suffix.
    for (let i = 2; i <= 100; i++) {
      const candidate = `${id}-${i}`
      if (!taken.has(candidate.toLowerCase())) return candidate
    }
    return `${id}-${Date.now()}`
  }

  /**
   * Upsert an entry. Creates `(id, name)` if absent, or replaces the secret
   * bag of an existing one (preserving its `createdAt`). The `(id, name)`
   * pair is the unique key: two entries may share a slug only if their names
   * differ. Returns the stored entry.
   */
  set(providerId: string, name: string, secrets: SecretBag): AuthEntry {
    const id = normalizeProviderId(providerId)
    const displayName = normalizeName(name)
    const bag = cloneSecrets(secrets)
    const ts = new Date(this.now()).toISOString()

    const file = this.load()
    const idx = file.entries.findIndex((e) => e.id === id && sameName(e.name, displayName))
    let entry: AuthEntry
    if (idx >= 0) {
      const prev = file.entries[idx]!
      entry = { id, name: displayName, secrets: bag, createdAt: prev.createdAt, updatedAt: ts }
      file.entries[idx] = entry
    } else {
      entry = { id, name: displayName, secrets: bag, createdAt: ts, updatedAt: ts }
      file.entries.push(entry)
    }
    this.save(file)
    return entry
  }

  /**
   * Shallow-merge `partial` into an existing entry's secret bag. Keys present
   * in `partial` overwrite; keys absent from `partial` are preserved. If the
   * entry doesn't exist yet, behaves like {@link set} with `partial` as the
   * full bag. Used by the token-refresh path, which only wants to update
   * `accessToken`/`refreshToken`/`expiresAt` without disturbing scopes,
   * account ids, etc.
   */
  patch(providerId: string, name: string, partial: SecretBag): AuthEntry {
    const existing = this.get(providerId, name)
    const merged: SecretBag = { ...(existing?.secrets ?? {}), ...cloneSecrets(partial) }
    return this.set(providerId, name, merged)
  }

  /**
   * Remove an entry. With `name` omitted, removes the sole entry for the slug
   * (throwing on ambiguity, like {@link get}). Returns `true` if something
   * was removed, `false` if there was nothing to remove (idempotent).
   */
  remove(providerId: string, name?: string): boolean {
    const id = normalizeProviderId(providerId)
    const file = this.load()
    const before = file.entries.length

    if (name !== undefined) {
      const wanted = normalizeName(name)
      file.entries = file.entries.filter((e) => !(e.id === id && sameName(e.name, wanted)))
    } else {
      const matches = file.entries.filter((e) => e.id === id)
      if (matches.length > 1) {
        throw new AuthStoreError(
          `Provider ${JSON.stringify(id)} has ${matches.length} entries; ` +
            `specify a name to remove a specific one`,
        )
      }
      file.entries = file.entries.filter((e) => e.id !== id)
    }

    if (file.entries.length === before) return false
    this.save(file)
    return true
  }

  /**
   * Wipe the entire store by deleting the file. Idempotent. Use for a full
   * sign-out / reset; use {@link remove} to drop a single provider entry.
   */
  clear(): void {
    try {
      rmSync(this.path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
    }
  }

  // ── persistence ──────────────────────────────────────────────────────

  /**
   * Read + parse the file. A missing file is an empty store. A present but
   * unparseable/invalid file is a hard error ({@link AuthStoreError}) rather
   * than a silent reset — we never want to quietly throw away someone's
   * tokens; loud failure lets them inspect or delete the file deliberately.
   */
  private load(): AuthFileV1 {
    let raw: string
    try {
      raw = readFileSync(this.path, "utf-8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { version: SCHEMA_VERSION, entries: [] }
      }
      throw new AuthStoreError(`Could not read auth store at ${this.path}`, { cause: err })
    }

    let parsed: unknown
    try {
      parsed = parseJsonc(raw)
    } catch (err) {
      throw new AuthStoreError(
        `Auth store at ${this.path} is corrupt (invalid JSONC). ` +
          `Inspect or delete it and run \`minimal-agent --login\` to re-create it.`,
        { cause: err },
      )
    }
    return this.coerce(parsed)
  }

  /** Validate the parsed document into a well-formed {@link AuthFileV1}. */
  private coerce(parsed: unknown): AuthFileV1 {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AuthStoreError(`Auth store at ${this.path} is not a JSON object`)
    }
    const doc = parsed as Record<string, unknown>
    const rawEntries = doc.entries
    if (rawEntries !== undefined && !Array.isArray(rawEntries)) {
      throw new AuthStoreError(`Auth store at ${this.path}: "entries" must be an array`)
    }
    const entries: AuthEntry[] = []
    for (const raw of (rawEntries as unknown[]) ?? []) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new AuthStoreError(`Auth store at ${this.path}: each entry must be an object`)
      }
      const e = raw as Record<string, unknown>
      if (typeof e.id !== "string" || typeof e.name !== "string") {
        throw new AuthStoreError(`Auth store at ${this.path}: entry missing string id/name`)
      }
      const id = normalizeProviderId(e.id)
      const name = normalizeName(e.name)
      const secrets = cloneSecrets(e.secrets ?? {})
      const createdAt = typeof e.createdAt === "string" ? e.createdAt : new Date(0).toISOString()
      const updatedAt = typeof e.updatedAt === "string" ? e.updatedAt : createdAt
      // Defend against a duplicate (id,name) sneaking into a hand-edited file.
      if (entries.some((p) => p.id === id && sameName(p.name, name))) {
        throw new AuthStoreError(
          `Auth store at ${this.path}: duplicate entry for id ${JSON.stringify(id)} ` +
            `name ${JSON.stringify(name)}`,
        )
      }
      entries.push({ id, name, secrets, createdAt, updatedAt })
    }
    return { version: SCHEMA_VERSION, entries }
  }

  /**
   * Atomically write the document: serialize (banner + pretty JSON), write to
   * a unique temp file in the same directory mode 0600, then `rename(2)` over
   * the target. Creates the parent directory on first write.
   */
  private save(file: AuthFileV1): void {
    const dir = dirname(this.path)
    // Create the credential directory owner-only (0o700) to match the 0600
    // secrets file. mkdirSync's mode is masked by umask and only applies to
    // dirs it creates, so tighten the leaf dir afterward to also fix an
    // already-existing loose dir. Best-effort: a chmod failure on a dir we do
    // not own must not crash auth.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dir, 0o700)
    } catch {
      // best-effort: cannot tighten a dir we do not own; leave as-is
    }
    const body = JSON.stringify({ version: SCHEMA_VERSION, entries: file.entries }, null, 2)
    const text = `${FILE_BANNER}${body}\n`
    const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    try {
      writeFileSync(tmp, text, { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch (err) {
      try {
        rmSync(tmp)
      } catch {
        // best-effort temp cleanup
      }
      throw new AuthStoreError(`Could not write auth store at ${this.path}`, { cause: err })
    }
  }
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

let _default: AuthStore | undefined

/**
 * Process-wide default store at {@link defaultAuthFilePath}. Lazily created so
 * the `MINIMAL_AGENT_AUTH_FILE` override is read at first use, not import time.
 */
export function defaultAuthStore(): AuthStore {
  if (!_default) _default = new AuthStore()
  return _default
}

/** Reset the lazy default store after tests change MINIMAL_AGENT_AUTH_FILE. */
export function resetDefaultAuthStoreForTests(): void {
  _default = undefined
}
