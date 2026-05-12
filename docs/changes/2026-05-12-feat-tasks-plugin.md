# Tasks plugin — per-session TODO list with `Task` tool

**Status:** Implementing (2026-05-12)
**Owner:** gaston (via the agent)

## Problem

Multi-step agent work today has no shared, visible task state. The model
internally tracks "what's next" but the user can't see it until the model
narrates it; and the model itself loses track when an error mid-step bumps
focus elsewhere. When the user asks the agent to plan a refactor with N
steps, both sides would benefit from a structured, mutable, real-time TODO
list:

- **For the human:** see the plan up front and watch progress.
- **For the model:** keep the plan present in context every turn, mark
  progress as it works, address tasks by stable id even after reorder.

## Options considered

### Visual layout

Three variants prototyped (see `/tmp/tasks-mock.sh` history in the design
conversation):

| Variant | Look                                                  | Verdict |
|---------|-------------------------------------------------------|---------|
| A. flat | one row per task: `N  ●  #hash  title`                | OK, but no progress affordance, no tree |
| B. progress bar header | `▎ Tasks █████░░░░  3/9 · 1 doing` | Visually heavy on every mutation; better as a `list`-only mode |
| C. framed + subtasks | `╭ ○ Tasks · ✔ marked done · 3/9` ... `╰ 3 done · 1 doing · 5 todo` | **Chosen.** Frame matches existing tool blocks (Edit/Write/Bash), action verb in header, breakdown in closer, subtasks as a light rounded tree |

User picked C with the header reshape (`╭ ○ Tasks · <verb> [#hash] · N/M`
on top, stats moved into the `╰` closer). Frame `╭ │ ╰` is in `dim`,
matching every other tool-result block in the agent.

### Glyphs (pure unicode, no nerd-font, no emoji)

| Glyph | Codepoint | Role | Color |
|-------|-----------|------|-------|
| `○` | U+25CB white circle | pending | `dim` |
| `◐` | U+25D0 half black circle | in-progress | `sky` (accent blue) |
| `✔` | U+2714 heavy check mark | done | `bold lime` |
| `✘` | U+2718 heavy ballot x | canceled (title prefix) | `dim red` |
| `├ ╰` | U+251C / U+2570 | subtask tree | `dim` |

Originally drafted with `gold` for "doing" but switched to `sky` on
review — gold-and-lime sat too close on the yellow-green axis; sky pairs
the in-progress glyph against the done glyph along the accent-blue ↔
success-green diagonal instead. Reads cleaner side-by-side.

Rejected: square `☐ ☑ ☒` (user explicitly preferred rounded), nerd-font
private-use icons (font-dependent — user wanted pure unicode), single
heavy character like `█` (too visually loud).

### Status state machine

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

Three primary states + `canceled` as sideband. Canceled rows keep their
status column as `○` (never reached `doing` for cancel-from-todo) plus a
`✘` title prefix with strikethrough and `(reason)` suffix — preserves the
"this didn't happen and here's why" reading. Rejected alternative: replace
status column with `✘`; less informative.

### ID scheme

User explicitly asked for both a number AND a short hash. Decision:

- **Number** (1, 2, 3, ...) — display position, 1-indexed, re-derived on
  every read. Top-level tasks only; subtasks don't get their own number.
  This is what the model uses most often ("mark task 4 done").
- **Hash** (`#a7b3c4`, six lowercase hex chars from `crypto.randomBytes(3)`)
  — stable across reorders/deletes. The id format that survives.
- **Subtask hash** = parent-hash + alpha suffix (`#d04c91` → `#d04c91a`,
  `#d04c91b`, ...). Self-evidencing parent-child link; up to 26 subtasks
  per parent (`a`-`z`); rejected as insufficient: realistic subtask counts
  are 2-6, never 26+.

Both number and hash accepted everywhere as `id` (handler resolution: `#`
prefix → hash; pure integer string → position; else error).

Rejected: 11-char base36-millis-rand4hex like memory uses. The user wanted
six characters. 16.7M space per session is more than enough.

### File format

JSONL at `~/.minimal-agent/sessions/<sid>.tasks.jsonl`. One task per line.
Order in file = display order. Full-rewrite on edit/reorder/remove (the
file is tiny — never more than a few hundred lines).

Rejected: markdown-bullet format like memory uses. Tasks have richer
fields (status, parent, timestamps for created/done) and the model never
hand-edits the file (unlike memory), so the JSONL pays off and the line-
oriented round-trip dance memory needs (lossless preservation of unrelated
lines) doesn't apply.

### Tool API

Single `Task` tool with `action` switch, mirroring `MemoryTool`'s shape:

| action      | required           | optional                    |
|-------------|--------------------|----------------------------|
| `add`       | `title`            | `parent`, `after`, `status` |
| `add_many`  | `titles[]`         | `parent`                    |
| `update`    | `id`, `title`      |                             |
| `status`    | `id`, `status`     | `reason` (for canceled)     |
| `start`     | `id`               | `parallel` (allow sibling doing) |
| `done`      | `id`               |                             |
| `remove`    | `id`               |                             |
| `reorder`   | `order[]` (ids)    |                             |
| `list`      |                    | `filter`, `query`, `format` |
| `clear`     |                    | `force` (if any task `doing`) |

