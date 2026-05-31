# interleave-thinking plugin

Captures `<ma::emit::interleave-thinking>...</ma::emit::interleave-thinking>`
spans in assistant text and drops them from the user-visible output
stream. The model uses these spans as mid-response reasoning blocks
("wait, that claim is wrong, let me reconsider") that get scrubbed
before the user sees the reply.

Different from pre-response extended thinking: this is for reflection
that comes up while generating the answer.

## What it contributes

| Surface | Trigger | Handler |
|---|---|---|
| Inline tag | `<ma::emit::interleave-thinking>` | `handlers/interleave.ts` |

The handler returns empty bytes, so the tag body never reaches the
sink. Cross-chunk tag boundaries are handled by the agent's plugin
streaming layer (same machinery diff-view uses).

## Files

- `manifest.json`: tag declaration.
- `handlers/interleave.ts`: inline-tag entry point (returns empty
  rendered output).
- `PROMPT.md`: model-facing guidance on when to open a thinking span
  vs when to just answer.

## Why it's useful

Lets the model self-correct in the middle of a long reply without
polluting the visible answer. The user only ever sees the final
post-reflection prose. The hidden reasoning is still in the model's
token stream, which means subsequent inline tokens are conditioned
on the corrected thinking.

## Disabling

`plugins["interleave-thinking"].enabled = false` in
`~/.minimal-agent/config.jsonc`. With the plugin disabled, any
`<ma::emit::interleave-thinking>` the model emits will fall through to the
scanner's unknown-tag path and render as raw text to the user.
