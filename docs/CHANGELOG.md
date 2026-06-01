# Changelog

All notable changes to this project are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the project follows a pragmatic, date-stamped release rhythm.

## [Unreleased]

- (placeholder for the next change)

## 2026-05-31

### Chore: clear the `bun run check` gate (lint, biome, refactor)

Drove the full gate back to green with zero warnings on the uncommitted feature
drop (sub-agents, schedule, config/usage/model-info plugins, prompt
markdownization, first-run onboarding, usage tracking).

- **oxlint** (1 error + 3 warnings → 0/0): removed an unnecessary template
  expression in `plugins/schedule/lib/box.ts`; replaced a spread-in-`map` with a
  conditional property assign in `PluginLoader.listCommandInfo`
  (`no-map-spread`); classified `src/plugins/loader.ts` into the existing
  `max-lines` override alongside the other large coordinator files.
- **agent.ts back under the line budget by extraction, not exemption.** The
  per-turn attachment / abort-marker / media-ingest / usage-persistence work
  pushed `src/agent.ts` from passing to 820 counted lines. Following the
  documented split pattern, moved `rollbackPendingTurn` and
  `repairOrphanedToolUse` into a new `src/agent/history-repair.ts` (pure
  functions; the `Agent` methods now delegate), with a focused
  `history-repair.test.ts`.
- **biome import-sort**: fixed the `import { abortBus, type AbortReason }`
  ordering in `src/agent/repl-live-area.ts`.
- Gate result: typecheck, lint (0/0), `format:check`, `biome:check`,
  `docs:check`, and `bun test` (4443 pass / 0 fail) all green.

### Fix: opus-4-8 tool-batch hallucination (gate interleaved-thinking off)

opus-4-8 under the `interleaved-thinking-2025-05-14` beta emitted huge parallel
tool batches whose interleaved thinking reasoned about same-turn tool results
that cannot exist yet (every tool in a turn runs after the turn ends), producing
a self-inflicted "results are stalling / batching" spiral and many duplicate
tool calls. Wire-proven against `.net-dbg` captures; absent on opus-4.7 under the
same beta, so it is a model-behavior change (4.7 -> 4.8), NOT the provider
refactor (the harness delivers every tool result correctly). Fix omits the
interleaved-thinking beta for opus-4-8 only (4.6/4.7 + sonnet keep it); escape
hatch `MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING=1`. See
`docs/changes/2026-05-31-fix-opus48-interleaved-thinking-tool-batching.md` and
TODOS.md `T-7c3f02`.

### First-run onboarding: `bunx`-runnable, plugin auto-clone, welcome card

Makes the agent usable on a clean device with no manual install.

- **`bin` field** so it runs through `bunx github:gastonmorixe/minimal-agent`
  (public repos) or `bun add -g "git+https://x-access-token:<TOKEN>@github.com/…"`
  (private). Bun runs the TypeScript source directly: no build step.
- **First-run plugin bootstrap** clones the extended first-party plugins
  (`Fetch`, `Skill`, slash-menu, …) into `~/.minimal-agent/plugins` once. The
  loader gained a fourth root, `user`, with precedence
  `project > home > user > embedded`.
- **Token-aware + safe:** resolves `MINIMAL_AGENT_GITHUB_TOKEN` →
  `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token`, injected via an inline git
  credential helper so the token never reaches argv, the clone URL, or the
  cloned `.git/config`. Best-effort: no git / offline / no token degrades to
  the embedded plugins, never crashes.
- **Welcome card** on a cold interactive start frames the one-time setup
  (sign in, fetch mdstream, fetch plugins).
- Controls: `MINIMAL_AGENT_NO_PLUGIN_SYNC=1`, `MINIMAL_AGENT_PLUGINS_REPO`,
  config `pluginSync` / `pluginsRepo`. Verified end-to-end in a clean
  `oven/bun:1.3-debian` container.

See `docs/changes/2026-05-31-first-run-onboarding.md`.

### Schedule plugin: TUI redesign + sub-minute intervals

- **New icons.** Replaced the `⏰` color-emoji (which ignored color) and the
  faint `◷` with monochrome, SGR-colorable glyphs: `⧗` (a point in time /
  one-shot) and `⟳` (a recurring loop). Tool-header icons now render bold so
  thin glyphs read at terminal size.
- **Colored boxed output.** `/loop` and `/schedule` confirmations, and the
  `Cron*` tool results, render in the same rounded `╭─ │ ╰─` box the host draws
  around tool calls (header glyph + cadence + timestamp, prompt in the body,
  id + expiry + cancel hint in the footer).
- **Width-aware live-bar footer.** Leads with the soonest task (`⧗` + short id +
  countdown), then lists the other task ids with a `+K` overflow marker;
  degrades to `⧗ next in 26s · N tasks`, then `⧗ N tasks`, then bare `⧗` as the
  terminal narrows. Glyph is gold normally, lime when the soonest task is due
  within a minute.
- **Sub-minute intervals fixed.** `/loop 10s` (and `CronCreate every:"10s"`) no
  longer round up to 1 minute. Cron is minute-granular, so sub-minute cadences
  now run on the dynamic pace with a new `CronEntry.intervalMs` that re-arms
  after each fire (floored at 1s). With the 1-second heartbeat a `10s` loop
  fires about every 10 seconds (a fire still waits for any in-flight turn).
- Model-facing tool-result `content` stays plain text; all color lives in the
  TUI-only surfaces.

## 2026-05-30

### Schedule plugin (`/loop`, `/schedule`, `Cron*` tools)

Run prompts on a schedule, ported from Claude Code's scheduled tasks.

- **Three tools** (`CronCreate`, `CronList`, `CronDelete`) the model drives from
  natural language ("remind me at 3pm", "every 5 minutes check the deploy").
- **Two commands** (`/loop`, `/schedule`) for direct user control.
- **1-second heartbeat** that injects due prompts between turns.
- Tasks persist at `~/.minimal-agent/sessions/<sid>.cron.json` and restore on
  `--resume` (unexpired tasks only).
- Disable with `MINIMAL_AGENT_DISABLE_CRON=1`.

See `docs/changes/2026-05-30-schedule-plugin.md`.

### Sub-agents plugin

Delegate work to background `minimal-agent` workers (`SpawnAgent` and friends),
watch them in a live fleet widget, and fold their distilled results back. Built
on generic seams; the core agent loop never learns the word "sub-agent". Disable
with `MINIMAL_AGENT_DISABLE_SUBAGENTS=1`.

See `docs/changes/2026-05-30-sub-agents.md`.

### Prompts as markdown

Plugin system-prompt fragments and tool descriptions move to markdown, composed
under role-typed `<ma::sys::*>` wrappers.

See `docs/changes/2026-05-30-prompts-as-markdown.md`.

### Tool routing + search directives

See `docs/changes/2026-05-30-tool-routing-search-directives.md`.