`start` and `done` are sugar over `status` — the model uses them most
often, so giving them dedicated actions saves tokens and reads naturally
in the transcript.

`start` enforces single-doing-at-a-time discipline by default
(auto-demotes any other top-level `doing` back to `todo`). Override via
`parallel: true`. Subtask `doing` doesn't demote the parent's other
subtasks unless explicitly requested.

### Auto-injection

Per-turn `<ma::tui::tasks>` attachment on the initial user-content seam
only (mirrors `<short-term-memory>` exactly). The `ma::tui::` namespace
distinguishes agent-emitted runtime attachments from model-emitted
`<tui::...>` inline tags caught by the scanner.

Content shape (ASCII, no ANSI):

```
<ma::tui::tasks total="9" done="3" doing="1" todo="5">
1  #a7b3c4  done   Add contextSize to SessionTokens
2  #f8e21a  done   Update addSessionUsage callers
3  #d04c91  doing  Update src/session-tokens.test.ts
3a #d04c91a done   Zero-state includes contextSize
3b #d04c91b doing  Replace-not-accumulate semantics
3c #d04c91c todo   Multi-turn growth pinned
...
</ma::tui::tasks>
```

When zero tasks exist, the attachment is omitted entirely — zero overhead
unless tasks are in play. Canceled tasks are included (history matters to
the model) but with status `canceled` so the model knows not to re-pick
them up.

Loop-seam injection rejected: the model already saw the snapshot at the
start of the turn and tools update the file; re-emitting on every tool
round balloons context with stale repeats.

## Chosen design — summary

- Plugin lives at `tui-plugins/tasks/`, structurally mirrors memory.
- Per-session JSONL store, one task per line, order = display order.
- Numbered (`N`) for top-level + 6-char hex hash (`#abcdef`) for stable id.
- Subtasks: alpha-suffix hash, indented with `├ ╰` tree, no own number.
- 3 primary statuses + `canceled` sideband.
- Single `Task` tool with action switch (10 actions).
- Framed transcript block `╭ │ ╰`, header carries action verb + count,
  closer carries breakdown.
- `<ma::tui::tasks>` attachment on initial user seam only.
- Plugin color: `lime`. Plugin icon (manifest header): `◉`.

## File inventory

```
tui-plugins/tasks/
├── manifest.json
├── PROMPT.md
├── README.md
├── cli.ts
├── cli.test.ts
├── integration.test.ts
├── lib/
│   ├── parse.ts            # id gen, JSONL serialize/parse, types
│   ├── parse.test.ts
│   ├── store.ts            # TaskStore class (CRUD + ordering)
│   ├── store.test.ts
│   ├── render.ts           # ANSI / plain renderer
│   ├── render.test.ts
│   ├── attachment.ts       # <ma::tui::tasks> producer
│   └── attachment.test.ts
└── handlers/
    ├── task_tool.ts        # Task tool dispatch
    └── task_tool.test.ts
```

Plus minor agent wiring:
- `src/agent.ts` — new optional `tasksAttachment` field in Agent opts
  (one constructor field, one push at the initial user-content seam,
  mirroring `shortTermSnapshot`).
- `src/index.ts` — instantiate `TasksAttachment` and pass to Agent
  (mirrors `ShortTermSnapshot` exactly).

## Tests planned

- `parse.test.ts` — id generation (uniqueness, format), JSONL round-trip,
  validation of malformed lines.
- `store.test.ts` — CRUD, ordering on reorder, single-doing-at-a-time
  discipline on `start`, subtask id generation + rollup, canceled
  sideband, persistence round-trip.
- `render.test.ts` — header verb formatting, row formatting per state,
  subtask tree rendering, canceled row, empty state, "all done" state,
  ANSI vs plain modes.
- `attachment.test.ts` — `<ma::tui::tasks>` shape, omission on empty,
  subtask numbering (`3a`, `3b`).
- `task_tool.test.ts` — every action's happy path + a representative
  error per action (missing required field, unknown id, etc.).
- `cli.test.ts` — `list`, `add`, `done` command paths.
- `integration.test.ts` — full plan-and-execute scenario through Agent.

## Out of scope (deferred)

- Live-area footer (one-line progress bar pinned above the prompt). The
  hook (`liveAreaSlots`) is available and the renderer is reusable, but
  it's gated behind an explicit user opt-in — landing it later as a
  follow-up. Memory plugin took the same staged approach.
- Cross-session/project task scope. Today: session-scoped only.
- Due dates, priorities, tags. Out of scope for agent task-block tracking.
- Inline `<tui::task>` tag. Tasks need structure; the model uses the
  `Task` tool. No symmetric tag.
