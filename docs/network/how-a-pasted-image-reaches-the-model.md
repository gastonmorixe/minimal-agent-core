---
title: How a pasted image reaches the model
date: 2026-11-17
session: 98d14f02-0000-4000-8000-0a921a46601e
sources:
  - ~/.minimal-agent/net-dbg/1794915761540-17-NOV-2026-TUESDAY--06h42m41s-0500-minimal-agent-<session_id>/
  - ~/.minimal-agent/sessions/98d14f02-0000-4000-8000-0a921a46601e.jsonl
  - ~/.minimal-agent/history.jsonl
diagrams: rendered by the ascii-renderer skill (Grid Buffer + rich), script at the end
---

# How a pasted image reaches the model

This is a trace of one real event. In session `00000000`, the first user turn
was a 314x314 PNG of an "If it ain't broke, don't fix it" poster, with no
other text. This doc follows that image from the terminal to the Anthropic API.
It uses the net-dbg capture of the session and the code that ran.

## Summary

1. iTerm2 got Cmd+V with an image on the clipboard. It saved the image to a
   temp file, `$TMPDIR/…/pasted-image-<ts>-<uuid>.png`, and sent the file
   **path** to the app as a bracketed paste.
2. The editor paste interceptor saw a paste made only of an absolute `.png`
   path (the "drag-and-drop" case). It registered the file in the session
   `MediaRegistry` and put the token `[Image #0411abd5 314x314 57KB]` in the
   prompt. The id is the first 8 hex digits of the SHA-256 of the bytes.
3. On Enter, the agent core resolved the token. It read the bytes again,
   encoded them as base64 and built a canonical `image` block. The token text
   was removed from the prompt, and the prompt then had no other text.
4. The Anthropic plugin serialized the block as
   `{"type":"image","source":{"type":"base64","media_type":"image/png","data":…}}`.
   It gzipped the JSON and sent it with an HTTP/2 POST to
   `https://api.anthropic.com/v1/messages?beta=true`.
