# `src/network/` — quick reference

This is the agent's network layer. Model requests flow through it: the
canonical transport (`src/llm/transport/`) hands the client to each provider
adapter on `RunContext.networkClient`. Auth refresh (`src/auth/auth.ts`) and
OAuth login (`src/auth/oauth-login.ts`) use it too. Auto-formatter download and plugin traffic are
candidates for upcoming PR-3 (see the design doc).

```
┌─────────────────────────────────────────────────────────────┐
│  NetworkClient                                              │
│    primary       — Http2Transport (default) | FetchTransport│
│    fallback?     — FetchTransport (when primary is h2)     │
│    transports    — Map<NetworkProtocol, Transport>          │
│                    e.g. { "h3" → Http3Transport,            │
│                           "http/1.1" → FetchTransport }      │
│    policies      — NetworkPolicy[] middleware              │
│    observers     — NetworkObserver[] (activity + net-dbg)   │
└─────────────────────────────────────────────────────────────┘
```

## Environment knobs

| env var                              | values                  | effect                                                           |
| ------------------------------------ | ----------------------- | ---------------------------------------------------------------- |
| `MINIMAL_AGENT_TRANSPORT`            | `http2` (default), `fetch`, `test` | Primary transport selection.                          |
| `MINIMAL_AGENT_ALLOW_FETCH_FALLBACK` | `1` (default: off)     | Allow per-request fallback from h2 to fetch on ANY primary-transport error, not just h2-unsupported ones. Off by default — see the h2-unsupported auto-fallback below, which fires regardless of this flag. |
| `MINIMAL_AGENT_HTTP3`                | `off` (default), `opt`, `force` | Register the h3 transport + opportunistic policy.        |
| `MINIMAL_AGENT_LIVE_H3`              | `1`                     | Run live h3 tests / benchmark against cloudflare.com (gated).   |

## How HTTP/3 negotiation works

```
Request 1 to api.example.com → cache miss → h2 → response headers
  ╰─ if response has Alt-Svc: h3=... → cache marks origin "supported"

Request 2 to api.example.com → cache "supported" → pin protocol:"h3" → h3 transport
  ╰─ on HTTP3HandshakeFailed → cache marks origin "unsupported" (1h TTL)
                            → retry once with protocol cleared → h2

Caller pins protocol explicitly (req.protocol = "h2" or "h3")
  ╰─ policy stays out of the way; the transport map routes accordingly
```

See the network-layer design doc (archived under `private/docs-archive/`) for the
full state machine, measured numbers, and behavior matrix.

## How h2-unsupported auto-fallback works (SPEC-NET-001)

Some origins (e.g. `opencode.ai`) never offer `h2` in ALPN; `Http2Transport`
fails connect with `h2 is not supported` instead of negotiating HTTP/1.1.
`http2FallbackPolicy` + `Http2FallbackCache` turn that into a transparent,
self-healing fallback — on by default whenever h2 is the primary transport,
independent of `MINIMAL_AGENT_ALLOW_FETCH_FALLBACK`:

```
Request 1 to opencode.ai → h2 → "h2 is not supported"
  ╰─ policy catches it, marks the origin h1-only, retries THIS request on
     fetch (the caller still gets a response, not a thrown error)

Request 2+ to opencode.ai → cache says h1-only → pin protocol:"http/1.1" up
  front → fetch, h2 never attempted again (no forever-retry on the same
  failure)

Caller pins protocol explicitly (req.protocol = "h2")
  ╰─ never falls back, cache untouched — keeps the Cursor Connect rule
     (same carve-out as `allowFetchFallback: false`)
```

The cache has no TTL (an origin's ALPN support doesn't flap) and is
process-local, same scope as the h3 negotiation cache above.

## NetworkPolicy — middleware shape

A policy can do any combination of:

```ts
{
  id: "my-policy",

  // Mutate the request before it goes on the wire.
  onRequest?(req): Promise<NetworkRequest | void> | NetworkRequest | void,

  // Substitute the response after it comes back. Receives a `retry(next)`
  // callback for replaying with a (possibly different) request.
  onResponse?(req, res, retry): Promise<NetworkResponse | void>,

  // Full lifecycle wrap. Receives `run(override?)` to fire the transport
  // (with an optional request override). Used for retry/queue/throttle.
  wrap?(req, run): Promise<NetworkResponse>,
}
```

Policies run in registration order:
- `onRequest`: outer → inner
- `wrap`: outer wraps inner (LIFO nesting)
- `onResponse`: inner → outer (so the outermost policy sees the
  final substituted response)

`wrap`'s `run(override?)` re-fires the transport with a (possibly
modified) request but does NOT re-run the policy chain — prevents
infinite loops.

### Shipped policies

| Policy                       | File                                       | What it does                                                       |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `http3OpportunisticPolicy`   | `src/network/policies/h3-opportunistic.ts` | Per-origin h3 negotiation + handshake-failure downgrade.           |
| `http2FallbackPolicy`        | `src/network/policies/h2-fallback.ts`      | Per-origin h2-unsupported detection + fetch fallback (SPEC-NET-001). |

### Planned (design doc §7e)

| Policy                       | What it would do                                                   |
| ---------------------------- | ------------------------------------------------------------------ |
| `authRefreshPolicy`          | Collapse the 120-line 401 maze inlined in `client.ts` into a reusable middleware. Works for any authenticated origin (not just Anthropic). |
| `rateLimitPolicy`            | Per-origin token bucket.                                          |
| `originAllowlistPolicy`      | Per-plugin sandboxing — declare allowed origins in the manifest.  |
| `queuePolicy`                | UI-visible queue with cancel / promote / drop (`client.enqueue`). |

## Writing a NetworkPolicy

```ts
import type { NetworkPolicy, NetworkRequest, NetworkResponse } from "@/network/types"

export function exampleRedactionPolicy(): NetworkPolicy {
  return {
    id: "redact-auth-from-debug",
    onRequest(req) {
      // Pre-flight transformation. Returning the same `req` shape (or
      // a clone) threads it onward; returning `undefined` is a no-op.
      if (req.headers?.authorization && req.capture?.requestBody !== undefined) {
        return {
          ...req,
          capture: { ...req.capture, requestBody: "(redacted)" },
        }
      }
      return undefined
    },
  }
}
```

### Tests

Put the test next to the policy as `<name>.test.ts`. The pattern from
`policies/h3-opportunistic.test.ts` is reusable:

- Unit tests for `onRequest` / `onResponse` / `wrap` in isolation.
- Integration test using a `TracingTransport` + a real `NetworkClient`
  to assert routing, observer flow, and back-compat.
- Optional live test gated on an env var.

### Benchmarks

`tmp/network-h3-bench.ts` is the existing template. Use `awaitBench`
for async paths, `bench` for sync. Output is markdown-friendly so it
pastes into design docs verbatim.

## When NOT to use this layer

- **Plugin subprocess that shells out to a binary.** `ma-fetch-plugin`
  spawns `obscura` (a Rust browser); the binary's own network stack
  takes over and the layer never sees those requests. This is fine —
  not every subprocess needs DI'd networking.
- **One-shot CLI utilities** (`bun run-some-script.ts`). The layer is
  designed for the agent's long-lived process; ad-hoc scripts can use
  `fetch()` directly.
- **TUI-only mock servers / fixtures.** Use `TestTransport`
  (`MINIMAL_AGENT_TRANSPORT=test`) instead.
