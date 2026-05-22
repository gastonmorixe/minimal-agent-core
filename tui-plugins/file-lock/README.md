# file-lock plugin

Cooperative locking for concurrent agents in a shared worktree. When
two agent sessions edit the same file, the second one's `Edit`/`Write`
waits with exponential backoff up to 30s instead of clobbering.

## What it contributes

| Surface | Trigger | Handler |
|---|---|---|
| Tool | `LockStatus` | `handlers/lock_status.ts` |

Plus a transparent locking layer wired into the agent's `Edit`/`Write`
codepaths (NOT inside this plugin, lives in the agent core).

## How the lock works

`Edit`/`Write` to `/abs/path/foo.ts` atomically creates a sibling
`/abs/path/foo.ts.locked` containing:

```json
{
  "sid": "<agent session id>",
  "pid": 12345,
  "host": "MacBook-Pro.local",
  "tool": "Edit",
  "ts": "2026-05-10T05:45:30Z"
}
```

The lock is held only for the read-modify-write window (typically
<100ms). Released on success or failure. Stale locks (holder PID dead
OR holder older than 5 minutes) auto-break on the next acquire.

`Bash` calls bypass the locking convention. If you shell out (`bash -c 'sed -i ...'`,
`cat > file`), no lock is acquired and concurrent peers can race.

## `LockStatus` tool

Four actions, all addressed by file path:

- `list` (show all locks under cwd)
- `inspect path="/abs/path"` (one lock by path)
- `clear-stale` (prune dead/expired locks; safe)
- `clear path="/abs/path"` (force-remove a lock; UNSAFE)

The model is told via `PROMPT.md` when to reach for each action.

## Files

- `manifest.json`: tool declaration.
- `handlers/lock_status.ts`: tool entry point.
- `cli.ts`: outside-the-agent inspection (`bun run cli.ts list`).
- `integration.test.ts`: end-to-end concurrency tests.
- `PROMPT.md`: error-recovery guidance for the model.

## Disabling

- `plugins["file-lock"].enabled = false` in `~/.minimal-agent/config.jsonc`.
- `MINIMAL_AGENT_FILE_LOCK_DISABLED=1` for one-off invocations.

When disabled, both the lock acquisition AND the `LockStatus` tool are
inactive. You won't see lock-related behavior at all.
