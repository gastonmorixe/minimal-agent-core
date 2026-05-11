# feat: cooperative file locking for concurrent agents

**Date**: 2026-05-10
**Type**: feat
**Scope**: src/file-lock.ts (new), src/tools.ts (wired), tui-plugins/file-lock/ (new)

## Problem

Multiple cooperating agents are now routinely run against the same
worktree (different sessions, multiple processes, sometimes multiple
machines via shared filesystems). Concurrent `Edit` / `Write` calls to
the same file produce silent lost-write races:

1. Agent A reads file content `C0`.
2. Agent B reads file content `C0`.
3. Agent A writes `C1_a` based on `C0`.
4. Agent B writes `C1_b` based on `C0`. Last writer wins; A's edit is
   silently lost.

The window between read and write inside a single `execEdit` /
`execWrite` is short (<100 ms typical), but the failure mode is
silent: no error is surfaced to either agent, and the user only
notices when the resulting file looks wrong.

## Goals

- **Correctness**: at most one cooperating agent in the read-modify-write
  critical section for a given file at a time.
- **Brevity**: the lock is held only for the body of the executor, not
  for "the whole turn".
- **Self-healing**: an agent that crashes mid-edit (SIGKILL, panic) must
  not block peers forever.
- **Cooperative**: this is a coordination mechanism, not enforcement.
  Agents that bypass `Edit` / `Write` (e.g. raw Bash `sed -i`) are out
  of scope. The protocol only protects peers who agree to honor it.
- **Disable-able**: a single flag (config or env) turns the entire
  mechanism off.
- **Observable**: locks are visible on disk + via a `LockStatus` tool
  + via a CLI.

## Options considered

### Option A : Core feature in `src/tools.ts` (CHOSEN)

A small `src/file-lock.ts` library; `src/tools.ts` wires it around
`execEdit` / `execWrite`. A companion plugin under
`tui-plugins/file-lock/` provides the user surface (`LockStatus` tool,
CLI, PROMPT.md docs).

- **+** Self-contained core; one file to wire.
- **+** Doesn't touch `src/agent.ts` (other agent has it dirty :
  memory v0.3 in flight). Reduces collision risk.
- **+** The companion plugin still lets the user disable via existing
  `plugins["file-lock"].enabled = false` infrastructure (single source
  of truth : the same config flag drives both the locker and the
  `LockStatus` tool).
- **-** Not "purely" a plugin : the locking call site is in core
  `tools.ts`. Acceptable: locking is a safety property, not a feature.

### Option B : Complete the hooks subsystem; pure plugin

`src/plugins/hooks/channels.ts` already declares `tool.willInvoke`
(chain, can veto/rewrite) and `tool.didInvoke` (broadcast-async). A
plugin could subscribe to those and acquire/release. But:

- **-** The channels are declared but NOT emitted anywhere yet, and
  the loader doesn't dispatch manifest `hooks: [...]` entries to the
  bus. Wiring this means touching `src/agent.ts`, `src/tools.ts`, and
  `src/plugins/loader.ts` : three files, two of which are currently
  modified by other agents.
- **-** Larger change, more places to regress.
- **+** Cleaner long-term architecture; would unblock other policy
  plugins (audit-log, sandbox-enforce).
- **REJECTED for v1.** The lock protocol is the interesting part;
  the plumbing route doesn't change correctness. We can hoist later
  with a 5-line refactor once the hook subsystem is wired up.

### Option C : Wrapper tools `LockedEdit` / `LockedWrite`

Plugin advertises new tools, prompts the model to use them instead of
`Edit` / `Write`. **REJECTED**: the model would routinely fall back
to plain `Edit` / `Write` (still advertised by core), the safety
property would not hold by construction, and the user'd have two
sets of tools doing the same thing.

## Design

### Lock file

- **Path**: sibling `<file>.locked` (e.g. `foo.ts` → `foo.ts.locked`).
- **Atomicity**: `fs.openSync(lockPath, "wx")` : POSIX `O_CREAT |
  O_EXCL`. Exactly one of N concurrent creators wins.
- **Contents** (single-line JSON, atomic-ish read; a partial-write
  parses to `null` and is treated as stale):

  ```json
  {
    "v": 1,
    "harness": "minimal-agent",
    "sessionId": "d07a1090-…",
    "pid": 12345,
    "host": "MacBook-Pro.local",
    "tool": "Edit",
    "callId": "toolu_01abc",
    "filePath": "/abs/foo.ts",
    "acquiredAt": "2026-05-10T05:45:30Z",
    "acquiredAtMs": 1715332530123
  }
  ```

