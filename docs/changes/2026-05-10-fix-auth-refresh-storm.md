# Auth refresh storm fix — multi-process keychain coordination

**Date:** 2026-05-10
**Type:** bugfix
**Status:** landed (commits 5bcfe58 + 02f4374)
**Author:** Claude Code (Opus 4.7)

## The symptom

When running ~100 concurrent `minimal-agent` processes against the same
shared keychain entry, every agent's live-area status row flashed
`󰌾 Auth refreshed, resuming...` every 1-3 seconds, constantly. Each
turn of every conversation took the full 401 → refresh → retry round-
trip path. Worse, occasional `400 invalid_grant` errors surfaced as
visible `error Token refresh failed: ...` lines and ended turns
abruptly.

Quote from the user (Sun May 10 ~05:50):

> ```
> 󰌾 Auth refreshed, resuming...
> ```
> wtf.... all the time!

## Diagnostic capture

`MINIMAL_AGENT_NET_DBG=1` was on for one of the affected sessions
(`c0ab6ba6-a6f4-44a7-b7d0-1958e8d6cde2`, started 05:35:19). Walking
the `.net-dbg/` directory revealed the precise pattern:

```
001 09:35:19 200  /v1/messages          ← T1 works (just started)
002 09:35:49 401  /v1/messages          ← T1 invalid 30s later
003 09:35:49 400  /v1/oauth/token       ← refresh FAILED — invalid_grant
                                          (RT1 was already burned by
                                           another agent)
004 09:37:18 401  /v1/messages          ← still T1, still 401
005 09:37:18 200  /v1/oauth/token       ← keychain re-read, NOW has
                                          fresh RT, refresh OK
006 09:37:18 200  /v1/messages          ← works briefly
007 09:37:26 401  /v1/messages          ← only 8 SECONDS later, token
                                          already invalid AGAIN
008 09:37:27 200  /v1/oauth/token       ← refresh again
009 09:37:27 200  /v1/messages
010 09:37:31 401  /v1/messages          ← 4 seconds later, invalid AGAIN
...
```

Aggregated stats for this single 5-minute session: **105 total
requests, 24 × 401 (23%), 22 refreshes (1:1 ratio).** One outright
`400 invalid_grant`. Server-issued access tokens were being
invalidated within 4-30 seconds, far below the nominal 8-hour TTL —
that's not expiry, that's rotation.

## Root cause

