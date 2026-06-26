# Emit Output

Renders a tool call's raw output or a filesystem path inline in the response stream. Use the self-closing `<ma::emit::output />` tag. The harness reads the bytes from disk and drops them into your response. The content never passes through the model, so it arrives exactly as written (ANSI escapes, box-drawing characters, alignment all intact).

## Two source modes (mutually exclusive)

1. **By tool call** — `tool="call_00_xxx"` using the tool_use_id from the `<ma::agent::raw-output>` footer:
   ```
   <ma::emit::output tool="call_00_dMMw39hweiGAR2xNzEoG1240" />
   ```
   Resolves that tool call's raw-output blob from this session's blob store. The id must match the footer exactly.

2. **By filesystem path** — `path="/tmp/render_table.txt"`:
   ```
   <ma::emit::output path="/tmp/render_table.txt" />
   ```
   Allowed under `/tmp/` or within the agent's working directory. Symlinks are resolved before the prefix check.

Optional `title="..."` renders a dim heading above the content.

## When to reach for it

Good fits:

- Tool output that is already formatted and would be tedious to restate yourself (tables, diagrams, charts, structured layouts with ANSI colors, generated reports). The bytes are on disk, use them.
- Content whose alignment matters: box-drawing characters, columnar data, anything where hand-copying introduces drift.
- A long tool result you would otherwise scroll past in the truncated preview.

Don't reach for it:

- On plain prose or code you can summarize in your own words. Summarize it.
- On every tool call — the preview truncation is there for a reason. Reserve the tag for output where the verbatim form adds value.

If a blob doesn't exist for a tool call (output was under 4 KiB, not persisted), fall back to `path=` after writing the content to a temp file.

## Worked example

```
# Run a script that produces formatted output:
uv run /tmp/render_tree.py

# Bash tool result is truncated in the TUI, but includes:
# <ma::agent::raw-output path=".../call_00_xyz.raw" ... />

# Render the full output inline:
<ma::emit::output tool="call_00_xyz" />
```

Or with an explicit temp file:

```
uv run /tmp/render_table.py > /tmp/render_output.txt
<ma::emit::output path="/tmp/render_output.txt" title="Query results" />
```
