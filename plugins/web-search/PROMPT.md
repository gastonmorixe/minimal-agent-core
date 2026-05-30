Use `WebSearch` to find current information on the open web. It returns ranked hits with title, URL, snippet, age, and source.

## When to use it

- The user asks about something that may have changed since training.
- You need a current fact, a recent release, a recent event, or a URL.
- You need to verify a claim before stating it.
- The local workspace doesn't have the answer.

## When not to use it

- The answer is already in the conversation, in files you've read, or in your own training (and is unlikely to be stale).
- A `Grep` or `Read` answers it faster.

## How to call it well

- **Keep queries short.** 2-6 well-chosen keywords beat full sentences for almost every provider.
- **Use `type: "news"` for time-sensitive lookups** (recent events, breaking news, "what happened with X this week"). Default `web` for reference, docs, and general lookups.
- **Default `count` is 10.** The top 5 are usually all that matter. Drop to `count: 5` when you don't need depth.
- **Use `freshness: "pw"` or `"pm"`** when recency matters but the query is general, or a `YYYY-MM-DDtoYYYY-MM-DD` range when you know the window.
- **Keep `format: "text"` (default)** for normal use. Switch to `format: "json"` only when you need to parse specific fields.
- **Cite sources by URL** when you use a hit's content in your reply.

## Provider chain

Results come from a configurable provider chain (Brave by default). Failed or unconfigured providers are skipped silently and the next is tried; empty results are not a failure, they stop the chain. If every provider fails (e.g. no API key configured), the result is an error with a setup hint. The result header shows which provider answered (`WebSearch[brave/web]`); you don't need to choose.
