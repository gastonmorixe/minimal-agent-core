# usage

Token-usage statistics across every saved session, shipped as the `/usage`
slash command plus a footer overlay. Same data + renderer as the top-level
`usage` CLI command.

```
  Today  Last 24h  Last 30d  YTD  Last year  [All time]
  Total 117.4M tok  $98.97  [~]  50825 turns
  anth-4.8     ████████████████████████ 63.9M  $86.08  [~]
  anth-4.7     ███████████████▌░░░░░░░░ 41.2M  <$0.01  [~]
  anth-4.6     ███▋░░░░░░░░░░░░░░░░░░░░░  9.7M  $12.48  [~]
  oai-5.5      ▏░░░░░░░░░░░░░░░░░░░░░░░░ 331.2k  [E]
  ← → period   Esc close

❯
```

## What it does

- `/usage` opens an interactive overlay in the editor's footer band. `←`/`→`
  (or `h`/`l`) switch the time window; `1`-`6` jump; `Esc`/`q` close.
- Windows: **Today**, **Last 24h**, **Last 30d**, **YTD**, **Last year**,
  **All time**. The overlay scans the session log ONCE on open and precomputes
  every window, so switching periods is instant (no re-read).
- Each row is total tokens for that provider/model, drawn as a 1/8th-block bar
  (same visual language as the quota footer), with exact USD cost when known.
- `/usage <period>` (e.g. `/usage month`) prints that window once to
  scrollback without opening the overlay (headless-friendly).

## Provenance marks

- `[R]` real — summed from the billed `usage` saved on each assistant turn.
- `[E]` estimated — no saved usage; tokens estimated from transcript text via
  the model's tokenizer ratio. Cost is omitted (we don't bill estimates).
- `[~]` mixed — some turns real, some estimated (common for sessions that
  predate usage persistence but have recent real turns).

## How it works

The data engine (`src/quota/usage-stats.ts`) is host-owned because it scans session
history and model metadata. The renderer is the shared
`@minimal-agent/plugin-api/utils/usage-render` leaf utility, reused by both this
overlay and the `usage` CLI command without importing host UI modules. This
plugin is the thin interactive shell: a `commands[]` entry that opens the
overlay, an `editor.key` hook that drives period switching, and a
process-singleton (`lib/state.ts`) shared between them — the same pattern as the
`config` and `slash-menu` plugins.

The command is registered through the host command registry, so it also shows
up in the slash-menu autocomplete and works headlessly.