Anthropic's `/v1/oauth/token` endpoint rotates the refresh token on
every successful exchange (and almost certainly invalidates the
previously-issued access token at the same time — "the freshest token
wins" semantics). With N processes sharing one keychain entry:

1. P_A: cached token T_n, makes request → 200.
2. P_B: cached T_n, makes request → 401 (something else refreshed
   meanwhile, or the server treats the cache as stale once T_{n+1}
   exists).
3. P_B: calls `auth.refresh()` → server issues T_{n+1}, RT_{n+1}.
   Server invalidates T_n.
4. P_A: NEXT request with T_n → 401.
5. P_A: refresh → T_{n+2}, RT_{n+2}. Invalidates T_{n+1}.
6. P_B: NEXT request with T_{n+1} → 401.
7. ... ad infinitum.

The race is self-perpetuating: every refresh invalidates everyone
else, prompting them to refresh, invalidating everyone else, prompting
... With ~100 agents the storm is constant. With 1 agent it's
invisible. The crossover threshold is "how often does a refresh land
inside another process's in-flight window" — probably starts mattering
around 5-10 concurrent processes at typical chat traffic.

## Why this didn't happen before

The user reports running this many agents had been working fine
previously. The crossover is sharp because the storm is self-
reinforcing once it starts. A few plausible triggers for the recent
onset:

- Anthropic tightened token rotation behavior (server-side change,
  invisible to clients).
- The other agent's quota deadlock fix (`5448f93`) made `checkQuota`
  probes actually complete where some used to hang silently, raising
  the rate of `quota.headersReceived` events and thus the number of
  in-flight API requests at any moment.
- Aggregate process count crept past the crossover.

We don't need to pin the cause to fix the symptom.

## The fix — two layers

### Layer 1: keychain-first 401 retry (commit `5bcfe58`)

Lives in `src/client.ts` at both 401-retry sites (sendMessage and
checkQuota).

Before calling `auth.refresh()`, re-read the keychain. If another
process has already written a fresher access token, use it directly:

```ts
if (response.status === 401 && auth.refresh) {
  // Step 1: cheap keychain re-read. No network, no lock.
  const fresh = readKeychain()
  if (fresh?.claudeAiOauth?.accessToken !== auth.token) {
    auth.token = fresh.claudeAiOauth.accessToken
    response = await doRequest(auth.token)
    if (response.ok) return /* skip refresh entirely */
  }

  // Step 2: still 401 → call auth.refresh().
  ...
}
```

**Effect**: the common case where one process finished writing the
keychain before another process 401'd is short-circuited. Net-dbg
confirms this works: session `b7505968` (one of the first agents
restarted with this fix) showed 2 × 401 followed by **0 refreshes** —
the keychain-first path caught both 401s.

**Limitation**: doesn't help when multiple processes BOTH 401 in
the same instant before either has written the keychain. Both
re-read keychain (still the old token), both refresh in parallel.
Net-dbg showed several sessions in this state — 1:1 refresh ratio,
just like pre-fix.

### Layer 2: cross-process refresh lock (commit `02f4374`)

New module: `src/lockfile.ts` (354 lines, 19 tests).

Cross-process advisory mutex via the canonical **temp-file + atomic
link** pattern:

```ts
const tmpPath = `${path}.tmp.${pid}.${ts}.${rand}`
openSync(tmpPath, "wx")  // create tmp with our PID inside
writeSync(fd, pid)
linkSync(tmpPath, path)  // atomic: success → we hold; EEXIST → other holder
unlinkSync(tmpPath)      // inode persists via 'path'
```

A naive `openSync(path, "wx")` then `writeSync` would race: a reader
could observe the file in the empty-mid-write state and conclude the
holder is stale (`parseInt("") = NaN → dead → unlink`), opening the
gate for a third process to acquire while the original "holder" is
still about to write its PID. The temp-then-link pattern eliminates
this — `path` is created atomically with the PID already inside.

Stale detection: on `EEXIST`, read the holder's PID, probe via
`process.kill(pid, 0)`. `ESRCH` → dead, remove the lockfile.
`EPERM` (exists, but we can't signal) → alive, keep waiting.

Cleanup: `process.on("exit"/SIGINT/SIGTERM/SIGHUP)` handlers
`unlinkSync` every lockfile we own. Ctrl-C never leaves stale locks.

Bounded wait: 5s default. On timeout, `withLock` returns
`{ok: false, reason: "timeout"}` so callers can fall through to an
unlocked path rather than block forever.

### Wire-in to `auth.ts`

`doRefresh` now splits into `doRefresh` (the public closure) and
`doRefreshUnlocked` (the worker). `doRefresh` wraps the worker with
`withLock(~/.minimal-agent/.refresh-<service>.lock, {timeoutMs: 5000})`.

Inside the lock, `doRefreshUnlocked` re-reads the keychain and uses
three closure-captured trackers — `lastIssuedToken`,
`lastIssuedRefreshToken`, `lastIssuedExpiresAt` — to decide:

```ts
const keychainHasNewerToken =
  currentOauth.accessToken !== lastIssuedToken
  && (currentOauth.refreshToken !== lastIssuedRefreshToken
      || currentOauth.expiresAt > lastIssuedExpiresAt)
```

If true → another process just finished refreshing while we waited
for the lock. Use that token directly, no server call, no rotation.
Advance the trackers.

If false → we're the freshest cache holder, the token genuinely
expired. Real refresh, write keychain, advance trackers.

The `lastIssuedToken` distinction matters because comparing against
`oauth.accessToken` (the snapshot from `getAuth`'s initial read,
frozen at session start) would wrongly classify our OWN already-
issued refresh as "newer than us" on the second call.

### Why two layers, not one

Layer 1 is cheap (one keychain read, no network, no lock contention)
and handles the common case where the race finished before our 401.
Layer 2 is heavier (a lockfile acquire, possibly a 5s wait) but
handles the rare-but-storm-causing case where two processes 401 in
the same instant.

Without layer 1, every 401 would pay the lock-acquire cost.
Without layer 2, the residual micro-race would keep the storm alive
on busy clusters.

## Expected effect

For a single agent, indistinguishable from the old behavior — the
keychain-first read adds ~1ms, the lock is uncontended.

For 100 concurrent agents, the steady-state refresh rate drops from
**~1 refresh per process per few seconds (storm)** to **~1 refresh
per access-token-TTL across the whole pool** — i.e. once every 7-8
hours per shared keychain entry. The `󰌾 Auth refreshed, resuming...`
status row should appear approximately never during steady-state
operation.

## Test coverage

`src/lockfile.test.ts` — 19 tests:
- `isProcessAlive`: live, dead, malformed inputs.
- Mutual exclusion: two acquirers serialize, idempotent release,
  PID embedded, parent directory created on demand.
- Stale recovery: dead-PID reclaim, alive-PID respect, malformed-PID
  reclaim (justified by the atomic-link invariant), injected
  `isAlive` toggles both verdicts.
- Bounded wait: returns `null` after `timeoutMs`, returns immediately
  when free.
- `withLock`: success path, exception cleanup, timeout outcome,
  async `fn` support.
- Concurrent simulation: three async work units serialize, no
  interleaving of "acquired" / "released" across labels.

`src/auth.test.ts` — 2 new tests:
- `doRefresh skips the server call when keychain already has a
  fresher token` (THE multi-process happy path).
- `doRefresh DOES call refresh when keychain still has the same
  token we last used` (don't silently skip when truly stale).

`src/client.test.ts` — 2 new tests:
- Refresh fallback fires once when keychain has nothing newer.
- `checkQuota`'s 401 path follows the same pattern.

Full surface area (lockfile + auth + client + commands + plumbing):
**133 pass / 0 fail / 2 skip (e2e)**.

## File inventory

**New:**
- `src/lockfile.ts` (354 lines)
- `src/lockfile.test.ts` (272 lines)
- `docs/changes/2026-05-10-fix-auth-refresh-storm.md` (this file)

**Modified:**
- `src/auth.ts` — `doRefresh` split into locked outer + unlocked
  inner; closure trackers (`lastIssuedToken`,
  `lastIssuedRefreshToken`, `lastIssuedExpiresAt`); lockfile path
  derived from sanitized service name; test-mode escape hatch.
- `src/auth.test.ts` — 2 new tests for the keychain-first skip
  decision.
- `src/client.ts` — keychain-first read before `auth.refresh()` at
  both 401-retry sites (`sendMessage` and `checkQuota`).
- `src/client.test.ts` — 2 new tests pinning the refresh-fallback
  contract.

## Caveats

- **NFS / network filesystems**: `O_EXCL` is not reliable across
  hosts. `~/.minimal-agent/` is assumed local — macOS APFS or Linux
  ext4 / btrfs in practice. This is the same assumption the rest of
  the agent already makes (session JSONL, draft persistence, etc).
- **PID reuse**: the stale-lock detection trusts `process.kill(pid, 0)`.
  If the original holder dies and the OS recycles its PID to an
  unrelated process before we probe, we'll conclude the (different)
  process is alive and keep waiting. With 32-bit PID space and
  modern OS PID assignment heuristics the window is tiny, but
  documented for completeness.
- **Linux/Windows credential stores**: `auth.ts` is still macOS-
  Keychain-only. The lockfile mechanism is portable; the keychain
  read/write isn't. Cross-platform support is a separate, larger
  change.
- **Layer 2 timeout fallback**: if a process holds the lock for
  more than 5 seconds (e.g. extremely slow OAuth round-trip), the
  next acquirer falls through to an unlocked refresh. That accepts
  one rare extra rotation, which is preferable to blocking
  indefinitely. Tune `timeoutMs` higher if observed in practice.

## Recovery instructions

After pulling these two commits, all running agents must be
restarted to pick up the new client.ts and auth.ts. The lockfile
itself is created on demand; no preparation needed.

Verification: `bun run src/index.ts --auth-status` should report
`refresh: present` and an expiry well in the future. Watch a few
agents' live-area status rows during normal use — the
`󰌾 Auth refreshed, resuming...` flash should be rare (only on true
expiry, ~once per 7-8h across the whole pool).
