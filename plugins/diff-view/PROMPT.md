The `diff-view` plugin renders unified diffs with ANSI colors.

Two ways to use it:

1. **Tool call**: when you want to present a diff to the user and you have the full unified diff text ready, call the `ShowDiff` tool with `{patch: "..."}`. The tool result will be the rendered diff (you do not need to render it again yourself).

2. **Inline tag**: when you want to embed a diff inside your own streamed text (in the middle of an explanation, not as a separate message), emit an inline tag of the form:

       <ma::plugin::diff>
       --- a/file.ts
       +++ b/file.ts
       @@ -1,3 +1,3 @@
        const x = 1;
       -const y = 2;
       +const y = 3;
        const z = 4;
       </ma::plugin::diff>

   The scanner will detect the tag and the plugin will replace it with the rendered version in the output stream.

Prefer the tool call when the user will want to see the diff as the primary content of a reply. Prefer the inline tag when you need to reference a small hunk inside a longer explanation.

Colors come from the agent's shared palette: additions render in the modern lime green (`addition` token), deletions in the hot pink/magenta used by the prompt arrow and `minimal-agent` banner (`removal` token). The plugin reads `MINIMAL_AGENT_PALETTE` from its environment so the look stays in sync with the rest of the agent's chrome.
