# web-search plugin

`WebSearch` tool. Provider-pluggable; ships with Brave as the default.

## What it contributes

| Surface | Trigger | Handler |
|---|---|---|
| Tool | `WebSearch` | `handlers/web_search.ts` |

## Provider chain

Configured in `~/.minimal-agent/config.jsonc`:

```jsonc
{
  "plugins": {
    "web-search": {
      "providers": ["brave"]
    }
  }
}
```

The tool dispatches through the chain in order. Each provider's adapter
lives under `providers/`. A provider can return:

- **A result list** (success). Returned to the model.
- **Empty results** (success but nothing matched). Stops the chain. NOT
  a failure.
- **An error** (network, auth, rate limit). Logged, the chain continues
  to the next provider.

If every provider errors, the tool returns `is_error: true` with a
setup hint (usually "no API key set").

## Provider configuration

Brave needs `BRAVE_SEARCH_API_KEY` in the environment. Other providers
declare their own env vars in `providers/<name>.ts`.

## Files

- `manifest.json`: tool declaration.
- `handlers/web_search.ts`: tool entry point.
- `providers/`: per-provider adapters. Add a new provider by dropping
  a `providers/<name>.ts` exporting the `Provider` interface from
  `providers/types.ts`.
- `config.ts`: config schema + provider chain resolution.
- `format.ts`: result formatting (text vs json).
- `cli.ts`: out-of-agent invocation for testing.
- `PROMPT.md`: model-facing guidance on query shape, freshness, when
  to use `news` vs `web`.

## Adding a new provider

1. Create `providers/<name>.ts` exporting `default: Provider`.
2. Implement `search({ query, type, count, freshness, ... })` returning
   normalized results.
3. The provider is auto-discovered at load time; users opt in by
   listing `"<name>"` in `plugins["web-search"].providers`.

## Disabling

`plugins["web-search"].enabled = false` in `~/.minimal-agent/config.jsonc`.
The `WebSearch` tool disappears from the model's tool list.
