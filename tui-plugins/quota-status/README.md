# quota-status

Sticky-bottom quota readout for `minimal-agent`.

## What it does

Moves the `anthropic-ratelimit-*` summary from the synchronous startup
tree (where it blocked the REPL boot on a network round-trip) into a
periodically-refreshed footer row pinned below the prompt.

```
…transcript…
❯ ▌                                            ← editor input
quota  5h 12% ↻ 4h17m · 7d 3% ↻ 6d ·  overall 4%   ← footer slot
```

## How it works

The plugin declares one entry under the `liveAreaSlots` array of its
manifest:

```json
{
  "id": "quota",
  "handler": { "type": "module", "path": "./handler.ts", "export": "default" },
  "position": "footer",
  "refreshMs": 300000,
  "timeoutMs": 8000,
  "placeholder": "\u001b[2mquota  ·\u001b[22m",
  "refreshOn": ["quota.headersReceived"]
}
```

Three feeds keep the row up-to-date:

1. **`placeholder`** — painted synchronously at REPL start, BEFORE any
   `invoke` resolves. This reserves the live-area row from t=0 so the
   prompt doesn't visually shift up by one row when real data lands a
   moment later. (Without it: `❯` would appear, sit alone for ~1s,
   then jump up by a row when the footer appears below it. With it:
   the row is there from the first repaint, real data replaces the
   placeholder in-place.)

2. **`refreshOn: ["quota.headersReceived"]`** — the agent's
   `client.ts` emits this event on the plugin event bus after EVERY
   successful API response (real chat completions and the dedicated
   `checkQuota` probe). The scheduler subscribes and off-cycle re-fires
   the slot. The handler then reads from `getLastRateLimits()` —
   populated by the same emit — without a fresh round-trip. End-to-end
   latency: low milliseconds.

3. **`refreshMs: 300000`** — heartbeat polling every 5 minutes for the
   idle / multi-agent case (another process drains the budget while
   this one is silent). Falls back to a real `checkQuota()` request if
   the cache hasn't been freshened in the last `refreshMs/2` window.

The handler re-uses `formatQuotaSummary` from `src/quota-format.ts`, so
the visual output is identical to what the synchronous startup tree
used to print.

## Auto-skip of the startup row

When this plugin is loaded, `src/index.ts` sees a slot with
`id === "quota"` in `loader.getLiveAreaSlots()` and **skips the
synchronous `quota` startup row entirely**. The blocking
`checkQuota()` request that used to gate the REPL boot is gone; the
slot fetches the same data asynchronously, after the editor is
already accepting keystrokes.

## Disabling

Drop into `~/.minimal-agent/config.jsonc`:

```jsonc
{
  "plugins": {
    "quota-status": { "enabled": false }
  }
}
```

The synchronous startup row reappears (loader's `disabledPluginIds`
short-circuits before `getLiveAreaSlots` sees the slot, so
`hasQuotaSlot` is `false` and the original gate is restored).
