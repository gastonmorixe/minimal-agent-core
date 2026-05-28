The `web-search` plugin contributes a `WebSearch` tool, on the same footing
as the built-in tools (`Bash`, `Read`, `Grep`, etc.). Auto-loaded when the
plugin is present. Opt-out via `plugins["web-search"].enabled = false` in
`~/.minimal-agent/config.jsonc`.

## When to use `WebSearch`

- The user is asking about something that may have changed since training.
- You need a current fact, recent release, recent event, or a URL.
- You need to verify a claim before stating it.
- The repo / local workspace doesn't have the answer.

## When NOT to use `WebSearch`

- The answer is in the current conversation, in files you've already read,
  or in your own training (and is unlikely to be stale).
- You're inside ASK mode and the question is purely about the workspace.
- A `Grep`/`Read` would answer it faster.

## How to call it well

- **Keep queries short.** 2–6 well-chosen keywords beat full sentences for
  almost every provider.
- **Prefer `type: "news"` for time-sensitive lookups** (recent events,
  breaking news, "what happened with X this week"). Default `web` for
  reference / docs / general lookups.
- **Default `count` is 10.** The top 5 are usually all that matter. Drop
  to `count: 5` if you don't need depth.
- **Use `freshness: "pw"` or `"pm"`** when recency matters but the query
  is general. Use a `YYYY-MM-DDtoYYYY-MM-DD` range when you know the
  window.
- **Stick to `format: "text"` (default)** for normal use. It's compact
  and easy to read inline. Switch to `format: "json"` only when you need
  to parse specific fields programmatically (rare).
- **Cite sources by URL** when you use a hit's content in your reply.

## Provider chain

The tool dispatches through a configurable provider chain (default:
`["brave"]`). Failed/unconfigured providers are skipped silently and the
next provider is tried. Empty results are *not* a failure. They stop the
chain. If every provider fails (e.g. no API key set), the tool returns an
`is_error: true` result with a setup hint.

You don't need to think about which provider answered. The result block
shows it (`WebSearch[brave/web]`).
