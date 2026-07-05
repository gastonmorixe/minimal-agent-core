# Changelog

All notable changes to this project are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the project follows a pragmatic, date-stamped release rhythm.

## [Unreleased]

### Feature: `--output-format {text,json,stream-json}` on the modern agent core

Non-interactive runs (`--prompt`, `-`, a bare positional) can now select an
output format explicitly. `text` (the default) is unchanged: human progress to
stderr, the final answer to stdout when piped. `json` and `stream-json` both
drive the port-injected `AgentCore` and emit its structured `AgentEvent` stream
as JSON Lines on stdout (`turn_started` → `item_started` → `item_completed` →
`turn_completed`, with `tool_result` carrying the `tool_result.id ===
item_started.id` join for tool turns). `json` is buffered; `stream-json` flushes
each event live and additionally emits token-level `text_delta` and
`thinking_delta` events as the model streams.

`--json` is now a documented alias for `--output-format json`. This changes its
wire output: it previously emitted a single synthetic final-answer line
(`item_completed` with id `"final"`); it now emits the full event stream, where
the answer is the real `item_completed` (itemType `text`) followed by
`turn_completed`. A consumer that read the last line for the answer should
instead take the `item_completed` text event (or the terminal `turn_completed`
for stop reason + usage). `--output-schema` enforcement is unchanged and stays
on the buffered validate-before-stdout path.

### Architecture: provider-decoupling ratchet + first cleanups

New fitness test (`src/architecture.provider-decoupling.test.ts`) enforces
the layering rule: provider-specific code (names, model ids, wire details)
lives in `plugins/<provider>/`, never `src/` core — comments may reference
providers, code may not. Violations must match a frozen, shrink-only
baseline, so new leaks fail CI immediately and cleanups must ratchet the
baseline down in the same commit. First cleanups shipped behind it:
Anthropic media limits moved behind the `ProviderAdapter.mediaLimits` hook
(core falls back to a neutral conservative floor), `--list-models` went
provider-neutral via the new `ProviderPlugin.listLiveModels` hook, the
beta-flag model gates unified into plugin-owned `beta-gates.ts` (both
transports now share one predicate — the drift class behind the fable-5
context-1m bug), and the tool-output redaction allowlist dropped its
vendor-specific header literal for a neutral session-id pattern.

### Feature: Claude Fable 5 in the model catalog

`claude-fable-5` (the public Mythos-class flagship launched 2026-06-09) is now
registered end-to-end: capabilities (Opus-4.8 twin, 1M context, 128K output,
adaptive thinking, effort up to `max`, no fast tier), flat $10 / $50 pricing,
`[1m]` alias, and the `context-1m-2025-08-07` beta on both transports. The
original symptom was a 429 on every OAuth request because the unregistered id
dropped the Claude Code preamble.

### Fix: fast-mode is capability-gated on the legacy transport

`speed:"fast"` (sticky `--fast` / `MINIMAL_AGENT_FAST=1`) used to reach the
wire for models with no fast tier (Fable 5, Sonnet, Haiku), which the server
rejects with 429 "Usage credits are required for fast mode". The legacy client
now consults the model registry's `speedFast` capability and drops both the
body field and the `fast-mode-2026-02-01` beta header (with a diagnostic
warning) when unsupported, matching the canonical transport. SessionInfo's
`fast` line now reflects the CLI flag too (the host mirrors the resolved state
into `MINIMAL_AGENT_FAST`) and cross-checks the capability so it never claims
a fast tier the model lacks.

### Build: scope the test gate to first-party source

`bun test` scanned from the repo root, so it descended into the gitignored,
vendored research clones under `private/` (a copy of `gemini-cli` and others)
that ship their own vitest suites and unresolvable dependencies. The gate
counted ~1300 of those as failures even though every first-party test passed.
New `bunfig.toml` sets `test.pathIgnorePatterns` to exclude `private/`,
`research/`, `work/`, `docs/internal/`, `.swarm/`, and `tmp/`, so the gate now
sees only `src/` and `plugins/` (4588 pass, 10 skip). `private/` is also added
explicitly to oxlint's `ignorePatterns`. No first-party code changed.

Also fixed a flaky assertion in `plugins/memory/cli.test.ts`: the `--limit`
test checked the raw list output with `not.toContain("e1")`, but bullet ids are
base36+hex, so `e1` could land inside a randomly generated id and fail the run
only under full-suite timing. The test now asserts on the body column.

### Feature: oversize images auto-fit instead of being rejected

A 4K screenshot used to bounce with a 400 (`image exceeds 5 MB`). Oversize
images are now downscaled and re-encoded to fit the wire budget before sending:
the long edge is capped at 1568px and a quality/scale ladder brings the encoded
bytes under the cap. New `src/media/transform.ts` (`fitImageToBudget`,
`canTransformImages`, `VISION_LONG_EDGE_PX`). `src/media/limits.ts` now measures
the base64-encoded size (`base64EncodedSize`), the real wire weight, for both
the per-item and per-request caps, and `src/media/resolve.ts` runs the fit pass
(`maybeFit`) and reports what it shrank.

