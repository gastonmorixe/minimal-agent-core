# `sessions:files`: immutable plugin files of a session

Date: 2026-11-22. Scope: core (`src/plugins/host/providers/session-files.ts`,
`owned-session.ts`, `factory.ts`, `src/session/session-files-tree.ts`,
`SessionStore.fork` and `cleanupIfUnused`, subpath `./host/session-files`).
First user: the paste plugin (paste plugin v3, B2).

## The contract

A plugin that declares `capabilities: ["sessions:files"]` gets
`host.sessionFiles` (`SessionFilesApi`):

| Call | Result |
| --- | --- |
| `create(sid, name, data)` | `"ok"`, `"exists"`, `"over-cap"` or `"error"`. Never throws, never overwrites. |
| `read(sid, name)` | The UTF-8 text, or `null`. |
| `stat(sid, name)` | `{ bytes }`, or `null`. |
| `usage(sid)` | `{ files, bytes }` of the plugin dir (zeros when there is none). |

The files are at `<sessionsDir>/<sid>.files/<pluginId>/<name>`. The plugin
gets no path, only a name in its own dir. A hook handler gets the same host
with `host: true` on the hook (see `docs/hooks.md`).

### Name rule

`name` and the plugin id agree with `^[a-z0-9][a-z0-9._-]{0,63}$` and hold
no `..`. So: no `/`, no NUL, no dot name (a dot name is a tmp file), 64
chars at most. A bad name gives `"error"` or `null`. A plugin that declares
`sessions:files` with an id that does not agree (for example 65 chars) does
not get the capability, and the factory emits one warning for that id.

### Owned sid

Each call checks the sid before it touches the disk:

1. The sid is safe for a file name (`isSafeSessionId`: no `/`, `\`, `..`,
   NUL; 1 to 128 chars).
2. Its session file `<sessionsDir>/<sid>.jsonl` exists.
3. The process owns it: the sid of the current session scope, the resolved
   process session id, or a sid for which `isOwnedSession` gives true. This
   is the rule of `sessions:meta` (one helper: `checkOwnedSessionSid` in
   `owned-session.ts`).

A rejected sid gives `"error"` from `create` (no dir is made), `null` from
`read` and `stat`, and zeros from `usage`.

The core plugin host always applies step 3 (it passes the loader
`isOwnedSession`, or `() => false`). A host that builds the API itself with
`createSessionFilesApi` (subpath `./host/session-files`, for example the CLI
UI loader) gets step 3 only when it passes `isOwnedSession`. Without it,
steps 1 and 2 apply, so a caller with a real sid still works, and a sid with
no session file gets no dir.

## Modes

Dirs are 0700 and files are 0600. The dirs are made on the first `create`.

`create` writes a tmp file (`.tmp-<name>-<pid>-<rand>`, `wx`) in the plugin
dir, fsyncs it, links it to the final name (`link` is exclusive: `EEXIST`
gives `"exists"`), unlinks the tmp file and fsyncs the dir. Before that, an
`lstat` of the final name gives `"exists"` for any entry, also a symlink: a
symlink is never followed and its target is never written.

## Caps

- 32 MB for each file (UTF-8 bytes).
- 256 MB for each `<sid>.files/<pluginId>/` dir.

The usage is read from the disk at each `create` (no counter in RAM), so two
API instances on one dir (the UI host and the core host) share the cap. The
check, then the link, is not atomic: two writers at the same time can each
pass the check, so the dir can go over the cap by one file of each writer.

## Fork: hard links

`SessionStore.fork` hard-links each regular file of `<src>.files/**` to the
same path under `<dst>.files/**` (dirs 0700; a copy on `EXDEV`). A symlink
or other special entry is skipped on purpose. After the fork, a `create` in
one session does not show in the other: the dirs are separate, only the
inodes of the old files are shared.

Because the two sessions share inodes, the files must stay immutable. A
future delete or overwrite API must unlink the name and create a new file,
never truncate or write in place: that would change the file of the other
session too.

## Cleanup

`cleanupIfUnused` (a session with no conversation) removes `<sid>.files/`
with its other sidecars. It removes only its own `<sid>.files/`, not the dir
of another sid (also not one whose sid starts with the same text).

## Limit: orphans

A session removed by hand (for example `rm <sid>.jsonl`) leaves its
`<sid>.files/` dir. No sweep removes it. The API does not read or write it
any more (step 2 of the sid rule rejects the sid), but it stays on the disk.
