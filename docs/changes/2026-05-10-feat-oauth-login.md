# OAuth login / logout / auth-status

**Date:** 2026-05-10
**Type:** feat
**Status:** landed
**Author:** Claude Code (Opus 4.7)

## Problem

`minimal-agent` has always *read* the macOS Keychain entry written by
the official `claude` CLI — never written it. Result: the only way to
acquire credentials, refresh a permanently-rejected refresh token, or
even check what account you're signed in as was to install and run the
official CLI alongside.

Concretely the user kept hitting:

```
error Token refresh failed: 401 after token refresh.
The keychain credentials are stale — run `claude` to re-login.
```

… and the suggested action requires the official CLI. That's a
hard dependency we'd like to remove for users who only use
`minimal-agent`. It also makes for a confusing first-run experience: a
fresh checkout with no keychain entry exits 1 with a "no credentials"
message and no inline path forward.

## Goals

1. **Sign in from inside `minimal-agent`** — `--login` runs the full
   PKCE OAuth flow against `platform.claude.com` and writes the
   keychain entry the same way the official CLI does.
2. **Sign out** — `--logout` clears the keychain entry and the
   `oauthAccount` mirror in `~/.claude.json`.
3. **Audit current state** — `--auth-status` prints account uuid,
   scopes, subscription type, expiry, refresh-token presence, exit code
   0 if logged in / 1 otherwise (script-friendly).
4. **First-run prompt** — when an interactive REPL hits "no
   credentials in keychain", offer an inline `Sign in now? [Y/n]`
   prompt that runs the OAuth flow and retries. Non-interactive
   (`--prompt`, piped stdin) keeps the existing fail-fast behavior.

## Non-goals

- **Not** rewriting the credential store. We continue to use the same
  macOS Keychain service `Claude Code-credentials` and the same
  `claudeAiOauth.{accessToken, refreshToken, expiresAt, scopes}` shape
  the official CLI uses. Co-existence with `claude` is preserved.
- **Not** an MCP / Console / API-key-creation command. The flow only
  acquires user-OAuth tokens; `org:create_api_key` scope is requested
  at sign-in (matching the upstream union scope set), but no Console
  API-key creation step happens.
- **Not** Linux / Windows. macOS Keychain is the only credential store
  the rest of `auth.ts` knows about.

## Options considered

### A. Localhost listener flow (matches official CLI's automatic flow)

`minimal-agent --login` would spawn a temporary HTTP server on a
random local port, set `redirect_uri=http://localhost:PORT/callback`,
open the user's browser, and capture the code via the redirect. No
copy-paste needed.

**Pros:** smoothest UX when running on the same host as the browser.

**Cons:**
- Pulls in `node:http` server lifecycle (`createServer`, port
  allocation, graceful close, error redirect on failure) — ~200 lines
  of new infrastructure.
- Doesn't work over SSH, in headless containers, in port-restricted
  networks, or anywhere the browser is on a *different* machine than
  the agent.
- Race conditions around port allocation and shutdown that the
  upstream CLI's `auth-code-listener.ts` spends 200 lines getting
  right.

### B. Manual-paste flow only (chosen)

`minimal-agent --login` builds the same authorize URL but with
`redirect_uri=https://platform.claude.com/oauth/code/callback`. The
auth server lands the user on a paste-back page that displays
`<authorizationCode>#<state>`. The user pastes that string back at
our prompt; we exchange it for tokens.

**Pros:**
- Works everywhere — SSH, containers, port-restricted networks, machine
  with no browser of its own (user opens the URL on a phone).
- One code path is simpler to reason about and test (the orchestrator
  has zero I/O beyond `readPaste`, `openUrl`, and the network client).
- No server lifecycle, no port allocation, no Ctrl-C cleanup.

**Cons:**
- One extra paste step vs the localhost listener.
- The user has to actually copy the code from the page (the upstream
  CLI eliminates this step in the auto-flow).

### C. Both (A and B simultaneously, official-CLI style)

Open the browser AND start a localhost listener AND offer manual paste
— whichever fires first wins. This is what the upstream CLI does in
`OAuthService.startOAuthFlow`.

**Pros:** maximally smooth UX.

**Cons:** all of A's complexity plus the coordination logic to
short-circuit one path when the other completes (`hasPendingResponse()`
checks, `manualAuthCodeResolver` rendezvous variable, etc.).

### Decision

**Option B (manual-paste only).** Headless / SSH / container support is
the deciding factor — it's the dominant use case for the kind of users
who pick `minimal-agent` over the official CLI in the first place. We
gain ~250 lines and lose one paste; that's a good trade. If the
localhost listener is requested later it slots in as an additional
`AuthCodeListener` dep on the orchestrator without changing the manual
path's contract.