- `v` enables forward-compat. `host` makes cross-machine diagnostics
  sensible. `callId` (optional) is the API tool_use id for precise
  "stolen lock" detection.

### Acquisition algorithm (`acquireLock`)

```
loop:
  try openSync(lockPath, "wx") → write holder → return handle
  on EEXIST:
    existing = readAndParse(lockPath)
    if existing is null:
      → corrupt → unlink → retry (no sleep)
    if existing.sessionId == ours && existing.pid == process.pid && existing.host == ourHost:
      → reentrant → return no-op handle (don't unlink on release)
    if isStaleLock(existing):
      → unlink → retry (no sleep)
    else:
      → genuine contention → sleep(backoff[attempt]) → retry
  on deadline:
    → throw LockTimeoutError(holder, waitedMs)
```

Backoff schedule: `[50, 100, 200, 400, 800, 1000]` ms, last value
repeats. Total deadline: 30 s default.

### Stale detection (`isStaleLock`)

Two independent signals:

1. **Same-host PID probe**: `process.kill(holder.pid, 0)`. ESRCH →
   process gone → stale. EPERM → process exists, treat as alive.
2. **Time threshold**: `now - holder.acquiredAtMs > staleAfterMs`
   (default 5 min). Catches alive-but-wedged holders and cross-host
   holders we can't probe.

Cross-host (`holder.host !== os.hostname()`) skips the PID probe and
falls through to the time check.

### Release algorithm

`handle.release()` is idempotent:

1. Read the current lock file content.
2. If it parses as ours (`sessionId + pid + acquiredAtMs` match) OR
   the content is missing/unparseable → unlink.
3. Otherwise → someone broke our lock and now owns it; don't smash.

### Crash safety : three layers

| Layer | Mechanism                              | Catches                                  |
| ----- | -------------------------------------- | ---------------------------------------- |
| 1     | `try/finally` in `withFileLock`        | Tool error, AbortSignal, normal exit     |
| 2     | `process.on("exit"/"SIGINT"/"SIGTERM")` | Graceful shutdown (Ctrl-C, container stop) |
| 3     | PID-based stale detection at acquire   | SIGKILL, OOM, kernel panic               |

Layers 1+2 keep things tidy in normal operation; layer 3 is the
correctness backstop.

### Scope

- **Locks**: `Edit` and `Write` (default; configurable via
  `plugins["file-lock"].tools`).
- **Not locked**:
  - `Read`, `Grep`, `Glob` : pure observation, no mutation.
  - `Bash` : opaque commands. Detecting "this `bash -c 'sed -i'` is a
    write to X" is a regex tarpit; v1 documents this as out of scope.

### Config

`~/.minimal-agent/config.jsonc`:

```jsonc
{
  "plugins": {
    "file-lock": {
      "enabled": true,        // default true; false to disable
      "tools": ["Edit", "Write"],
      "timeoutMs": 30000,     // total wait before fail
      "staleAfterMs": 300000  // 5 min
    }
  }
}
```

Env opt-out: `MINIMAL_AGENT_FILE_LOCK_DISABLED=1` (one-off / test scope).

### Companion plugin (`tui-plugins/file-lock/`)

- **`manifest.json`** : declares `LockStatus` tool. Picked up by the
  same `PluginLoader` that loads memory / ask-mode / etc.
- **`PROMPT.md`** : model-facing instructions for handling lock
  errors and using `LockStatus` to investigate.
- **`handlers/lock_status.ts`** : handler with four actions:
  - `list` : every `*.locked` under `path` (default cwd), with
    status verdicts (`held` / `stale-pid` / `stale-time` / `corrupt`
    / `cross-host`).
  - `inspect` : one lock's holder details.
  - `clear-stale` : auto-prune what the live acquirer would also
    break (safe).
  - `clear` : force-remove one lock (loud about whether the holder
    appears alive).
- **`cli.ts`** : same actions for shell use. Run as
  `bun run tui-plugins/file-lock/cli.ts list|inspect|clear-stale|clear|path`.

## Files

### New

- `src/file-lock.ts` : lock library (atomic acquire/release, stale
  detection, wait+backoff, exit cleanup, list-under-dir).
