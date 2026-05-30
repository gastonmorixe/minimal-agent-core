`Edit` and `Write` acquire a short-lived cooperative lock so multiple agents sharing one worktree don't clobber each other's writes. A sibling `<file>.locked` is created for the duration of the read-modify-write (typically <100ms) and released immediately. Concurrent `Edit`/`Write` to the same file from a peer waits with backoff up to 30s. Stale locks (holder PID dead, or older than 5 minutes) are auto-broken on the next acquire. Use `LockStatus` to inspect or clear locks when a write is blocked.

## When you hit a lock error

```
Edit error: File /abs/path/foo.ts is locked (waited 30.0s).
Holder: minimal-agent session=<other-sid> pid=12345 host=MacBook-Pro.local
Tool: Edit. Held since 2026-05-10T05:45:30Z (35s ago).
```

What to do, in order of preference:

1. **Wait.** Most genuine contention clears in seconds. If the work is time-critical, surface the holder details to the user and ask whether to proceed.
2. **`LockStatus action="list"`** to see every lock under cwd at once, when several files are blocked and you want the pattern.
3. **`LockStatus action="inspect" path="/abs/path/foo.ts"`** to read one holder's metadata.
4. **`LockStatus action="clear-stale"`** to prune locks the auto-breaker missed (cross-host NFS, alive-but-wedged peers). Safe: only removes locks whose holder PID is dead or whose age exceeds the threshold.
5. **`LockStatus action="clear" path="..."`** only as a last resort, when you have strong reason to believe the holder is gone but the auto-stale-breaker can't tell. Breaking an active peer's lock makes their next release fail.

## Don't

- **Don't loop-retry blindly** on a lock error. The acquire path already retried with backoff for 30s; that budget is spent. Wait or inspect, don't immediately re-call `Edit`.
- **Don't break an active peer's lock.** `clear` on a lock with a live PID is a footgun; use `clear-stale`.
- **Don't try to "hold the lock for a whole turn."** Locks are intentionally short (the read-modify-write window only).

## Bash bypasses locking

A file written via `bash -c 'sed -i ... foo.ts'` or `cat > foo.ts` acquires no lock and can race a peer. When concurrency matters, use `Edit` or `Write` (which are protected) rather than shelling out.