## Design

```
src/oauth-login.ts            — pure logic, dep-injected I/O
  base64UrlEncode(buf)        — RFC 4648 §5
  generateCodeVerifier(rand)  — 32-byte → 43-char base64url
  generateCodeChallenge(v)    — SHA-256 → base64url
  generateState(rand)         — 32-byte → 43-char base64url
  buildAuthUrl(input)         — claude.com/cai/oauth/authorize URL
  parsePastedCode(raw)        — '<code>#<state>' OR full callback URL
  exchangeCodeForTokens()     — POST to /v1/oauth/token
  installCredentials(resp)    — keychain write + ~/.claude.json merge
  runOAuthLogin(deps)         — orchestrator with paste retry loop
src/oauth-login.test.ts       — 34 tests, all I/O injected

src/commands/login.ts         — CLI wrapper: readline + browser open
src/commands/logout.ts        — keychain delete + json strip
src/commands/auth-status.ts   — read-only status reporter

src/auth.ts                   — added deleteKeychain(); updated 4
                                error messages to suggest `--login`
src/client.ts                 — 401-after-refresh hint mentions
                                `--login` instead of just `claude`
src/cli/command-plan.ts       — three new CommandName entries; login
                                gets `needsAuth: false, needsNetwork:
                                true`; logout/auth-status get
                                fully-local capability profiles
src/cli-args.ts               — `login` / `logout` / `auth-status`
                                bare-verb subcommand sugar
src/extract-prompt.ts         — `--login` / `--logout` /
                                `--auth-status` in FLAGS_NO_VALUE;
                                `--email` / `--email-hint` in
                                FLAGS_WITH_VALUES
src/index.ts                  — three new switch arms; replaces
                                `getAuth()` with
                                `getAuthWithFirstTimePrompt()` for
                                the run path; --help advertises the
                                new commands
```

### Scope set

We request the **union** of the Claude.ai and Console scope sets at
sign-in time, matching `ALL_OAUTH_SCOPES` upstream
(`cc-03312026-2.1.88/src/constants/oauth.ts:56`):

```
org:create_api_key       — CONSOLE
user:profile             — both
user:inference
user:sessions:claude_code
user:mcp_servers
user:file_upload
```

The token server returns the actually-granted scopes via the response
`scope` field, so requesting more than the user is entitled to is
harmless (the server filters).

### Persistence shape

The keychain entry mirrors the official CLI's:

```json
{
  "claudeAiOauth": {
    "accessToken":  "sk-ant-oat01-…",
    "refreshToken": "sk-ant-ort01-…",
    "expiresAt":    1774880291250,
    "scopes":       ["user:profile", …]
  },
  "oauthAccount": {
    "accountUuid":      "…",
    "organizationUuid": "…"
  }
}
```

