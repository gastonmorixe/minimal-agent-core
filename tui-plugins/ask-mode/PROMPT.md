Adds an `ASK` mode to the agent. When active:

- The prompt prefix becomes a blue `ASK ❯` so the user can see at a glance
  the agent will not modify the workspace.
- The status spinner reads `Asking…` instead of `Thinking…`.
- The tool list sent to the model has `Edit` and `Write` removed entirely,
  so the model can't reach for them even if it wants to.
- A short system-prompt addendum reminds the model of the read-only policy
  and tells it to propose changes as code blocks or diffs instead of
  applying them.

Cycle modes from the REPL with **Shift+Tab**. The cycle order is
`[no-mode, ASK, …other modes…]`. `Ctrl+Shift+Tab` cycles backward.

This plugin contributes only a mode — it has no tools and no inline tags.
