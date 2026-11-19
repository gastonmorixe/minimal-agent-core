# Session catalog and the `index-meta.jsonl` sidecar

Date: 2026-11-19. Scope: core (session store, session index, catalog,
Bash tool env) and the CLI `sessions` command.

## The problem

`--sessions` read `index.jsonl` and opened each session file to get a title,
a cost and a status. With many sessions this was slow. Cleanup of an empty
session rewrote `index.jsonl` without the entry, so two processes could lose
lines. Sub-agent sessions had no link to their lead, and a `ma` run from a
worker shell inherited the worker identity env.

## The contract

- **Session catalog** (`@minimal-agent/core/host/session-index`):
  `listSessions(opts)` gives the rows of one page (`rows`, `total`,
  `hiddenCount`, `unknownCount`). Options: `limit`, `page`, `since`, `cwd`,
  `model`, `query`, `includeHidden`, `dir`, `writeSummaries`,
  `maxSummaryBytes`, `io`, `liveness`. Sub-agent children come under their
  lead row. `unknownCount` counts all matching top-level rows (on all pages,
  not only this page) with a session file and no fresh summary line, so the
  catalog cannot know if they are empty without a file read. It is not a
  status. When it is above 0, `total` is an upper bound and `hiddenCount` is a
  lower bound. `query` matches the title only when the row has a summary line.
- **Lineage fields** on a new index line: `leadSid`, `agentId`, `role`
  (`IndexLineage`). With no explicit lineage, the sub-agent env is used only
  for the pinned sub-agent session: `isPinnedSubagentSid(sid, env?, argv?)` is
  true when `MINIMAL_AGENT_SUBAGENT_SID` equals `sid`, or when argv pins it with
  `--session-id`. A `ma` run from a worker shell or a fork does not match.
- **Sidecar `index-meta.jsonl`** (`indexMetaFilePath(dir?)`): summary lines
  (`kind: "summary"`, `v: 3`, `INDEX_SUMMARY_VERSION = 3`) and tombstone lines
  (`kind: "tombstone"`, `sid`, `at`, optional `indexBytes`). A sidecar summary
  wins over a summary line in `index.jsonl`; the last one of a sid wins. A
  tombstone removes the session lines of its sid that start before
  `indexBytes` (all of them when it is absent) and the earlier summaries.
  A later session line of that sid (a re-used `--session-id`) is kept.
- **`index.jsonl` is not rewritten on cleanup.** Cleanup of an empty session
  appends a tombstone to `index-meta.jsonl`. `index.jsonl` is append-only.
- **Readers**: `readParsedSessionIndex(dir?)` reads the two files into one
  snapshot. `parseSessionIndexText(text, metaText = "")` has a new optional
  2nd argument. `readSessionIndex()` applies the tombstones of both files.
- **Status rules** (`detachStatus`, `STOP_SIGNAL_EXIT_CODES`): `done` for no
  detach record, exit 0, and exit 129, 130 or 143 (SIGHUP, SIGINT, SIGTERM:
  a closed terminal or a stopped worker is not a failure), or a `signal`
  detach with no code. `failed` for an `error` detach and any other non-zero
  exit code. The catalog also gives `live` (an open attach with a live pid).
  The catalog has no `unknown` status. `unknown` is a value of the CLI
  (`statusOf`) for a row with no resolved status.
- **Bash tool env**: `bashChildEnv` drops the sub-agent identity keys
  (`SUBAGENT_IDENTITY_ENV_KEYS`): `MINIMAL_AGENT_SUBAGENT_LEAD`, `_ID`,
  `_ROLE`, `_SID`, `_DEPTH`, `_RESULT_PATH`, `_EXPECT_ARTIFACTS` and
  `MINIMAL_AGENT_LEAD_PID`. User config keys (`_MODEL`, `_AUTO_TIER`,
  `_MAX_DEPTH`, `_MAX_CONCURRENT`, `_MAX_TOTAL`, `_INHERIT`, `_NO_PRESENCE`,
  `_TOKEN_BUDGET`) stay.

## Migration notes

- All API changes are additive. No exported name or shape was removed.
  `public-exports.json` has no change (it lists subpaths only).
- Old builds wrote summary and tombstone lines into `index.jsonl` (the 7b/7c
  diff). These lines are still read. The catalog trusts old summary lines,
  except an old `failed` status, which it computes again when the session
  file shows an open attach or a detach record.
- A reader that reads `index.jsonl` alone misses the new summaries and the
  sidecar tombstones. Use `readParsedSessionIndex` or pass the
  `index-meta.jsonl` text to `parseSessionIndexText`. The CLI `sessions`
  detail view uses `readParsedSessionIndex` (P6).
- Old builds (before this change, for example an old `~/.minimal-agent/bin/ma`)
  still rewrite `index.jsonl` with `O_TRUNC` in `cleanupIfUnused`. While an
  old build runs on the same store: (1) the rewrite race continues, so lines
  that other processes append during the rewrite can be lost; (2) the rewrite
  makes the file shorter, so the byte offsets move, and a sidecar tombstone
  `indexBytes` cut can then point past a later session line of a re-used sid
  (`--session-id`) and remove it. The effect needs a re-used sid, so it is
  rare. Safe rule: do not run old and new builds on one store at the same
  time; update `~/.minimal-agent/bin/ma` (and each other installed `ma`) to a
  build with this change.

## Addendum: lineage backfill and fork mark

- New sidecar line `{kind: "lineage", v: 1, sid, leadSid, agentId?, role?,
  source: "transcript" | "ppid", at}` in `index-meta.jsonl`
  (`IndexLineageRecord`, `isIndexLineageRecord`). `parseSessionIndexText`
  merges the last one of a sid into its session lines only when the line has
  no recorded `leadSid` (recorded lineage wins), and sets
  `IndexRecord.lineageSource`. A sidecar tombstone removes the earlier
  lineage lines of its sid. `ParsedSessionIndex.lineages` gives them. Old
  readers skip the unknown kind.
- New `backfillLineage({dir, dryRun, since})` (`session-lineage-backfill.ts`,
  on `./host/session-index`): candidates are index rows with no `leadSid` and
  an argv with `--session-id` and `--prompt`. A link comes from the lead
  transcript text "Spawned sub-agent <id> (<type> …), running in background
  as session <sid>" (source `transcript`, gives `agentId` and `role`), else
  from the first attach `ppid` = the pid of exactly one lead on the same host
  whose live window holds the child attach time (source `ppid`). 0 or 2+
  matches: skipped. Head reads of 4 KiB; streamed transcript scan; files
  above 64 MiB are not scanned. Idempotent on (sid, leadSid).
- `SessionCatalogRow` gets `lineageSource` (`recorded` | `transcript` |
  `ppid`, set with `leadSid`) and `forkOf` (meta `parentSid`, returned rows
  only; one 4 KiB head read for a row with an index summary, new optional
  `SessionCatalogIo.readHead`). A fork stays a top-level row.