`oauthAccount` lives in two places — once in the keychain (older CLI
versions wrote it there too; we follow the older convention so
`auth.ts:readAccountUuidFromConfig` doesn't have to fall through), and
once merged into `~/.claude.json` (because the current official CLI
reads it from there). Both writes are idempotent.

### `~/.claude.json` merge semantics

The CLI may have other top-level keys in its config file
(`hasCompletedOnboarding`, `firstStartTime`, etc.). We `JSON.parse`
existing contents, layer `oauthAccount` on top, and write back. A
parse failure is treated as "empty config" and we write a fresh file
with just the account block — won't lose anything that's parseable.

### First-run UX

`getAuthWithFirstTimePrompt` (in `src/index.ts`) catches `getAuth`
exceptions and pattern-matches on the message:

- `/No credentials in keychain|No OAuth access token|No refresh token/`
  → "you're not signed in yet" — default `[Y/n]`.
- `/invalid_grant|stale/` → "credentials expired" — default `[y/N]`.

In both cases we only prompt when `process.stdin.isTTY &&
process.stdout.isTTY`. Non-interactive runs (`--prompt`, piped stdin)
keep the current fail-fast behavior — script-friendly.

### Refusing non-TTY `--login`

The manual-paste flow is fundamentally interactive: the user has to
open the URL, sign in, copy the code, and paste it back, with
human-bounded delays in between. A piped stdin (`</dev/null`,
`echo CODE#STATE | --login`) can't satisfy that — the auth code is
bound to a fresh PKCE `code_verifier` that the orchestrator generates
*after* stdin is fed, so pre-canned input is meaningless and the
verifier is always a mismatch. `runLoginCommand` checks
`process.stdin.isTTY` up front and exits 1 with a clear message.

(This was discovered during the smoke test: the original code spun
through `maxAttempts` empty paste reads from `/dev/null` and exited 0
because Bun's event loop drained on the unresolved-readline-promise
case. Refusing non-TTY makes the failure mode loud.)

## Tests added

| File | Count | Coverage |
|---|---|---|
| `src/oauth-login.test.ts` | 34 | base64url encoding (incl. `+`/`/` translation, `=`-stripping); PKCE crypto (verifier length, challenge SHA-256, state randomness); URL building (required params, scope ordering, `login_hint` optional, override URLs); paste parsing (canonical, full URL, query-only, malformed, empty, broken URL); token exchange (POST shape, body redaction, 401 message, generic-error message); install (keychain shape, expiresAt math, `~/.claude.json` merge w/ existing, fresh-file write, malformed-existing-survives, no-account-skip-json); orchestrator happy path, retry, state mismatch, exhaustion, network error propagation, missing openUrl |
| `src/commands/auth-status.test.ts` | 6 | not-logged-in returns 1; api-key path; full OAuth fields render; expired token still reports logged-in; missing refresh token; access-token-empty-treated-as-not-logged-in |
| `src/commands/logout.test.ts` | 8 | strip preserves other fields; missing file; missing key; malformed JSON; empty `$HOME`; full happy path; idempotent re-run; throw-from-deleteKeychain degrades gracefully |
| `src/commands/login.test.ts` | 1 | smoke shape: exports `runLoginCommand` |
| `src/cli/command-plan.test.ts` | +5 | login profile (network!auth); logout profile (pure local); auth-status profile (pure local); read-only > auth precedence; among-auth login>logout>auth-status |
| `src/auth.test.ts` | +1 | invalid_grant message mentions both `--login` and `claude` |
| `src/cli-args.test.ts` | +2 | bare verb maps to long flag; trailing flags after verb preserved |

Total new: **57 tests**. Combined surface (with existing tests in the
same files): **98 passing**.

## File inventory

**New:**
- `src/oauth-login.ts` (pure logic, ~480 lines)
- `src/oauth-login.test.ts`
- `src/commands/login.ts` (CLI wrapper, ~140 lines)
- `src/commands/login.test.ts`
- `src/commands/logout.ts` (~115 lines)
- `src/commands/logout.test.ts`
- `src/commands/auth-status.ts` (~140 lines)
- `src/commands/auth-status.test.ts`
- `docs/changes/2026-05-10-feat-oauth-login.md` (this file)

**Modified:**
- `src/auth.ts` — `deleteKeychain()`; 4 error-message updates
- `src/auth.test.ts` — invalid_grant assertion update
- `src/client.ts` — 401-after-refresh message
- `src/cli/command-plan.ts` — three new commands + their capability rows
- `src/cli/command-plan.test.ts` — five new tests
- `src/cli-args.ts` — three SUBCOMMANDS entries
- `src/cli-args.test.ts` — two new tests
- `src/extract-prompt.ts` — three FLAGS_NO_VALUE + two FLAGS_WITH_VALUES
- `src/index.ts` — imports, planCommand wiring, three switch arms,
  `getAuthWithFirstTimePrompt` helper, `--help` Auth section

## How to test (smoke)

```sh
# Read-only paths
bun run src/index.ts --auth-status        # account / scopes / expiry
bun run src/index.ts auth-status          # bare-verb sugar
bun run src/index.ts --help | grep -A4 Auth

# Refuses non-TTY (regression guard for the EOF-spin bug)
bun run src/index.ts --login </dev/null   # → exit 1 with TTY message

# Real flow (requires a real terminal — don't run via piped stdin)
bun run src/index.ts --login              # opens browser, paste code

# Logout idempotence
bun run src/index.ts --logout && bun run src/index.ts --logout
```

## Caveats / future work

- **No localhost listener flow.** Documented above; can be added as a
  third entry in the orchestrator's deps without changing the manual
  path's contract.
- **PKCE verifier is process-local.** A user who pastes a code from
  a different process (e.g. an old smoke test's URL) will get
  `invalid_grant` from the server, because the `code_verifier` for
  that state is in the dead process's heap. The error surfaces as
  "Authentication failed: invalid authorization code" via
  `exchangeCodeForTokens`'s 401 handler.
- **Linux / Windows credential stores.** `auth.ts` is still macOS
  Keychain only. Adding a `~/.claude/.credentials.json` plaintext
  fallback (matching the upstream CLI's non-macOS path) is a separate,
  non-trivial change.
- **No subscription-info refresh after login.** The official CLI fetches
  `/api/oauth/profile` after token exchange to populate
  `subscriptionType` / `rateLimitTier`. We rely on the token endpoint's
  response shape (which includes `account.uuid` / `email_address` and
  `organization.uuid`) and omit the extra round trip. `--auth-status`
  reads whatever's in the keychain; if `subscriptionType` is null the
  field is just omitted from the row.