- `src/file-lock.test.ts` : 40 unit tests covering parse, stale
  detection, atomic acquire, contention with mocked time/sleep, abort
  paths, listing.
- `src/tools-file-lock.test.ts` : 8 integration tests verifying the
  `tools.ts` wiring (lock acquired & released on `Edit` / `Write`,
  holder details surface in error message on contention, env +
  config opt-outs honored, ENOENT validation falls through cleanly).
- `tui-plugins/file-lock/manifest.json` : plugin manifest.
- `tui-plugins/file-lock/PROMPT.md` : model docs.
- `tui-plugins/file-lock/handlers/lock_status.ts` : `LockStatus`
  handler (4 actions, ANSI + JSON rendering).
- `tui-plugins/file-lock/handlers/lock_status.test.ts` : 27 unit
  tests for `annotate`, the four `runX` functions, and the default
  export adapter.
- `tui-plugins/file-lock/cli.ts` : human-facing CLI.
- `tui-plugins/file-lock/cli.test.ts` : 20 tests for `parseArgs` and
  `runCli`.
- `tui-plugins/file-lock/integration.test.ts` : 3 PluginLoader
  integration tests verifying that `LockStatus` is advertised and
  dispatched correctly.

### Modified

- `src/tools.ts`:
  - 1 import block (`acquireLock`, `LockTimeoutError`,
    `LockAbortedError`, `LockHandle`, `getSessionId`, `parseJsonc`,
    `configPath`).
  - 2 cases in `dispatch()` (`Write` and `Edit` wrapped in
    `withFileLock(...)`).
  - 1 new private helper `withFileLock(tool, input, opts, run)` (~60
    lines).
  - 1 new private cache + 1 helper `fileLockConfig()` (~50 lines).
  - 1 test seam `_resetFileLockConfigForTests()` (exported).
- No changes to `src/agent.ts`, `src/index.ts`, `src/plugins/loader.ts`,
  or anything else other agents are touching.

## Test coverage

98 new tests, all passing:

- `src/file-lock.test.ts`: **40** tests (parse, build, stale logic,
  tryAcquireOnce, acquireLock happy path, reentrancy, contention with
  backoff, time-stale break, pid-stale break, corrupt-lock break,
  abort during sleep, listLocksUnder).
- `src/tools-file-lock.test.ts`: **8** tests (Edit/Write success +
  no-leftover-lock, lock-held error surfaces holder details, stale
  break + proceed, fresh-dir Write, env + config opt-outs, missing
  file_path falls through).
- `tui-plugins/file-lock/handlers/lock_status.test.ts`: **27** tests
  (annotate status verdicts, runList/Inspect/ClearStale/Clear, default
  export adapter validation, JSON + text formats).
- `tui-plugins/file-lock/cli.test.ts`: **20** tests (parseArgs flags,
  every subcommand including `path`, --json mode, error paths).
- `tui-plugins/file-lock/integration.test.ts`: **3** tests (manifest
  loads, `LockStatus` is advertised, dispatch round-trips).

Full suite: `bun test` → **1609 pass, 0 fail, 5 skip** (unchanged
skip set : all network/terminal tests that always skip).

## Risks & mitigations

- **Tests that exercise `Edit` / `Write` in temp dirs**: the lock is
  acquired+released within the call, removing the `.locked` sibling
  before return. Verified with the existing `src/tools.test.ts` suite
  (Edit + Write paths still pass under locking).
- **Performance**: lock acquire is one `openSync` syscall in the
  no-contention case (~50-200 µs). Negligible vs the actual
  read-modify-write.
- **Lock leak on SIGKILL**: handled by layer-3 stale detection on
  next acquire.
- **Race with peer breaking our lock**: `release` re-reads and
  refuses to unlink a foreign holder, so we don't smash their lock.
- **Cross-host NFS**: PID probe is skipped; time threshold (5 min
  default) is the only stale signal. Configurable via
  `staleAfterMs`.

## Future work (not in this PR)

- Wire `tool.willInvoke` / `tool.didInvoke` hooks in `agent.ts` and
  hoist the locking into a pure plugin once the hook subsystem is
  complete. Adds <50 lines net; backward-compatible (the locking
  behavior wouldn't change, only the call site).
- Optional Bash protection via per-directory or per-glob locking
  (coarser, opt-in).
- Read locks (shared) : currently unnecessary; mutation-vs-mutation
  is the failure we see.