### Feature: native clipboard paste (text and image) on Ctrl+V

`src/media/clipboard.ts` was rebuilt on Bun's native clipboard pipeline
(`Bun.Image.fromClipboard`, plus `clipboardText` / `clipboardImageSync` /
`hasClipboardImage`). The editor (`src/editor-controller.ts`) gained a Ctrl+V
handler that pulls system clipboard text, or a clipboard image routed through
the media interceptor into an `[Image #id]` token, even in terminals where
Cmd+V never reaches the process. When no handler is wired, Ctrl+V inserts no raw
control byte.

### Fix: macOS screenshot paths with Unicode spaces no longer shatter

Dropped or pasted screenshot paths like `Screenshot 2026-05-49.35␏PM.png` carry
a narrow no-break space (U+202F) or no-break space (U+00A0). The media
tokenizer and path detection (`src/media/detect.ts`, `ingest.ts`) now preserve
those code points instead of splitting on them. As a backstop, `src/tools.ts`
self-heals a path whose Unicode space was normalized to a plain space
(`resolveWhitespaceConfusablePath`): Read and Edit resolve the real file instead
of returning ENOENT, and Read notes that it resolved the path.

### Fix: connect-phase network failures retry instead of killing the turn

A failure before the first response byte (TCP connect timeout, ECONNRESET, DNS
EAI_AGAIN, HTTP/2 GOAWAY, "socket hang up") used to stop the agent. New
`src/network/transient-error.ts` classifies these as `network_error` and
`withRetry` (`src/llm/transport/retry.ts`) retries them on the fast curve. User
aborts (Ctrl-C) still propagate untouched. `src/client.ts` also now honors
`x-should-retry: false`, so a deterministic 400 (bad request, oversize image)
propagates at once instead of retry-storming.

### Feature: planning guidance in the system prompt

The `tasks` plugin injects a planning fragment (`prompts/planning.md`) that
tells the model to plan and work in phases with tasks and subtasks. It is
self-gated on `tools.userDefined`, so a model without tool support does not get
the guidance. New `plugins/tasks/handlers/planning_fragment.ts`, wired through a
`promptFragments` entry in the manifest.

### Feature: sub-agent result protocol via a tool, plus context-gated tools

A worker now finishes by calling `ReportResult({summary, artifacts?,
incomplete?})` as its final action. The handler (running in the worker process)
writes the result sentinel deterministically with an atomic temp-then-rename, so
the model never hand-rolls a path or JSON. The completion transport is layered,
best to worst: the `ReportResult` tool call, a manual sentinel write, a
distilled final message, then the `incomplete` floor, so a provider without tool
calling still works. When a worker reports findings but a contracted
`expectArtifacts` file is missing, the supervisor keeps the `incomplete` verdict
but salvages the summary onto the status, so `AgentResult` shows the findings
instead of forcing a transcript dive.

This rides a new general loader feature: a tool handler may export
`available(ctx)` to hide itself from the model's tool list for a turn (and drop
its system-prompt section when its whole tool surface is hidden). Dispatch is
not gated, a hidden tool's handler still runs if invoked, so availability
controls advertisement, not execution. `ReportResult` uses it to stay invisible
to the lead (which has no result path) while workers carry it. New
`plugins/sub-agents/lib/report.ts` + `handlers/report_result.ts`,
`available` plumbing in `src/plugins/loader.ts` and `types.ts`. See
`docs/changes/2026-06-01-subagent-result-protocol-and-tool-availability.md`.

## 2026-06-04

### Fix: sub-agent workers inherit the lead's model (no silent downgrade)

Delegating to a built-in specialist silently ran the worker on a cheaper model:
`explorer` dropped to Haiku, `worker`/`planner`/`integrator` dropped to Sonnet,
even while the lead was on Opus. The model-precedence order in
`plugins/sub-agents/lib/service.ts` put the provider's per-role recommendation
(scout→Haiku, balanced→Sonnet, deep→Opus) AHEAD of the lead's own model, so the
"inherit the lead's model" path was dead for the specialists, which is most
spawns. The downgrade also made `incomplete · no deliverable` outcomes more
likely, since a weaker worker drowns on deep work.

Fix makes the role-recommendation rung opt-in. New `resolveAutoTier` reads
`MINIMAL_AGENT_SUBAGENT_AUTO_TIER`; `makeRecommendForRole` returns undefined
unless it is `1`, so workers now inherit the lead's model by default. Precedence
(default): per-spawn `model` → `MINIMAL_AGENT_SUBAGENT_MODEL` → lead's live model
→ omit `--model`. With `MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1` the provider role
recommendation slots back in just below the env override. An explicit per-spawn
model and the env override always win.

Also corrected the model-facing docs that described the cheap default as
intended (`manifest.json` `model` param description, `PROMPT.md`, library/service
comments) and unwrapped the hard-wrapped worker result-protocol template to save
wire tokens. New tests in `runtime.test.ts` and `handler-deps.test.ts`. See
`docs/changes/2026-06-04-subagent-model-inheritance.md`.

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
