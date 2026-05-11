The `file-lock` plugin coordinates concurrent file edits across cooperating
agents that share a worktree.

## How it works (one paragraph)

When you call `Edit` or `Write`, the agent atomically creates a sibling
lock file `<file>.locked` containing your session id, pid, host, and
timestamp. The lock is held only for the duration of the read-modify-write
(typically <100ms). Concurrent `Edit`/`Write` to the same file from a
peer agent will wait with backoff up to 30s. Stale locks — holder PID
dead OR holder older than 5 minutes — are auto-broken on the next
acquire attempt.

## Errors you might see

```
Edit error: File /abs/path/foo.ts is locked (waited 30.0s).
Holder: minimal-agent session=<other-sid> pid=12345 host=MacBook-Pro.local
Tool: Edit; held since 2026-05-10T05:45:30Z (35s ago).
Inspect with the LockStatus tool, or wait and retry.
```

What to do, in order of preference:

1. **Wait.** Most genuine contention resolves in seconds. If the user is
   doing something time-critical, surface the lock holder details to
   them and ask whether to proceed.
2. **`LockStatus action="list"`** to see every lock under cwd at once.
   Useful when several files are blocked and you want to understand the
   pattern.
3. **`LockStatus action="inspect" path="/abs/path/foo.ts"`** to read one
   specific holder's metadata.
4. **`LockStatus action="clear-stale"`** to prune locks the auto-breaker
   missed (cross-host NFS, alive-but-wedged peers). Safe — it only
   removes locks whose holder PID is dead OR whose age exceeds the
   stale threshold.
5. **`LockStatus action="clear" path="..."`** — only as a last resort,
   when you have strong reason to believe the holder is gone but the
   auto-stale-breaker can't tell. Be aware that breaking an active
   peer's lock causes them to fail the next time they try to release
   (their `release()` will see a foreign holder and refuse to unlink).

## Don't

- **Don't loop-retry blindly** on lock errors. The acquire path already
  retries with exponential backoff for 30s. If you got an error, that
  retry budget is already spent — wait or inspect, don't immediately
  call `Edit` again.
- **Don't break active peers' locks.** `LockStatus action="clear"` on a
  lock with a live PID is a footgun. Use `clear-stale` instead.
- **Don't try to "lock the whole turn."** Locks are intentionally short
  (only the read-modify-write window). Holding longer would serialize
  agents on every file in cooperation, defeating the point.

## Bash is NOT covered

`Bash` calls bypass the locking convention. If you write a file via
`bash -c 'sed -i ... foo.ts'` or `cat > foo.ts`, no lock is acquired
and concurrent peers can race you. When concurrency matters, use
`Edit` or `Write` (which are protected) rather than shelling out.

## Disabling

The user can disable locking via `~/.minimal-agent/config.jsonc`:

```jsonc
{
  "plugins": {
    "file-lock": {
      "enabled": false
    }
  }
}
```

Or via `MINIMAL_AGENT_FILE_LOCK_DISABLED=1` for one-off invocations.
When disabled, both the lock acquisition AND the `LockStatus` tool are
inactive — you simply won't see lock-related behavior.
