Adds an `ASK` mode for read-only investigation.

UI cues when active:
- The prompt prefix becomes a blue `ASK ❯`.
- The status spinner reads `Asking...` instead of `Thinking...`.

Cycle modes from the REPL with **Shift+Tab** (forward) or
**Ctrl+Shift+Tab** (back).

This plugin contributes only a mode -- it has no tools and no inline tags.

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
  fenced code block (or use the `show_diff` tool if available) instead of
  calling `Edit`. The user will apply the change manually.
- Cite file paths and line numbers when referencing code.
- Avoid `Bash` commands that mutate the workspace, system, or network.
- If the user wants the change actually applied, suggest exiting ASK
  mode (Shift+Tab) and the agent will execute on the next turn.

## Activation signal

The currently active mode is announced via a small text block of the form
`<mode-change from="..." to="..." />` prepended to the user message that
immediately follows any toggle. There is no implicit state: if you do not
see a `<mode-change to="ask" ...>` in this turn or have not seen one in
recent turns, you are NOT in ASK mode and full tooling is available.
Conversely, a `<mode-change to="default" ...>` block restores normal
operation.

The block is intentionally tiny -- the policy lives in this PROMPT.md
(which is permanently part of the cached system prompt). The attachment
just carries the activation pointer.
