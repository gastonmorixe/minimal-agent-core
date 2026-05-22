The `tasks` plugin gives you a structured, mutable, per-session TODO list
the user can see in real time. State lives at
`~/.minimal-agent/sessions/<sid>.tasks.jsonl` and is auto-injected into
every user turn as a `<ma::tui::tasks …>…</ma::tui::tasks>` attachment so
you always know the current plan.

## When to use

- **Use it** when you're about to do something with **3+ distinct steps**
  the user will want to track. Most refactors, multi-file changes,
  bug investigations with branching hypotheses, anything where "the plan"
  is a meaningful artifact.
- **Use it** when the user says "make a plan", "what would you do",
  "let's tackle X", or otherwise signals they want to see the shape of
  the work before you start.
- **A single task with 3+ substeps** worth tracking → use `parent` to
  nest. Tree depth is limited to 2 (top-level + one layer of children).
  Don't try to nest deeper.

## When NOT to use

- Trivial 1-2 step tasks. Just do them.
- Recording past decisions or lessons-learned. That's `memory`.
- Tracking transient agent-internal state ("remember to re-grep after
  this edit"). Use `short-term` memory.
- Free-form notes for the user. Put those in your prose response.

## Workflow

1. **Plan in one shot.** `Task({action: "add_many", titles: […]})` at the
   start. Don't drip-feed tasks one at a time. The user wants to see
   the whole plan up front.
2. **Start before you work.** `Task({action: "start", id: N})` flips the
   task to `doing` AND demotes any other `doing` task back to `todo`
   (single-focus discipline). The user's progress meter stays
   unambiguous. Use `parallel: true` only if you genuinely have two
   tasks in flight at once (rare).
3. **Done when materially complete.** `Task({action: "done", id: N})`.
   Don't pre-mark. Only mark `done` when you've actually finished the
   work the title described.
4. **New substeps surface as you work.** If you discover a task is
   actually 3 substeps, `Task({action: "add", title: "…", parent: "#<hash>"})`
   for each. Then `start` the first child.
5. **Plans change.** If the user redirects, don't silently abandon
   tasks:
   - If a task was never started, `remove` it.
   - If a task is still in-flight or was completed but reverted,
     `status: "canceled"` with a one-line `reason`.

## Id resolution

Every action that takes an `id` accepts THREE shapes:

- **Position** (1-indexed integer). `id: 3` means the third top-level task
  in the list. Most natural in conversational use.
- **Bare hash**: `id: "a7b3c4"`. Six lowercase hex chars.
- **Prefixed hash**: `id: "#a7b3c4"`. Same as bare. The `#` is purely
  cosmetic.
- **Subtask hash**: `id: "a7b3c4a"`. Parent's hash + a-z suffix.

The hash is stable across reorders and deletes. The position shifts. So
when reordering or doing bulk operations, lean on the hash. For single
"mark the next one done" interactions, the position is fine.

## Status state machine

```
            add
              │
              ▼
   ┌─────┐   start    ┌──────┐   complete    ┌──────┐
   │ todo│ ─────────► │doing │ ────────────► │ done │
   └──┬──┘            └──┬───┘               └──────┘
      │                  │
      └──── cancel ◄─────┘
```

- `start` (or `status: "doing"`) on a `todo` or `done` task.
- `done` (or `status: "done"`) on a `doing` task.
- `status: "canceled"` from any state, with optional `reason`.
- `status: "todo"` to reset (rare, usually `start` again instead).

## Examples

Start a new plan:

```
Task({
  action: "add_many",
  titles: [
    "Add contextSize to SessionTokens",
    "Update addSessionUsage callers",
    "Update clearSessionTokens to reset contextSize",
    "Update src/session-tokens.test.ts",
    "Run biome format + lint on touched files"
  ]
})
```

Work through it:

```
Task({action: "start", id: 1})
   …do the work, then…
Task({action: "done", id: 1})
Task({action: "start", id: 2})
   …
```

Discover substeps mid-task:

```
Task({action: "add", title: "Zero-state includes contextSize", parent: "#d04c91"})
Task({action: "add", title: "Multi-turn growth pinned", parent: "#d04c91"})
Task({action: "start", id: "#d04c91a"})   # subtask hash = parent + 'a'
```

Cancel a step the user redirected away from:

```
Task({action: "status", id: 6, status: "canceled", reason: "user wants to keep the legacy column"})
```

## Don't

- Don't echo the rendered task list back to the user as prose. They see
  the rich rendering in the transcript already. Restating in markdown is
  noise.
- Don't `remove` a task as a way of "cleaning up". That erases the
  audit trail. Use `status: "canceled"` for anything that materially
  existed but was later abandoned. Only `remove` tasks you accidentally
  added or that the user explicitly asks to drop.
- Don't fight the single-doing discipline with `parallel: true` unless
  you genuinely have parallel work. The discipline is the point. The
  user reads the meter as "where is the agent right now".
- Don't try to nest beyond depth 2 (subtask of a subtask). The plugin
  refuses. Flatten the deepest layer into the parent's title or split
  into a sibling top-level task.
