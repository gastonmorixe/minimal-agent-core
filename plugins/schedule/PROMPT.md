Use the `ScheduleCronCreate`, `ScheduleCronList`, and `ScheduleCronDelete` tools to run a prompt on a
schedule, poll something repeatedly, or set a one-time reminder. A scheduled
prompt is injected as a user turn BETWEEN turns (never mid-response), so it polls
a deploy, babysits a PR, or reminds the user without you having to busy-wait.

## When to schedule

- The user says "remind me at 3pm to push the release": one-shot:
  `ScheduleCronCreate({ cron: "0 15 * * *", prompt: "Remind me to push the release.", recurs: false })`.
- "in 45 minutes, check whether the integration tests passed": one-shot with an
  interval: `ScheduleCronCreate({ every: "45m", prompt: "Check whether the integration tests passed.", recurs: false })`.
- "every 5 minutes, check if the deploy finished": recurring:
  `ScheduleCronCreate({ every: "5m", prompt: "Check if the deploy finished and tell me what happened." })`.
- "weekdays at 9am, summarize overnight CI": `ScheduleCronCreate({ cron: "0 9 * * 1-5", prompt: "Summarize overnight CI." })`.

## Rules

- Provide EITHER `cron` (a standard 5-field expression: `minute hour day-of-month
  month day-of-week`) OR `every` (a human interval like `5m`, `2h`, `1d`). All
  times are LOCAL. `0 9 * * *` means 9am where the user is, not UTC.
- `recurs` defaults to true. Set it `false` for one-time reminders; a one-shot
  deletes itself after it fires.
- A session can hold up to 50 tasks. Recurring tasks auto-expire after 7 days
  (they fire a final time, then delete). Tasks are session-scoped and restored on
  `--resume` if unexpired.
- To answer "what scheduled tasks do I have?" call `ScheduleCronList`. To cancel one, call
  `ScheduleCronDelete` with its 8-character id (from `ScheduleCronList` or the create confirmation).
- Don't schedule irreversible actions (push, delete, deploy) unless the user
  already authorized them in this conversation.

## Commands

The user can also type `/loop` and `/schedule` directly:

- `/loop 5m check the deploy`: recurring loop on a fixed interval.
- `/loop check CI and address review comments`: a loop whose prompt runs at a
  default cadence (the user can stop it with Esc or `ScheduleCronDelete`).
- `/loop`: runs a built-in maintenance prompt (or the project's `.claude/loop.md`).
- `/schedule "0 9 * * 1-5" run the morning report`: schedule by raw cron.
- `/schedule list` / `/schedule cancel <id>`: manage tasks.

These write tasks to the same store your `Cron*` tools use, so `ScheduleCronList` shows
them and `ScheduleCronDelete` cancels them.

Scheduling can be disabled entirely with `MINIMAL_AGENT_DISABLE_CRON=1`.
