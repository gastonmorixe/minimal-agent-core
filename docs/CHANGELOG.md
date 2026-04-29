# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions track the upstream Claude Code wire protocol that the agent reproduces.

## [Unreleased]

### Added
- **Session restore (v1).** Conversations are now persisted as append-only JSONL at `~/.minimal-agent/sessions/<sid>.jsonl` and can be resumed with `--resume <sid>` or `--resume last`. `--sessions` lists saved sessions with a one-line preview of the first user prompt.
  - `src/session-store.ts` — `SessionStore` writer (FORMAT v1: `meta`/`user`/`assistant`/`tool_result`/`note` records), `parseLines` torn-line-tolerant reader, FNV-1a `shortHash` for system/tool drift detection, `~/.minimal-agent/sessions/index.jsonl` for fast listing.
  - `src/session-restore.ts` — `foldRecords` (records → `Message[]`), `repairMessages` (drops orphan `tool_use`/`tool_result` blocks anywhere in the list, not just at the tail), `loadSession`, `firstUserPromptSnippet`.
  - `src/session-replay.ts` — `buildResumeHeader`, `replayToScrollback`: renders prior conversation (text + tool blocks + their results) above the resumed prompt using the same formatters as live turns, dimmed so the user can tell history from new.
  - `src/agent.ts` — `Agent` accepts an optional `store?: SessionStore` and `initialMessages?: Message[]`. The run loop calls `appendUser` after the user push, `appendAssistant` after each assistant turn (with `stopReason`), and `appendToolResult` after every tool execution.
  - `src/index.ts` — sid is the existing `getSessionId()` UUID (already in the startup banner and `x-claude-code-session-id` header), keeping file id, API id, and `.node-net-dbg/` capture id aligned. New CLI: `--resume <sid|last>`, `--sessions`. Drift warning prints when system/tools hashes don't match.
  - Tests: 30 new tests across `session-store.test.ts`, `session-restore.test.ts`, `session-restore-e2e.test.ts`, `session-replay.test.ts`. End-to-end verified in tmux via `scripts/session-restore-tmux-demo.ts`.
  - `docs/session-restore.md` — format spec, CLI usage, crash-safety rules, repair semantics, and explicit out-of-scope list.
- Cache observability (`src/cache.ts`):
  - Per-turn `cache` line printed to stderr in `--debug` mode the moment `message_start` arrives. Format: `cache  read 38,789  write 419 (1h)  new 1  out 47`. Collapses to `cache  cold` when neither read nor write happened.
  - `[cached]` annotation on messages in the `--debug` body dump when their tail block carries a `cache_control` marker (matches the existing system-block annotation).
  - Always-on `CacheAnomalyDetector` that warns to stderr (no `--debug` required) when the cache misbehaves: `markers_ignored_cold`, `below_min_block_size`, `no_read_after_write`, `cache_evicted`. Each anomaly emits at most one warning per process.
- Rolling cache breakpoint helper `withRollingCacheBreakpoint` (`src/agent.ts:96`). Stamps `cache_control: { type: "ephemeral", ttl: "1h" }` on the last block of the last message and strips earlier message-level markers, keeping ≤4 active breakpoints per request.
- `cache_control: { type: "ephemeral", ttl: "1h" }` on `system[3]` (session guidance) when present (`src/headers.ts:418`). Combined with the existing `system[2]` marker and the rolling tail, this matches Claude Code 2.1.118's three-breakpoint scheme byte-for-byte.
- On-disk request/response logger `src/net-dbg.ts`. Enable with `MINIMAL_AGENT_NET_DBG=1`; mirrors raw HTTP traffic to `./.node-net-dbg/<epoch>-<human-date>-minimal-agent/` using the same four-file scheme as Claude Code's `~/.node-net-dbg/`.
- `docs/caching.md` — prompt caching guide: mental model, breakpoint placement in this codebase, verification recipe, worked example showing `cache_read` climbing across turns, and known failure modes.
- Unit tests for `withRollingCacheBreakpoint` (strip-then-stamp invariant, string-content normalization, empty-input handling, defensive copy) in `src/agent.test.ts`.
- Unit tests for the haiku `context_management` gating in `src/client.test.ts`.
- `--help` now lists relevant environment variables (`DEBUG`, `MINIMAL_AGENT_NET_DBG`, `CLAUDE_CODE_EXTRA_METADATA`) and points to `docs/caching.md`.

### Fixed
- `context_management.edits = [{ type: "clear_thinking_20251015", keep: "all" }]` was sent for every `requestType === "conversation"` request, including Haiku where `thinking` is disabled. The API rejected those with `400: clear_thinking_20251015 strategy requires thinking to be enabled or adaptive`. Now gated on `body.thinking` being set (`src/client.ts:798`).

## [2.1.118] - 2026-04-25

Initial published version. Reproduces the Claude Code 2.1.118 wire protocol: header set, beta flags, system prompt shape, metadata payload, SSE response handling, and tool-loop semantics.
