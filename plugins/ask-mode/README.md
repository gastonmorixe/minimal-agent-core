# ask-mode plugin

Read-only Q&A mode for the REPL. While active:

- The prompt prefix becomes a blue `ASK ❯`.
- The status spinner reads `Asking...`.
- The harness REFUSES `Edit` and `Write` tool calls. The model is told
  via `PROMPT.md` to present changes as diffs instead.

Cycle modes from the REPL with **Shift+Tab** (forward) or
**Ctrl+Shift+Tab** (back). Press **Alt+M** mid-turn to apply a
pending mode change immediately (otherwise the change rides the next
safe boundary).

## What it contributes

| Surface | Value |
|---|---|
| `manifest.modes` | one entry, `id: "ask"` |

No tools, no inline tags, no event/hook subscriptions. The mode
metadata alone is enough: the agent's dispatch layer reads `modes`
from every loaded plugin and applies the named mode's policy
(allow/deny permissions, swap prompt prefix, recolor the status
spinner).

## Files

- `manifest.json`: mode definition (label, color, statusLabel,
  permissions).
- `PROMPT.md`: model-facing policy. Explains harness-side
  enforcement, the `<ma::mode-active>` stamp on every tool_result,
  the `<ma::mode-change>` advertisement on user turns, and the
  built-in `Mode` tool as an escape hatch.

## Permissions

ASK ships with:

```jsonc
"permissions": {
  "allow": ["*"],
  "deny":  ["Edit", "Write"]
}
```

Meaning: every tool except `Edit` and `Write` may run. Deny wins on
overlap; `"*"` in `allow` means "everything except deny". The user
can override either list in their config (see "Overriding" below).

## How the harness enforces the refusal

`Edit` and `Write` STAY REGISTERED in the request body (so the
`tools` array is byte-stable across mode toggles and the prompt
cache survives), but `ModeManager.isToolAllowed` returns `allowed:
false` for them at dispatch time. The agent's tool-dispatch loop
synthesizes a structured `is_error: true` `tool_result` with a
refusal message:

```
Tool "Edit" is denied in ASK mode. Present the proposed change as a unified diff in a fenced code block (or via the ShowDiff tool); the user will apply it manually.
```

The model receives that exactly like any other tool failure and
adapts on the next turn.

## Activation signals to the model

Three channels (see PROMPT.md for the model-facing version):

1. **`<ma::mode-active id="..." since="..." />`** trailing on every
   `tool_result` content. The freshest signal; the model sees it
   on every tool round.
2. **`<ma::mode-change from="..." to="..." at="..." />`** on the
   next user message after a toggle. Announces a transition.
3. **`Mode` tool** (built-in, zero-arg) for the model to
   explicitly query the active mode + effective permissions.

The activation block is intentionally tiny. The policy text lives
in `PROMPT.md` (which sits behind the cached `pluginBlock`
breakpoint), so toggles cost zero prompt-cache invalidation.

## Overriding via user config

User config at `~/.minimal-agent/config.jsonc`:

```jsonc
{
  "plugins": {
    "ask-mode": {
      "modes": {
        "ask": {
          "permissions": {
            // Tighten further: also block Bash.
            "deny": ["Edit", "Write", "Bash"]
          }
        }
      }
    }
  }
}
```

Or to relax (allow Edit but keep Write blocked):

```jsonc
{
  "plugins": {
    "ask-mode": {
      "modes": {
        "ask": {
          "permissions": {
            "deny": ["Write"]
          }
        }
      }
    }
  }
}
```

User config REPLACES the manifest array at the per-list granularity
(allow and deny are independent). Setting `allow` does not affect
the manifest's `deny`; setting `deny` does not affect `allow`. To
revert to manifest behavior, drop the key entirely.

## Disabling

Not a separate enable/disable, just don't activate the mode. To
remove the plugin entirely:

```jsonc
{
  "plugins": {
    "ask-mode": { "enabled": false }
  }
}
```
