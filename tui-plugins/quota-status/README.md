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
  "timeoutMs": 8000
}
```

At REPL start the agent's `LiveAreaScheduler` invokes the handler with
`tick=0`, then again every 5 minutes. Each invocation is wrapped in an
`AbortController` armed with `timeoutMs`; if a previous tick is still
in flight the next one is skipped (no pile-up).

The handler re-uses the same `formatQuotaSummary` formatter that the
startup tree previously used (lifted into `src/quota-format.ts`), so
the visual output is identical — only the timing changes.

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
