---
status: landed
date: 2026-07-24
session: e7e997f0-fe9b-48ca-a76c-c466dac38c05
author: Pablo
---

# Explicit HTTP/2 network routing

`NetworkClient.request({ protocol: "h2" })` now selects a registered
`Http2Transport` even when `MINIMAL_AGENT_TRANSPORT=fetch` makes fetch the
process-wide default. Previously, a missing h2 entry silently fell through to
that primary transport, so a caller could not actually require HTTP/2.

This matters for Cursor AgentService/Run. Its Connect/protobuf stream was
malformed through Bun fetch, while the host `Http2Transport` is implemented
with `node:http2` and streams correctly. The Cursor plugin can therefore stay
inside the shared NetworkClient observer/policy seam without falling back to a
private client.

`NetworkClient.close()` now closes every distinct configured transport,
including protocol-specific and plaintext transports, so the always-registered
h2 pool does not leak when fetch is primary.

Fallback policy also respects request intent: an explicit `protocol` pin, or
`allowFetchFallback: false`, never retries through Bun fetch even when
`MINIMAL_AGENT_ALLOW_FETCH_FALLBACK=1`. Request-side observers stamp the
selected transport after protocol resolution, and body cancel acquires the
underlying reader so early consumer returns still settle net-dbg/activity.

Focused tests cover explicit h2 routing under a fetch default and exactly-once
transport closure.