5. The Anthropic plugin has a Files API upload step (`prepareMediaUploads`),
   and it ran on this request. At the time, it uploaded only media of
   **1 MiB or more** (decoded). The image is 57,861 B, so it stayed inline as
   base64. The default is now **10 bytes**, so the same paste today goes up as
   a `file_id`. See
   [Why the Files API did not upload this image](#why-the-files-api-did-not-upload-this-image).
6. The image goes inline in `messages[0]` and **is sent again in every later
   request** of the session. The prompt cache makes this cheap.

## The flow

```text
1. CAPTURE  (terminal, CLI)        ──▶2. SUBMIT  (core)                  ──▶3. WIRE  (anthropic plugin)
═══════════════════════════           ═════════════════                     ═══════════════════════════

┌────────────────────────────────┐    ┌────────────────────────────────┐    ┌────────────────────────────────┐
│ iTerm2 Cmd+V on an image       │    │ Enter -> AgentCore round       │    │ prepareMediaUploads (then)     │
│ writes $TMPDIR/.../            │    │ buildInitialUserContent()      │    │ >= 1 MiB: POST /v1/files.      │
│ pasted-image-<ts>.png          │    └────────────────────────────────┘    │ 57 KB: stayed inline. Now      │
└────────────────────────────────┘                     ▼                    │ >= 10 B: uploads it            │
                 ▼                    ┌────────────────────────────────┐    └────────────────────────────────┘
┌────────────────────────────────┐    │ MediaResolverAdapter           │                     ▼
│ bracketed paste: abs path      │    │ .resolveUserContent(text)      │    ┌────────────────────────────────┐
│ ESC[200~/var/…/x.png ESC[201~  │    └────────────────────────────────┘    │ anthropic-request.ts           │
└────────────────────────────────┘                     ▼                    │ case 'image' ->                │
                 ▼                    ┌────────────────────────────────┐    │ {type:'image', source:         │
┌────────────────────────────────┐    │ ingestUserText                 │    │  {type:'base64', ...}}         │
│ EditorController               │    │ materializeInlineImagePaths    │    └────────────────────────────────┘
│ .interceptPaste(text)          │    │ -> buildUserContent            │                     ▼
└────────────────────────────────┘    └────────────────────────────────┘    ┌────────────────────────────────┐
                 ▼                                     ▼                    │ cache breakpoint on the        │
┌────────────────────────────────┐    ┌────────────────────────────────┐    │ last user block (turn 1)       │
│ mediaPasteInterceptor          │    │ resolveMediaTurn               │    │ cache_control 5m               │
│ looksLikeMediaDrop -> true     │    │ parse token, registry.get      │    └────────────────────────────────┘
│ Case 1: drag-and-drop          │    │ checkMedia(limits, vision)     │                     ▼
└────────────────────────────────┘    └────────────────────────────────┘    ┌────────────────────────────────┐
                 ▼                                     ▼                    │ adapter.ts                     │
┌────────────────────────────────┐    ┌────────────────────────────────┐    │ JSON.stringify -> gzip         │
│ registry.registerFileSync      │    │ inlineBase64Preparer           │    │ Content-Encoding: gzip         │
│ id = sha256(bytes)[0:8]        │    │ item.bytes() -> base64         │    └────────────────────────────────┘
│    = 0411abd5                  │    │ (core never uploads)           │                     ▼
└────────────────────────────────┘    └────────────────────────────────┘    ┌────────────────────────────────┐
                 ▼                                     ▼                    │ network/client.ts              │
┌────────────────────────────────┐    ┌────────────────────────────────┐    │ HTTP/2 POST                    │
│ prompt buffer shows token      │    │ canonical user content         │    │ /v1/messages?beta=true         │
│ [Image #0411abd5 314x314       │    │ [image block, text block]      │    └────────────────────────────────┘
│  57KB]                         │    │ token text stripped            │                     ▼
└────────────────────────────────┘    └────────────────────────────────┘    ┌────────────────────────────────┐
                                                                            │ net-dbg observer tees          │
                                                                            │ req/res to ~/.minimal-         │
                                                                            │ agent/net-dbg/<run>/           │
                                                                            └────────────────────────────────┘
                                                                                             ▼
                                                                            ┌────────────────────────────────┐
                                                                            │ 200 text/event-stream          │
                                                                            │ SSE -> model sees pixels       │
                                                                            └────────────────────────────────┘
```

## Evidence: the same bytes in four places

All four copies decode to the same SHA-256 prefix, `0411abd5`. That prefix is
also the media id in the token.

```text
Evidence: one image, four places, one hash
┌───────────────────────────────────────────────┬─────────────────────────────────────────────────────────┬───────────────┐
│ Where                                         │ What was found                                          │ sha256[0:8]   │
├───────────────────────────────────────────────┼─────────────────────────────────────────────────────────┼───────────────┤
│ $TMPDIR/.../pasted-image-20261117-064240-…png │ 57,861 B PNG, born 06:42:40 (1 s before submit)         │ 0411abd5      │
│ ~/.minimal-agent/history.jsonl                │ submitted text "[Image #0411abd5 314x314 57KB]"         │ 0411abd5 (id) │
│ sessions/00000000….jsonl  record #2           │ user content[1] = {type:image, source:base64 image/png} │ 0411abd5      │
│ net-dbg/…/attempt-001-02-req-body.txt         │ messages[0].content[1] image, 77,148 b64 chars          │ 0411abd5      │
└───────────────────────────────────────────────┴─────────────────────────────────────────────────────────┴───────────────┘
```

## Which paste path ran

`mediaPasteInterceptor` (CLI `src/paste/paste-intercept.ts`) has two branches:

- **Case 1, drop:** the pasted text is only absolute media paths. Each path
  goes to `registerFileSync(path, "drop")`.
- **Case 2, clipboard:** the pasted text is empty. On Linux the code calls
  `clipboardImageSync()` (`wl-paste` / `xclip`). On macOS and Windows the
  editor falls back to the async `clipboardImageToken()`, which reads the
  clipboard with Bun's native `Bun.Image.fromClipboard()`. There is no
  `pngpaste` step. A failed read is a `media.clipboard_failed` warning.

Case 1 ran here:

```text
Why case 1 (path drop), not case 2 (empty paste + clipboard)
┌──────────────────────┬─────────────────────────────────────────────────────────────────────┐
│ Check                │ Result                                                              │
├──────────────────────┼─────────────────────────────────────────────────────────────────────┤
│ TERM_PROGRAM         │ iTerm.app 3.7.7                                                     │
│ temp file name       │ pasted-image-<ts>-<uuid>.png: iTerm2 saves image pastes to $TMPDIR  │
│ file birth vs submit │ 06:42:40 vs 06:42:41.476: written by the terminal at paste time     │
│ clipboard fallback   │ not needed: the file path arrived, so no clipboard read ran         │
│ registry origin      │ registerFileSync(path, "drop"), so the id comes from the file bytes │
└──────────────────────┴─────────────────────────────────────────────────────────────────────┘
```

So the terminal turned the clipboard image into a file, and minimal-agent saw
a dropped file path. The `$TMPDIR` folder of the file is named
`…-4342-…`, and PID 4342 is `/Applications/iTerm.app/Contents/MacOS/iTerm2`.

## On the wire

net-dbg was on (`"netDbg": true` in `config.jsonc`, `MINIMAL_AGENT_NET_DBG=1`).
For each request, the observer writes five files: `01-req-meta.json`,
`02-req-body.txt`, `03-res-meta.json`, `04-res-body.txt`, `05-res-timeline.jsonl`.
`req-body.txt` holds the JSON **before** gzip. `requestBodyBytes` in the meta
file is that length, not the compressed size.

```text
Request 001 (the turn that carried the image)
┌────────────────────────┬───────────────────────────────────────────────────────────────────┐
│ Field                  │ Value                                                             │
├────────────────────────┼───────────────────────────────────────────────────────────────────┤
│ timestamp              │ 2026-11-17T11:42:41.540Z                                          │
│ method / url           │ POST https://api.anthropic.com/v1/messages?beta=true              │
│ transport              │ http2 (h2), new connection, no fallback                           │
│ content-encoding       │ gzip   (req-body.txt is the pre-gzip JSON, 145,042 B)             │
│ model / stream         │ claude-opus-5-5 / true                                            │
│ messages[0].content[0] │ text: <ma::agent::policy>Current local time …</ma::agent::policy> │
│ messages[0].content[1] │ image, base64, image/png, 314x314, 57,861 B decoded               │
│   cache_control        │ {"type":"ephemeral","ttl":"5m"}  (first-turn breakpoint)          │
│ user text block        │ none: the token was the whole prompt and was stripped             │
│ response               │ 200 text/event-stream, first byte +1426 ms, end +4143 ms          │
│ usage                  │ cache_creation_input_tokens 25,240 (system + tools + image)       │
└────────────────────────┴───────────────────────────────────────────────────────────────────┘
```

The JSON shape of `messages[0]` (base64 shortened):

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "<ma::agent::policy>Current local time: 2026-11-17 06:42:41 EST (Tuesday)</ma::agent::policy>" },
    {
      "type": "image",
      "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0KGgoAAAANSUhEUgAAAToAAAE6CAYAAACGQp5c…" },
      "cache_control": { "type": "ephemeral", "ttl": "5m" }
    }
  ]
}
```

Bytes 16 to 23 of the decoded PNG are the IHDR width and height:
`00 00 01 3a 00 00 01 3a`, which is 314x314.

## The image rides along on every turn

The API has no state, so the full history goes out with each request. The
image stays at `messages[0].content[1]` for the whole session. Prompt caching
means it is billed once, as part of the 25,240 cache-creation tokens on
attempt 001. After that it is a cache read.

```text
Every later request re-sends the same image
┌─────────┬──────────┬────────────────┬─────────────┬───────────────┐
│ Attempt │ messages │ req JSON bytes │ image at    │ cache_control │
├─────────┼──────────┼────────────────┼─────────────┼───────────────┤
│ 001     │ 1        │ 145,042        │ messages[0] │ ephemeral 5m  │
│ 002     │ 3        │ 147,181        │ messages[0] │ -             │
│ 003     │ 5        │ 197,226        │ messages[0] │ -             │
│ …       │ …        │ …              │ messages[0] │ -             │
│ 019     │ 37       │ 306,651        │ messages[0] │ -             │
└─────────┴──────────┴────────────────┴─────────────┴───────────────┘
```

## Code path

```text
Code path (file -> function)
┌───────────────────┬───────────────────────────────────────────────────────────────┬────────────────────────────────────────────────┐
│ Step              │ File                                                          │ Function                                       │
├───────────────────┼───────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
│ wire paste hooks  │ minimal-agent-cli/src/startup/live-repl.ts                    │ setPasteInterceptor / setClipboardPasteHandler │
│ bracketed paste   │ minimal-agent-cli/src/editor-controller.ts                    │ interceptPaste                                 │
│ detect + register │ minimal-agent-cli/src/paste/paste-intercept.ts                │ mediaPasteInterceptor                          │
│ drop heuristic    │ minimal-agent-cli/src/paste/detect.ts                         │ looksLikeMediaDrop, parseDroppedPaths          │
│ content id        │ minimal-agent-core/src/media/id.ts                            │ mediaId = sha256[0:8]                          │
│ registry          │ minimal-agent-core/src/media/registry.ts                      │ registerFileSync                               │
│ token grammar     │ minimal-agent-core/src/media/token.ts                         │ formatMediaToken, parseMediaTokens             │
│ user turn         │ minimal-agent-core/src/sdk/agent-core-helpers.ts              │ buildInitialUserContent -> mediaResolver       │
│ adapter           │ minimal-agent-core/src/adapters/media-resolver-adapter.ts     │ MediaResolverAdapter                           │
│ ingest            │ minimal-agent-core/src/media/ingest.ts                        │ resolveUserTurnContent, ingestUserText         │
│ resolve           │ minimal-agent-core/src/media/resolve.ts                       │ resolveMediaTurn, inlineBase64Preparer         │
│ serialize         │ minimal-agent-core/plugin-api/src/llm/anthropic-request.ts    │ toAnthropicImageSource                         │
│ Files API gate    │ minimal-agent-plugins/ma-llm-anthropic-plugin/media-upload.ts │ prepareMediaUploads (10 B default, env)        │
│ Files API client  │ minimal-agent-plugins/ma-llm-anthropic-plugin/files-api.ts    │ uploadAnthropicFile (POST /v1/files)           │
│ gzip + send       │ minimal-agent-plugins/ma-llm-anthropic-plugin/adapter.ts      │ gzipRequestBody                                │
│ capture           │ minimal-agent-core/src/logging/net-dbg.ts                     │ net-dbg observer (netDbg: true)                │
└───────────────────┴───────────────────────────────────────────────────────────────┴────────────────────────────────────────────────┘
```

Notes on the code:

- `live-repl.ts` sets up two hooks. `setPasteInterceptor` covers bracketed
  pastes (Cmd+V, drag). `setClipboardPasteHandler` covers Ctrl+V: it calls the
  interceptor with `""` to force Case 2, and falls back to `clipboardText()`.
- `materializeInlineImagePaths` (`ingest.ts`) is a second way in. A bare
  absolute image path **typed** into the prompt also becomes a token at submit
  time. This session did not use it, because the token already existed.
- `resolveMediaTurn` checks every item again against the **active** model's
  limits and modalities. It may shrink an image that is too big
  (`fitImageToBudget`). A rejected or missing item leaves a text marker in
  place of the image.
- `inlineBase64Preparer` is the default core preparer: "no upload, no
  network". Core always produces base64. The upload to the Files API is a
  provider step in the Anthropic plugin, after core (see below).

## Why the Files API did not upload this image

The Files API path is on `main`. It landed on 2026-11-16 from the
`feat/anthropic-files-api` worktree (`minimal-agent-monorepo_WT-files-api`,
session `d5c1e12c`): core `93ec39a`, plugins `c4e07db`, monorepo `eeb9a88`.
The plugins checkout that this session loaded (`91e0827`) contains it.

What it does, in `ma-llm-anthropic-plugin/adapter.ts`, before every Messages
call:

1. `prepareMediaUploads(req, ctx, networkClient)` walks every message and
   every `tool_result`, and finds base64 `image` and `file` blocks.
2. A block with a decoded size at or above the threshold is uploaded once with `POST /v1/files` (multipart,
   `expires_in_seconds` 24 h). The process caches the result by credential
   and SHA-256 of the bytes.
3. In a **copy** of the request, the source changes to
   `{"type":"file","file_id":"file_…"}`. The transcript keeps the base64, so
   a file id is never stored in the session.
4. If the upload fails, the block stays inline. A 400, 413 or 415 is
   remembered, so the plugin does not retry. If the Messages call returns 404
   for an evicted file id, the plugin retries once with those items inline.

For this session, step 2 did nothing: 57,861 B was below the threshold of
that time, 1,048,576 B. So the wire request is identical to a build without
the Files API. The net-dbg
captures in `~/.minimal-agent/net-dbg/` have no `/v1/files` request for any
session so far. The live e2e test (`e2e/files-api.e2e.ts`, 6/6 pass on
2026-11-16) is the only evidence of real uploads.

Known trade-off (from the `media-upload.ts` header): the choice between inline
and `file_id` is not sticky per session. A failed upload, a process restart
or a 404 retry can change one block from `file_id` to inline or back, and then
the prompt cache misses from that block on.

Earlier design notes are in
`minimal-agent-core/private/multimodality-ingestion/`. The README there still
says "Files API upload … designed, not built". That line is out of date.

### Threshold: 10 bytes by default, set by env

Since this trace, the plugin uploads almost every item. The setting is only in
the Anthropic plugin (`media-upload.ts`). Core has no part in it.

| Setting | Effect |
|---|---|
| default (`ANTHROPIC_UPLOAD_THRESHOLD_BYTES = 10`) | upload every image and document of 10 B or more |
| `MINIMAL_AGENT_FILES_API_THRESHOLD_BYTES=0` | upload every item |
| `MINIMAL_AGENT_FILES_API_THRESHOLD_BYTES=1048576` | the old behavior: inline under 1 MiB |
| a value that is not a non-negative integer | ignored, the default applies |

The plugin reads the env on each request (`resolveUploadThresholdBytes`). An
explicit `thresholdBytes` option to `prepareMediaUploads` wins over the env.

With uploads on every turn, the inline/`file_id` flip above matters more. A
process restart uploads again and gets a new id. If that id sits in
`messages[0]`, the prompt cache misses for the full conversation once.

## How to reproduce this trace

```bash
SID=98d14f02-0000-4000-8000-0a921a46601e
python3 - ~/.minimal-agent/net-dbg/*-minimal-agent-$SID/*-02-req-body.txt <<'EOF'
import json, sys, base64, hashlib
for f in sys.argv[1:]:
    b = json.load(open(f))
    for i, m in enumerate(b["messages"]):
        for c in m["content"] if isinstance(m["content"], list) else []:
            if c.get("type") == "image":
                raw = base64.b64decode(c["source"]["data"])
                print(f.rsplit("/", 1)[-1][:40], "msg", i, hashlib.sha256(raw).hexdigest()[:8])
EOF
```

Compare the printed prefix with the `[Image #xxxxxxxx …]` token in
`~/.minimal-agent/history.jsonl`.

## Render script

The diagrams and tables above came from
[`how-a-pasted-image-reaches-the-model.render.py`](./how-a-pasted-image-reaches-the-model.render.py),
run with `uv run`. It uses the ascii-renderer skill's `grid_buffer.Grid` for the flow
and `rich.Table` for the tables.
