---
status: landed
date: 2026-07-24
session: 52182e58-902e-41b9-8b6b-510bafd51c0e
author: Mateo
collaborators: [Benjamin, Sergio]
---

# Stream idle: isolate LLM streams from side probes

Grok OAuth sessions frequently warned `api.stream-stalled` / `stream_idle` with
`phase=mid-stream` about 30s after headers even when the model stream was still
in pre-stream TTFB. Forensic sessions:

- **Benjamin `c5a709f2`**: concurrent `GET /v1/billing` shared the stream request
  id and lifecycle hooks; billing JSON ended pre-stream and armed mid-stream
  idle. Net-dbg lost the failed stream body (Map keyed by id overwritten).
- **Sergio `320e06bf`**: a separate class — genuine ~30s wire silence after mid
  `function_call_arguments.delta` (retry recovered). Also showed duplicate
  `api.stream-stalled` lines from watchdog `fail()` double-fire.

## Fix

1. **Request-local lifecycle** on `NetworkRequest.lifecycle`, invoked at
   `NetworkClient.tapResponse` / `notifyChunk` (same boundary as activity +
   net-dbg; no outer body re-wrap).
2. **`bindPrimaryStreamRequest`**: unique wire id per request; only the first
   stream-eligible POST gets status + watchdog hooks; claim at headers via
   content-type (SSE / NDJSON / connect+) or `policyTags: llm-stream`; denylist
   labels such as `grok.billing` / OAuth / quota.
3. **Single-fire `fail()`** so `api.stream-stalled` logs once.
4. **Recovery notices**: successful retries emit Notice-level
   `api.retry-success` plus `recovery: "true"` on `api.stream-stalled` and
   `api.retry` so the TUI warn slots clear.

Mid-stream idle remains **30s** (thinking-open still 5 min). Real mid-stream
silence still trips; false mid-stream from billing no longer does.

Commits: `ff4a1ab`, `7c91bc7`, `bf35061`.
