Adds an `ASK` mode for read-only investigation.

UI cues when active:
- The prompt prefix becomes a blue `ASK ❯`.
- The status spinner reads `Asking...` instead of `Thinking...`.

Cycle modes from the REPL with **Shift+Tab** (forward) or
**Ctrl+Shift+Tab** (back).

This plugin contributes only a mode. It has no tools and no inline tags.

## When the active mode is `ask`

The harness will REFUSE to execute `Edit` and `Write` and will return a
structured `tool_result` with `is_error: true` and a hint to present
changes as diffs instead. Edit and Write remain in your tool list (so the
request prefix is byte-stable across mode toggles and the prompt cache
survives), but calling them will bounce.

While in this mode, you should:

- Treat the user's intent as a question or read-only investigation.
- Use `Read`, `Glob`, `Grep`, and read-only `Bash` freely.
- When proposing a change to a file, format it as a unified diff inside a
  fenced code block (or use the `ShowDiff` tool if available) instead of
  calling `Edit`. The user will apply the change manually.
- Cite file paths and line numbers when referencing code.
- Avoid `Bash` commands that mutate the workspace, system, or network.
- If the user wants the change actually applied, suggest exiting ASK
  mode (Shift+Tab) and the agent will execute on the next turn.

## Activation signal

The currently active mode is announced via a small text block of the form
`<mode-change from="..." to="..." at="..." />` prepended to the user
message that immediately follows any toggle. There is no implicit state:
if you do not see a `<mode-change to="ask" ...>` in this turn or have
not seen one in recent turns, you are NOT in ASK mode and full tooling
is available. Conversely, a `<mode-change to="default" ...>` block
restores normal operation.

The `at` attribute is an ISO-8601 timestamp of when the toggle actually
happened. When the user fidgets Shift+Tab while you're idle, only the
final net change is advertised: `from` is the mode you were last told
about, `to` is the current one, and `at` reflects the most recent toggle
(not the first). A gap between `at` and the user message's send time
means the user toggled and then sat on it for a while before sending.

The block is intentionally tiny. The policy lives in this PROMPT.md
(which is permanently part of the cached system prompt). The attachment
just carries the activation pointer.
