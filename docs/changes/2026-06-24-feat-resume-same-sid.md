# `--resume-same-sid`: resume in place without forking

**Date:** 2026-06-24

## Summary

`--resume <sid>` forks: it copies the prior conversation into a brand-new
session file under a fresh per-process UUID, leaving the original untouched.
That is the right default (re-resuming the parent keeps working forever), but
it means the session id changes on every resume.

`--resume-same-sid <sid|last>` resumes IN PLACE instead. It pins this process's
session id to the target sid and appends to the existing session file directly:
no fork, no new sid, sidecar files and the blob directory reused as-is. Use it
for long-running agent loops in tmux where you want the session id to stay
stable across restarts.

When both flags are passed, `--resume-same-sid` wins (it is the more specific
intent).

Also reachable as the subcommand `resume-same <sid|last>` (and
`sessions resume-same <sid|last>`), paralleling the existing `resume` /
`sessions resume` sugar.

## Behavior

- Pins the sid via `setSessionId(resolveSessionTarget(arg))` BEFORE any
  `getSessionId()` call, so the session file, log file, blob dir, and the
  goodbye banner's `--resume <id>` hint all share the original sid.
- Opens the existing session store with `existsOk: true` rather than forking.
  `SessionStore.open` is non-destructive on an existing file: it writes no new
  meta or index record (guarded by `if (!fileExists)`), so the original
  creation metadata is preserved and only `append*()` adds records.
- Skips the live-peer fork warning (we ARE the continuation, not a fork).

## Files

- `src/index.ts` — parse `--resume-same-sid`, pin sid, thread `resumeSameSid`
  and `effectiveResumeArg` through resume load + `bootSessionStores`.
- `src/startup/session-store-boot.ts` — `resumeSameSid` option; open in place
  with `existsOk` instead of forking; skip the live-peer warning.
- `src/startup/help.ts` — Sessions section row for the new flag.
- `src/cli-args.ts` — flag arg recognition / parsing; `resume-same`
  subcommand alias (top-level and under `sessions`).

## Tests

- `src/session-store.test.ts` — "preserves the original meta on same-sid reopen
  even when resume opts differ": reopening a sid in place with `existsOk:true`
  and a different model/hashes keeps exactly one meta record (the original) and
  appends both turns, with no duplicate index entry.
- `src/cli-args.test.ts` — `--resume-same-sid` parsing + precedence over
  `--resume`.

## Notes

The hung-transport Ctrl+C fix (`src/editor-controller.ts`, `setImmediate(() =>
process.exit(0))` on both quit paths) shipped alongside this work; it is what
made a wedged session killable in the first place, which motivated a
stable-sid resume so the same conversation can be brought back after a kill.
