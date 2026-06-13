# Scheduled tasks: the `schedule` plugin and three host ports

> 2026-05-30. Ports Claude Code's [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks.md)
> (`/loop`, `/schedule`, `CronCreate/List/Delete`, run-a-prompt-on-a-schedule)
> into minimal-agent as a fully decoupled plugin plus the small set of host
> ports that make it possible without the plugin importing harness internals.

## What shipped

The `schedule` plugin and three host ports. Every plugin↔host interaction goes
through `ctx` + the event bus; the plugin `import type`s only from the published
`src/plugins/types.ts` port and never touches harness runtime modules.

### Host port A — `prompt.inject` (bus channel)

`src/plugins/hooks/channels.ts` registers `prompt.inject` (broadcast-async,
payload `{text, source?}`). `runReplLiveArea` subscribes and routes the text
through the SAME `onSubmit` path as a real submit, so an injected prompt is
blank-guarded, queued + persisted (crash/resume safe), wakes an idle waiter, and
drains only at a turn boundary — i.e. it fires BETWEEN turns, never mid-response.
The REPL is the sole queue owner (Mediator); injectors never touch the queue.

### Host port B — `commands[]` (manifest command registry + dispatch)

A new manifest contribution `commands[]` (mirrors `tuis`/`modes`/`liveAreaSlots`):
`{name, summary, argHint?, handler}`. The loader collects them into a global
registry (first-wins on cross-plugin name collision) and exposes
`getCommands()` / `hasCommand()` / `listCommandInfo()` / `dispatchCommand(line)`.
A pure `src/slash-command-parse.ts` recognizes `/<name>` lines (strictly — pasted
paths like `/usr/bin` never match). `runReplLiveArea.onSubmit` intercepts a
registered `/<name>`, dispatches it, and acts on the returned `CommandResult`
discriminated union (`expand` → a model turn, `notice`/`error` → scrollback,
`none` → nothing). Commands work headlessly; the overlay is optional.

A `listCommands()` read-API is injected into hook + event handler contexts so an
overlay can read the registry without importing the loader.

### Host port C — `emit` on the live-area handler context

`LiveAreaHandlerContext` gains `emit?(channel, payload)`, wired in
`src/ui/status/live-area-scheduler.ts` to the scheduler's bus. The live-area slot is the
only handler the host invokes on a fixed timer, so this turns it into a legal
periodic actor — the schedule heartbeat fires `prompt.inject` from it.

### `schedule` plugin

Pure functional core (`lib/`: cron parse/eval, interval→cron, store, scheduler,
tick) + thin handlers. `CronCreate/CronList/CronDelete` tools (model-driven from
NL), `/loop` and `/schedule` commands (deterministic, write to the same store),
and a 1-second heartbeat slot that injects due tasks. Tasks persist at
`~/.minimal-agent/sessions/<sid>.cron.json` (restored unexpired on `--resume`).
5-field cron in local time (vixie dom/dow), 50-task cap, 7-day expiry, one-shots
self-delete. `MINIMAL_AGENT_DISABLE_CRON=1` disables it; `MINIMAL_AGENT_CRON_DIR`
relocates the store.

### slash-menu overlay (superseded by the external `ma-slash-menu`)

This epic originally shipped a minimal in-repo `plugins/slash-menu` overlay
(commands-only autocomplete). It has since been **removed** in favor of the
external `ma-slash-menu` plugin (in the `minimal-agent-plugins` repo, installed
under `~/.agents/plugins` / `~/.minimal-agent/plugins`), the single slash overlay:
it reads the same host registry via `ctx.listCommands()` and adds skill discovery,
per-item token-cost chips, and the `/` (commands+skills) / `$` (skills-only)
triggers. Two overlays bound the same `editor.key` / `editor.footer.set` channels
at once, so the in-repo duplicate was dropped. See
[`2026-05-31-slash-menu-dedup-and-config.md`](2026-05-31-slash-menu-dedup-and-config.md).

The host ports above (A/B/C) are what make ANY overlay possible; the registry is
host-owned, so `/loop` and `/schedule` dispatch headlessly whether or not an
overlay is installed.

## Tests

- Pure cores: `cron` (incl. a property test), `interval`, `scheduler`, `store`,
  `tick`, `slash-command-parse`, `match`, `loop-parse`, `loop-md`.
- Host ports: `prompt-inject-e2e`, `command-repl-e2e`, `commands` (manifest +
  dispatch), live-area `ctx.emit`.
- Integration: schedule handler flow and the capstone `fire-e2e` (real plugin in
  a real REPL fires a task end-to-end through every layer). (The earlier
  cross-plugin `slash-menu + schedule` test lived inside the removed in-repo
  overlay; the external `ma-slash-menu` carries its own command-registry tests.)

## Deviations from the cloud product

- Jitter is sub-minute (id-derived) rather than the cross-session 30-minute
  spread — a single local session wants its loop to fire promptly.
- Self-paced `/loop` (no interval) approximates "Claude chooses the interval"
  with a default cadence + a prompt re-arm hook; the full Monitor-tool streaming
  path is out of scope.
- Commands + scheduler are REPL-scoped (the feature is inherently interactive).
