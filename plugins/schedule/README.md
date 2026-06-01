# schedule

Run prompts on a schedule. A minimal-agent port of Claude Code's
[scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks.md): `/loop`,
`/schedule`, and the `CronCreate` / `CronList` / `CronDelete` tools.

## What it does

- **Tools** the model uses from natural language ("remind me at 3pm", "every 5
  minutes check the deploy"): `CronCreate`, `CronList`, `CronDelete`.
- **Commands** the user types: `/loop [interval] [prompt]` and
  `/schedule "<cron>" <prompt>` / `/schedule list` / `/schedule cancel <id>`.
- **A 1-second heartbeat** (a live-area slot) that checks the store each tick and,
  for every due task, emits `prompt.inject` on the plugin bus. The host's REPL
  turns that into a prompt that runs BETWEEN turns — never mid-response.

The live-area footer row is colored and width-aware. It leads with the soonest
task (a bold `⧗` glyph + its short id + countdown) and then lists the other task
ids, as many as fit, with a `+K` overflow marker; on a narrow terminal it
degrades to `⧗ next in 26s · N tasks`, then `⧗ N tasks`, then just `⧗`. The
glyph is gold normally and turns lime when the soonest task is imminent (due
within a minute):

```
wide    ⧗ v3muss8a next in 26s  ·  aef21c3d 9f2b1a7e
narrow  ⧗ next in 26s · 3 tasks
```

The `/loop` and `/schedule` commands confirm in the same rounded, colored box
the host draws around tool calls (`⟳ loop` / `⧗ schedule` header, the prompt in
the body, id + expiry + cancel hint in the footer). List rows mark recurring
tasks `⟳` and one-shots `⧗`.

### Sub-minute intervals

Cron is minute-granular, so `/loop 5m` and up become clean cron cadences. A
**sub-minute** interval (`/loop 10s`, or `CronCreate every:"10s"`) instead runs
on the *dynamic* pace: the task stores its period in `intervalMs` and re-arms
`nextAtMs = now + intervalMs` after each fire. With the 1-second heartbeat a
`10s` loop fires about every 10 seconds (a fire still waits for any in-flight
turn to finish, since prompts inject between turns). Intervals floor at 1s.

## How it stays decoupled

The plugin imports nothing from the harness at runtime. It interacts only through
the context the host provides (`ctx.agent`, `ctx.env`, `ctx.emit`) and three host
ports added for it:

- `prompt.inject` — a bus channel the REPL listens on to enqueue a prompt.
- `commands[]` — the manifest command registry + dispatch (so `/loop` works).
- `ctx.emit` on the live-area slot — lets the heartbeat fan out onto the bus.

The cron engine, interval parser, store, and scheduler are a pure functional core
(`lib/`), heavily unit-tested; the handlers are a thin imperative shell.

## Storage

Tasks live at `~/.minimal-agent/sessions/<sid>.cron.json` (a sibling of the
queue / tasks / scratch files), so they survive a clean exit and are restored on
`--resume` if unexpired. Set `MINIMAL_AGENT_CRON_DIR` to relocate them.

## Semantics

- 5-field cron in LOCAL time (`*`, ranges, `*/steps`, lists; vixie dom/dow OR).
- `every` intervals (`5m`, `2h`, `1d`, `every 2 hours`) round to a clean cron
  cadence; odd intervals like `7m`/`90m` are rounded and the tool says so.
- One-shots delete themselves after firing. Recurring tasks expire after 7 days.
- Max 50 tasks per session. No catch-up for fires missed while busy or offline.

## Disable

`MINIMAL_AGENT_DISABLE_CRON=1` makes the heartbeat inert and the tools refuse.
