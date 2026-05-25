# ask-mode plugin

Read-only Q&A mode for the REPL. While active:

- The prompt prefix becomes a blue `ASK ❯`.
- The status spinner reads `Asking...`.
- The harness REFUSES `Edit` and `Write` tool calls. The model is told
  via `PROMPT.md` to present changes as diffs instead.

Cycle modes from the REPL with **Shift+Tab** (forward) or
**Ctrl+Shift+Tab** (back).

## What it contributes

| Surface | Value |
|---|---|
| `manifest.modes` | one entry, `id: "ask"` |

No tools, no inline tags, no event/hook subscriptions. The mode metadata
alone is enough: the agent's dispatch layer reads `modes` from every
loaded plugin and applies the named mode's policy (refuse `Edit`/`Write`,
swap prompt prefix, recolor the status spinner).

## Files

- `manifest.json`: mode definition (label, color, statusLabel, etc.).
- `PROMPT.md`: model-facing policy: ASK mode means investigate-only,
  propose changes as unified diffs or via `ShowDiff`.

## Activation signal in the system prompt

When the user toggles modes, the next user message is prefixed with a
`<mode-change from="..." to="..." at="..." />` block. The agent reads
that to know which policy is currently in effect and when the toggle
happened (ISO-8601). The block is intentionally tiny because the policy
is permanent in `PROMPT.md` (which sits on the prompt cache breakpoint).

## How the harness enforces the refusal

`Edit` and `Write` remain in the tool list (so the request prefix is
byte-stable across mode toggles and the prompt cache survives). The
dispatcher inspects the active mode at call time and returns a
structured `tool_result` with `is_error: true` and a hint to use diffs
instead. The model receives that exactly like any other tool failure
and adapts on the next turn.

## Disabling

Not a separate enable/disable, just don't activate the mode. To remove
the plugin entirely: `plugins["ask-mode"].enabled = false` in
`~/.minimal-agent/config.jsonc`.
