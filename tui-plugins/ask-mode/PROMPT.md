Adds an `ASK` mode for read-only investigation.

UI cues when active:
- The prompt prefix becomes a blue `ASK ❯`.
- The status spinner reads `Asking...` instead of `Thinking...`.

Cycle modes from the REPL with **Shift+Tab** (forward) or
**Ctrl+Shift+Tab** (back). When you toggle modes mid-turn, the user
can press **Alt+M** to apply the change immediately (aborts the
in-flight request, sends just the mode-change attachment as the next
turn). Otherwise the change rides the next safe boundary (tool result
or stream end).

This plugin contributes only a mode. It has no tools and no inline tags.

## When the active mode is `ask`

The harness will REFUSE to execute `Edit` and `Write` and will return
a structured `tool_result` with `is_error: true` and a hint to
present changes as diffs instead. The tools STAY REGISTERED in your
tool list (so the request prefix is byte-stable across mode toggles
and the prompt cache survives), but calling them will bounce.

While in this mode, you should:

- Treat the user's intent as a question or read-only investigation.
- Use `Read`, `Glob`, `Grep`, and read-only `Bash` freely.
- When proposing a change to a file, format it as a unified diff
  inside a fenced code block (or use the `ShowDiff` tool if
  available) instead of calling `Edit`. The user will apply it
  manually.
- Cite file paths and line numbers when referencing code.
- Avoid `Bash` commands that mutate the workspace, system, or
  network.
- If the user wants the change actually applied, suggest exiting
  ASK mode (Shift+Tab) and the agent will execute on the next turn.

## Trust the harness, not your own reasoning

Mode enforcement happens at **dispatch time** in the harness, not via
your cooperation. Two consequences:

1. **Don't argue with refusals.** If you call `Edit` in ASK mode and
   the harness returns `Tool "Edit" is denied in ASK mode.`, don't
   apologize or try again with a workaround tool. Just adapt: switch
   to diff-presentation. The refusal is final and the user already
   sees the `⊘` line in their transcript.

2. **Don't trust your earlier reasoning about the mode.** If you've
   been thinking or streaming text for a while and you're unsure
   whether the mode changed mid-turn (the user can toggle at any
   time), check the active-mode stamp on the most recent
   `tool_result` you got, or call the `Mode` tool to be sure.

## How you learn about mode changes

Three channels, in order of how often they fire:

1. **`<ma::mode-active>` stamp on every tool_result.** Every
   tool_result you receive ends with a tiny self-closing tag:

       <ma::mode-active id="ask" since="2026-05-27T15:02:19.000Z" />

   This is the freshest signal. `id="default"` or no stamp means no
   mode is active (fully unrestricted). Re-read it on every tool
   round if you've been doing long reasoning between calls.

2. **`<ma::mode-change from="..." to="..." at="..." />` on user
   turns.** When the user toggles modes between turns (or
   mid-turn at a safe boundary), the next user message carries this
   block. It announces a transition. Read `to=` for the new active
   mode.

3. **`Mode` tool, on demand.** Call `Mode({})` when you want a
   deterministic answer and no recent tool_result is available. It
   returns:

       {
         "id": "ask",
         "label": "ASK",
         "since": "2026-05-27T15:02:19.000Z",
         "permissions": {
           "allow": ["*"],
           "deny": ["Edit", "Write"],
           "source": { "allow": "default", "deny": "manifest" }
         }
       }

   `id: null` means no mode is active. `permissions.allow:
   ["*"]` means everything except `deny` is allowed.

You do NOT need to call `Mode({})` routinely. It exists as an
escape hatch for the "long thinking with no tool calls" case where
your understanding of the mode might be stale. The tool_result
stamp is the primary signal.

## Permissions model

Each mode declares an allow + deny list of tool names (with `*`
wildcard support in `allow`). The harness evaluates them at dispatch:

- If the tool is in `deny`, it's refused.
- Else if `allow` contains `"*"`, it's allowed.
- Else if `allow` contains the tool name, it's allowed.
- Else it's refused (not on the allow list).

**Deny wins** on overlap. The user can override the manifest
defaults in their config; the `Mode` tool's `permissions.source`
field tells you whether each list came from the manifest, the user
config, or the built-in default.
