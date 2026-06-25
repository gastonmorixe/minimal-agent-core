# Emit Output

Inline-render a tool call's raw output or a safe filesystem path directly in the response stream. The harness reads the bytes and renders them inline. The model never touches the content, so it arrives uncorrupted (ANSI escapes, box-drawing characters, alignment intact).

## When to use

Use `<ma::emit::output>` ONLY when both of these are true:

1. A tool call's full stdout is needed verbatim and would otherwise be truncated or mangled if hand-copied into a response (e.g. the ascii-renderer skill's rich/tabulate output, or a large diagram).
2. The tool's stdout already landed as a raw-output blob on disk (the `<ma::agent::raw-output ... />` footer confirms it), OR the content was written to a temp file under `/tmp/`.

**Do NOT use this for normal tool calls.** The TUI's tool-output preview truncation is intentional. This tag is an escape hatch for specific cases where the model physically cannot reproduce the bytes faithfully (ASCII art, ANSI-colored tables, structured terminal graphics). For text you can summarize yourself, just summarize.

## Two source modes (mutually exclusive)

1. **By tool call** — `tool="call_00_xxx"` where the value is the tool_use_id from the `<ma::agent::raw-output>` footer:
   ```
   <ma::emit::output tool="call_00_dMMw39hweiGAR2xNzEoG1240" />
   ```
   Resolves that tool call's raw-output blob from THIS session's blob store. The tool_use_id must match the footer exactly.

2. **By filesystem path** — `path="/tmp/render_table.txt"`:
   ```
   <ma::emit::output path="/tmp/render_table.txt" />
   ```
   Only paths under `/tmp/` or within the agent's working directory are allowed. Symlinks are resolved before the prefix check.

## Worked example (ascii-renderer)

```
# I run the script:
uv run /tmp/render_tree.py

# Bash tool returns (truncated in TUI):
# ...  <ma::agent::raw-output path=".../call_00_xyz.raw" ... />

# I emit the full output inline so the user sees it:
<ma::emit::output tool="call_00_xyz" />
```

Or with a temp file:

```
# Script writes to /tmp/render_output.txt
# Then:
<ma::emit::output path="/tmp/render_output.txt" />
```

## Don't

- Don't emit after every tool call. This defeats the intentional tool-output preview limit.
- Don't use for text you can summarize. If the content is plain prose, you can retell it.
- Don't guess the tool_use_id. Only use the exact id from the `<ma::agent::raw-output>` footer.
- Don't pass a path outside `/tmp/` or the project directory — it will be refused.
- Don't emit binary files (images, PDFs) — they are detected and refused.
