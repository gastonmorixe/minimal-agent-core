# diff-view plugin

Renders unified diffs with ANSI colors. Surfaces a `ShowDiff` tool and a
`<ma::emit::diff>` inline tag, so the model can either:

1. **Tool call** when the diff IS the reply (`ShowDiff { patch }`).
2. **Inline tag** when the diff is embedded inside an explanation
   (`<ma::emit::diff>...</ma::emit::diff>`).

Both paths share the same renderer.

## What it contributes

| Surface | Trigger | Handler |
|---|---|---|
| Tool | `ShowDiff` (alias: `show_diff`) | `handlers/show_diff.ts` |
| Inline tag | `<ma::emit::diff>` | `handlers/inline_diff.ts` |

## Files

- `manifest.json`: tool + tag declarations.
- `handlers/show_diff.ts`: tool entry point.
- `handlers/inline_diff.ts`: inline-tag entry point.
- `handlers/render.ts`: shared renderer. Adds ANSI color from the
  agent's palette (`addition` = lime green, `removal` = hot pink).
- `PROMPT.md`: model-facing guidance on when to use the tool vs the tag.

## Colors

Reads `MINIMAL_AGENT_PALETTE` from the environment so additions and
deletions track the rest of the agent's chrome. No hard-coded ANSI
codes.

## Cross-chunk safety

The inline tag works correctly when a `<ma::emit::diff>` opens in one streamed
chunk and closes in another. That's the scanner's tail-retention
behavior, owned by the agent's plugin streaming layer; this plugin
just receives the assembled tag body.

## Disabling

`plugins["diff-view"].enabled = false` in `~/.minimal-agent/config.jsonc`.
