Render a unified diff with ANSI colors two ways:

1. **`DiffViewerShowDiff` tool** when the diff is the primary content of a reply. Pass the full unified diff as `patch` (output of `git diff`, `diff -u`, etc.); the tool result is the rendered diff, so you don't reproduce it yourself.

2. **Inline `<ma::emit::diff>` tag** when you want a rendered hunk embedded mid-explanation, inside your own prose. Wrap the diff text in the tag and it is replaced with the colored render in place:

       <ma::emit::diff>
       --- a/file.ts
       +++ b/file.ts
       @@ -1,3 +1,3 @@
        const x = 1;
       -const y = 2;
       +const y = 3;
        const z = 4;
       </ma::emit::diff>

Prefer the tool when the diff IS the message; prefer the inline tag when it sits inside a longer explanation. Additions render in lime green, deletions in hot pink, matching the agent's palette.
