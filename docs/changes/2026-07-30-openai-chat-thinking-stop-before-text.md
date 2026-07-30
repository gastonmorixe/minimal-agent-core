---
status: landed
date: 2026-07-30
---

# OpenAI Chat: close thinking before first text delta

DeepSeek (and other Chat Completions reasoning models) end the reasoning
phase with a transition chunk that carries both the first visible token and a
null clear of `reasoning_content`, e.g.:

```json
{ "delta": { "content": "Pre", "reasoning_content": null } }
```

`translateOpenAIChatStream` previously handled **text before reasoning** in
each chunk. That yielded:

1. `text_delta("Pre")` → REPL streamed the token through mdstream
2. `thinking_stop` → REPL `onThinkingStop` inserted blank-line separators and
   reset `wroteOutput`

Scrollback then showed orphaned bright prefixes (`Pre`, `Plug`, `All`, `Lot`,
`Now`) on their own rows above the rest of the sentence — live render only;
session JSONL text stayed correct. Reproduced from net-dbg of session
`a37f1f39` (OpenCode Go / `deepseek-v4-pro`).

## Fix

Mirror Ollama / Cursor: process `reasoning_content` first (so a same-chunk
null clear emits `thinking_stop`), then on any non-empty `content` close any
still-open thinking block before `text_start` / `text_delta`. Also close
thinking before tool-call deltas.

Canonical source: `plugin-api/src/llm/openai-chat.ts`. Vendored copies under
`ma-llm-*/lib/openai-chat.ts` in the plugins repo are kept in sync.

## Tests

- `plugin-api/src/llm/openai-chat.test.ts` — reasoning → text boundary
  (same-chunk null clear + content-only follow-up without the field).
- `ma-llm-openai-plugin/openai.stream-fixtures.test.ts` — asserts
  `thinking_stop` index < `text_start` on the existing
  `chat-reasoning-content` fixture.
