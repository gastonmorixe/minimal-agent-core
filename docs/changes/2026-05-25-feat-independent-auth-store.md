# feat: independent credential store (`~/.minimal-agent/auth.jsonc`)

**Date**: 2026-05-25
**Type**: feat
**Scope**: src/auth-store.ts (new store), src/auth.ts (rewire), src/oauth-login.ts /
src/client.ts / src/commands/{login,logout,auth-status}.ts / src/index.ts
(consumers), src/auth-store.test.ts (new) + updated auth/oauth/logout/auth-status tests

## Problem

minimal-agent piggy-backed on the official Claude Code CLI's credential
storage:

- **Tokens** in the macOS Keychain generic-password entry
  `Claude Code-credentials` (read via `security find-generic-password`).
- **Account identity** (`oauthAccount.accountUuid` / org / email) in
  `~/.claude.json`, which `installCredentials` *merged* into and `--logout`
  *stripped* from.

That made minimal-agent a parasite on another tool's storage with three
concrete problems:

1. **Shared fate.** `--logout` deleted the *shared* keychain entry — logging
   you out of the official `claude` CLI too. A refresh by one tool rotated
   tokens under the other.
2. **No room for other providers.** The schema was hard-coded to "first-party
   Anthropic OAuth". There was nowhere to put credentials for a provider that
   authenticates differently (API key, device-code, cloud STS, mTLS, …).
3. **Keychain-only.** No path off macOS.

minimal-agent is heading toward many providers, each implemented by an **auth
plugin** rather than hard-coded. A store baked to one provider's shape would
need rewriting for the next.

## Goals

- A credential store minimal-agent **owns**: `~/.minimal-agent/auth.jsonc`. No
  reads or writes of the Keychain or `~/.claude.json`. Fully independent of the
  official CLI.
- A schema that knows **nothing** about any provider's credential shape — a
  namespaced key/value vault an auth plugin can write to and read from.
- Built for multiple providers and multiple accounts per provider, matched by a
  stable slug.

## Design

### Store (`src/auth-store.ts`)

A provider-agnostic vault. File format (schema v1):

```jsonc
{
  "version": 1,
  "entries": [
    {
      "id": "anthropic-plan-oauth",      // provider slug (normalized)
      "name": "Anthropic Plan (OAuth)",  // display name; unique within id
      "secrets": { /* opaque, plugin-owned */ },
      "createdAt": "…", "updatedAt": "…"
    }
  ]
}
```

- **`id`** — lowercase dash-case ASCII slug (`anthropic-plan-oauth`,
  `openai-api-key`). Case-insensitive, normalized to lowercase. The stable
  identifier a future auth plugin matches on.
- **`name`** — human label shown in a TUI. The pair **`(id, name)`** is the
  unique key: a slug may appear in multiple entries with different names (e.g.
  two enterprise logins for two orgs), but never the same `(id, name)` twice.
- **`secrets`** — an opaque JSON object. The store persists/returns it
  verbatim and never reads a field; its shape is owned entirely by the writer.

API: `list / get / getSecrets / has / set / patch / remove / clear`. Name-less
`get`/`remove` succeed for a single-entry slug and throw on ambiguity (so a
caller can't silently grab the wrong account). No in-memory cache — every call
reads the file fresh, which keeps a long-lived instance correct when another
process rewrites it under the refresh lock.

Persistence: atomic write (temp file + `rename(2)`), mode **0600**, parent dir
auto-created, `parseJsonc` read (tolerates comments + trailing commas). A
corrupt file is a hard `AuthStoreError`, not a silent reset — we never quietly
discard tokens.

### The one current provider (`src/auth.ts`)

`auth.ts` is, for now, the sole consumer and plays the role of the one
provider: slug `anthropic-plan-oauth`, name `Anthropic Plan (OAuth)`. It owns
a small codec (`credentialsToSecrets` / `secretsToCredentials`) between the
opaque bag and the internal `CredentialsData` shape its consumers already use,
plus store-backed `readCredentials` / `writeCredentials` / `clearCredentials`.
`getAuth`'s well-tested refresh path is unchanged in shape; only its
read/write defaults now point at the store, account uuid comes from the store
(not `~/.claude.json`), the refresh lock is keyed by provider id, and error
copy no longer references `claude`. When auth becomes a plugin surface, this
provider-specific code moves into a plugin and the store doesn't change.

## Migration

Non-destructive. The existing shared Keychain entry and `~/.claude.json` are
**left untouched** (the official `claude` CLI keeps working); minimal-agent
simply stops consulting them. The store starts empty, so the user re-logs in
once (`minimal-agent --login`) and `auth.jsonc` is created.

## Alternatives considered

- **Reuse `~/.claude/.credentials.json`** (the official CLI's Linux plaintext
  fallback) — rejected: that's still *sharing*, just in a file. Was tried and
  reverted in May 2026 (`752acf2` → `05cc719`).
- **Encrypt at rest / OS keychain backend** — out of scope. The file is a
  human-readable `.jsonc` by request; 0600 perms are the protection. A future
  encrypted backend can slot in behind the same `AuthStore` API.
- **One entry per provider (map keyed by slug)** — rejected: can't represent
  the "same plugin, two accounts" case. `(id, name)` composite key does.

## Known remaining coupling

`src/metadata.ts` still reads `~/.claude.json`'s `userID` to derive the request
`device_id` header. That's request fingerprinting, not credentials, so it was
left as-is. Total independence from `~/.claude.json` would require migrating
that into the store too.

## Tests

- `src/auth-store.test.ts` — 19 cases: slug normalization/validation, name
  uniqueness + same-slug multi-entry, upsert/patch/remove/clear, ambiguity
  guards, opaque-secret round-trip, 0600 + banner persistence, JSONC tolerance,
  corruption + duplicate-entry rejection.
- Updated `auth.test.ts` (store round-trip replaces the keychain-read tests;
  all refresh tests unchanged), `oauth-login.test.ts` (install → store),
  `logout.test.ts` (store clear), `auth-status.test.ts` (store read).
