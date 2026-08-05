# Tool output mega-line caps

**Date:** 2026-08-05

## Summary

A Bash/`rg` hit on a minified webpack bundle produced a single ~7.2 MB
line. The model-facing 64 KB clamp still fired, but Bash buffered the
full body (under a 10 MiB drain ceiling), the blob store persisted it,
and the TUI soft-wrapped the raw last line into a wall of scrollback
rows under a truncation footer.

## Behavior

Stacked caps now cover buffer, model payload, recovery blob, and TUI:

| Layer | Cap |
| --- | --- |
| Bash / Grep drain | 512 KiB (`MAX_BASH_OUTPUT_BYTES` / `MAX_GREP_OUTPUT_BYTES`) |
| Universal per-line (all tools) | 8,192 chars (`MAX_TOOL_OUTPUT_LINE_CHARS`) |
| Model body | 64 KB / 1,000 lines (unchanged) |
| Blob `_raw` | 256 KB (`MAX_TOOL_RAW_BYTES` via `clampToolRaw`) |
| Stream pending line | 4,096 chars, then discard until `\n` |
| TUI preview width | 200 cells (`TOOL_PREVIEW_LINE_WIDTH`) |
| Streamed tail | Emit pre-clamped single row; never word-wrap mega-lines |

Read multimodal paths are unchanged: image/PDF bytes ride
`ToolExecResult.blocks`, not `content`. `truncateToolOutput` only
clamps the text summary string. Binary rejects and media decisions stay
on the existing `decideReadFile` path.

## Files

- `src/tools/truncation.ts` — `clampToolOutputLines`, `clampToolRaw`,
  wire into `truncateToolOutput`
- `src/tools/tools.ts` — tighter Bash/Grep drain ceilings; `_raw` via
  `clampToolRaw`
- `src/agent/tool-round.ts` — stream pending mega-line discard
- `src/host/ui/tool-transcript/format.ts` — width 200; streamed-tail
  no-wrap

## Tests

- `src/tools/truncation.test.ts` — per-line clamp, raw cap, totals
- `src/tools/tools.test.ts` — Bash/Grep drain + `_raw` ceiling
- `src/host/ui/tool-transcript/format.test.ts` — mega-line streamed-tail
  regression (single body row, not wrap flood)
