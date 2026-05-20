---
status: PR-1 landed (Http3Transport + NetworkPolicy + opportunistic h3); design alive for PR-2..5
date: 2026-05-19
landed: 2026-05-20
session: 757a2e00-5261-4acd-b5f9-e6419a7e6343
author: claude
supersedes: none
---

# Unified Network Layer (v2) — Audit + Design

> **Update 2026-05-20** — PR-1 + PR-1.5 landed together: `Http3Transport`,
> `Http3NegotiationCache`, `NetworkPolicy` middleware shape, and the
> `http3OpportunisticPolicy` are live in `src/network/`. See
> [§7f Opportunistic HTTP/3](#7f-opportunistic-http3-shipped-2026-05-20) for
> the shipped implementation + measured numbers. Sections 7a (transport)
> and 5 (`NetworkPolicy` interface) describe the shipped state. PR-2..5
> still describe future work.

## 1. Why now

Three forces are bumping into the existing `src/network/` abstraction:

1. **HTTP/3 just landed in Bun 1.3.14.** The `NetworkProtocol` enum
   already lists `"h3"` but there's no `Http3Transport`. The shape is
   ready, the implementation is missing.
2. **Plugins ship their own `fetch()` calls.** `web-search/providers/brave.ts`,
   the soon-to-land `ma-fetch-plugin` (Rust shellout, separate concern),
   any future provider — they all use the runtime's `fetch` directly and
   bypass the agent's net-dbg capture, activity observer, and quota tracking.
3. **Several primitives still aren't first-class.** SSE is parsed
   ad-hoc inside `src/client.ts`. WebSocket isn't covered at all even
   though the `NetworkProtocol` enum lists `"ws"`. There's no queue, no
   middleware, no per-origin policy.

The current layer is well-structured but scoped narrowly to
"request-response over h2 with optional fetch fallback". v2 keeps the
same intent and grows three perpendicular axes: **more protocols, more
control (middleware/queue/retry), more consumers (plugins)**.

## 2. Audit — every network call in the codebase

Captured 2026-05-19 from `src/`, `tui-plugins/`, and `~/.agents/tui-plugins/`.

| # | Site                                                  | Endpoint                                | Layer        | Protocol  | Notes                                                                                                   |
| - | ----------------------------------------------------- | --------------------------------------- | ------------ | --------- | ------------------------------------------------------------------------------------------------------- |
| 1 | `src/client.ts:1110` `sendMessage()`                  | `POST api.anthropic.com/v1/messages`    | ✓ NetworkClient | h2     | SSE response, custom `parseSSE` reader on `res.body`. 80-line 401 retry inlined.                        |
| 2 | `src/client.ts:1535,1695` `checkQuota()`              | `POST api.anthropic.com/v1/messages`    | ✓ NetworkClient | h2     | Heartbeat probe + 401-retry fork. Triggered from `quota-status` live-area slot.                         |
| 3 | `src/client.ts:1507` `MODELS_URL`                     | `GET api.anthropic.com/v1/models`       | ✓ NetworkClient | h2     | Declared, currently only test-referenced.                                                               |
| 4 | `src/auth.ts:278` `refreshAccessToken()`              | `POST claude.ai/api/oauth/token`        | ✓ NetworkClient | h2     | Token refresh with cross-process lock (`src/lockfile.ts`).                                              |
| 5 | `src/oauth-login.ts:310` `exchangeCode()`             | `POST claude.ai/api/oauth/token`        | ✓ NetworkClient | h2     | One-shot PKCE code exchange.                                                                            |
| 6 | `src/auto-formatter.ts:219`                            | `GET api.github.com/repos/.../releases` | ✗ raw `fetch`   | http/1.1 | mdstream auto-download. JSON.                                                                           |
| 7 | `src/auto-formatter.ts:263`                            | `GET github.com/.../*.tar.gz`           | ✗ raw `fetch`   | http/1.1 | Tarball download, large body, progress bar reimplemented locally.                                       |
| 8 | `tui-plugins/web-search/providers/brave.ts:229`        | `GET api.search.brave.com/res/v1/...`   | ✗ raw `fetch`   | http/1.1 | API key in `X-Subscription-Token`. Constructor takes an injectable `fetch` for tests but no DI from us. |
| 9 | `~/.agents/tui-plugins/ma-fetch-plugin/backends/obscura.ts` | (varies, model-controlled URLs)    | ✗ subprocess    | n/a       | Shells out to obscura binary; out of scope for the JS net layer but worth noting.                       |

### Observations from the audit

- **All Anthropic + OAuth traffic already runs through `NetworkClient`.**
  That's the hot path; it's well covered.
- **The two "drive-by" `fetch()` sites are mdstream auto-download and
  the Brave provider.** Both could move onto the layer with minor edits
  — they'd get net-dbg capture, activity tracking, and (eventually)
  retry/queue policy for free.
- **Plugins have no plumbing to receive a `NetworkClient`.** `TUIContext`
  (`src/plugins/types.ts:56`) carries `cwd`, `env`, `abort`, stdio
  handles — nothing network-shaped. Even if the Brave provider wanted
  to call our client today, it can't reach it.
- **SSE is hand-rolled.** `parseSSE()` at `src/client.ts:816` parses
  bytes directly. Good for one consumer; bad for "what if a plugin
  wants to consume an SSE endpoint" or "what if we want to add an
  observer that counts SSE events, not bytes".
- **WebSocket is absent.** No agent code uses WS today, but the
  `NetworkProtocol` enum has `"ws"` and the plugin host
  (`global-bus`, slash-menu) is the kind of thing that could grow a WS
  surface for remote agents.
- **Retry / rate-limit / queue is hand-rolled per call site.** The 401
  retry in `client.ts` (~120 LoC including the keychain-first
  multi-process mitigation) and the cross-process refresh lock
  (`src/lockfile.ts`) are intricate and copy-paste candidates.

## 3. Naming

The existing class is `NetworkClient`. I'll keep that name — it's
already in use everywhere and "client" is correct (it makes outbound
calls). What grows is the *surface*:

- `NetworkClient` keeps `.request()` (request-response, unchanged
  signature except for a new `protocol?` hint).
- We add `.stream()` (SSE wrapper), `.ws()` (WebSocket), and `.enqueue()`
  (queued request, returns a `Handle` with cancel/promote/priority).
- We add `policy: NetworkPolicy[]` as middleware (think Express, but for
  the network layer): pre-flight `onRequest()`, post-flight
  `onResponse()`, optional `wrap()` for retry/queue/throttle.

The whole module stays at `src/network/`. The plugin-facing handle is a
narrowed subset called `PluginNetworkClient` (read-only delegation —
plugins can request but not install policies).

## 4. Gap matrix — what v2 unlocks

| Gap                                                            | Today                                                                | v2                                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| HTTP/3 client                                                  | not implemented; `protocol: "h3"` is a type-only string              | `Http3Transport` using `fetch(url, { protocol: "http3" })`                      |
| WebSocket                                                      | none                                                                 | `client.ws(url, opts)` returns a `NetworkWebSocket` (typed open/message/close)  |
| Server-Sent Events                                             | hand-rolled `parseSSE` in `client.ts`                                | `client.stream(req)` returns `AsyncIterable<SseEvent>` (also raw bytes)         |
| 401 retry / refresh / lock                                     | 120 LoC inlined in `client.ts` per call site                         | `AuthRefreshPolicy` middleware (one place, reusable for plugins that auth too)  |
| Multi-process refresh storm mitigation                         | hand-rolled `src/lockfile.ts`                                        | Same lockfile, hidden behind `AuthRefreshPolicy`. Same `auth.ts`, same tests.   |
| Per-origin rate limiting                                       | none                                                                 | `RateLimitPolicy({"api.anthropic.com": {rpm: 50}})`                             |
| Plugin-controlled queue / cancel / promote                     | none (model+UI have queue, the wire doesn't)                         | `client.enqueue()` returns a handle; UI can show a queue, drop, promote         |
| Plugin access to the layer                                     | none — plugins use raw `fetch`                                       | `TUIContext.network: PluginNetworkClient` (narrowed delegate)                   |
| Net-dbg capture for plugin traffic                             | only captures core calls                                             | Plugins-on-layer get capture for free                                           |
| Activity observer for plugin traffic                           | only core calls drive `↑/↓` bytes                                    | Plugins-on-layer drive the same status row                                      |
| Filtering / scrubbing / rewriting                              | none                                                                 | `Policy.onRequest(req)` can rewrite/abort; useful for redaction or test mocks   |
| Per-call protocol pinning                                      | partial (passing through transport's choice)                         | `req.protocol?: "h2" | "h3"` first-class; falls through to transport selection |

## 5. Interface proposal

The smallest possible widening of the existing types. Additions
annotated `// NEW v2`.

```ts
// src/network/types.ts — additions only, existing types preserved

// ── 1. Per-request protocol hint (matches Bun's fetch option) ──────────────
export interface NetworkRequest {
  // ...existing fields...
  protocol?: NetworkProtocol  // NEW v2 — pin to "h2" | "h3" | "http/1.1"; default: transport's choice
  priority?: "low" | "normal" | "high"  // NEW v2 — queue ordering; default "normal"
  policyTags?: ReadonlyArray<string>  // NEW v2 — opaque tags policies match on, e.g. "anthropic", "plugin:web-search"
}

// ── 2. Streaming primitives (SSE / NDJSON / chunked-text) ─────────────────
// NEW v2
export interface SseEvent {
  id?: string
  event?: string         // "event:" line, omitted when not set
  data: string           // accumulated "data:" lines, joined by \n
  retryMs?: number       // "retry:" line if present
}

// NEW v2 — return shape from client.stream()
export interface NetworkEventStream extends AsyncIterable<SseEvent> {
  readonly headers: Headers
  readonly status: number
  readonly transport: NetworkTransportInfo
  close(): void
}

// ── 3. WebSocket primitives ────────────────────────────────────────────────
// NEW v2 — minimal Web-API-shaped surface. NOT exposing the raw socket;
// callers send strings / Uint8Arrays and listen to typed events.
export interface NetworkWebSocketOpts {
  protocols?: string | string[]
  headers?: Record<string, string>
  signal?: AbortSignal
  policyTags?: ReadonlyArray<string>
  /** Reconnect strategy. `false` = caller handles. */
  reconnect?: { maxRetries?: number; baseDelayMs?: number } | false
}

export interface NetworkWebSocket {
  readonly url: string
  readonly readyState: 0 | 1 | 2 | 3   // CONNECTING / OPEN / CLOSING / CLOSED
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  // Async iterators are friendlier than EventTarget for our codebase style:
  messages(): AsyncIterable<string | Uint8Array>
  events(): AsyncIterable<{ type: "open" | "close" | "error"; code?: number; reason?: string; cause?: unknown }>
}

// ── 4. Queueing — request-as-handle ────────────────────────────────────────
// NEW v2 — what `client.enqueue()` returns. UI can subscribe to a queue
// view, promote / cancel / drop items without racing the wire.
export interface QueuedRequestHandle<T = NetworkResponse> {
  readonly id: string
  readonly request: NetworkRequest
  readonly enqueuedAt: number
  readonly state: "queued" | "in-flight" | "settled" | "canceled"
  promote(): void
  cancel(reason?: unknown): void
  promise(): Promise<T>
}

// ── 5. Policy / middleware ─────────────────────────────────────────────────
// NEW v2 — composable filters around each request. Same shape as
// the existing `NetworkObserver` but with mutation rights.
export interface NetworkPolicy {
  readonly id: string
  /**
   * Pre-flight. Return a rewritten request, abort with an error, or
   * pass through with `undefined`. Throwing rejects the request.
   */
  onRequest?(req: NetworkRequest): Promise<NetworkRequest | undefined> | NetworkRequest | undefined | void
  /**
   * Post-flight. Return a rewritten response or pass through. Used by
   * AuthRefreshPolicy to swap a 401 for a retried 200.
   */
  onResponse?(
    req: NetworkRequest,
    res: NetworkResponse,
    retry: (next: NetworkRequest) => Promise<NetworkResponse>,
  ): Promise<NetworkResponse | undefined> | NetworkResponse | undefined | void
  /** Optional: full wrap (for retry/queue/throttle that needs both sides). */
  wrap?(req: NetworkRequest, run: () => Promise<NetworkResponse>): Promise<NetworkResponse>
}
```

The existing `NetworkClient.request(req)` keeps the same signature.
Three new methods:

```ts
// src/network/client.ts — additions, existing surface untouched

export class NetworkClient {
  // ...existing fields + methods (request, preconnect, close)...

  // NEW v2
  async stream(req: NetworkRequest): Promise<NetworkEventStream> { ... }

  // NEW v2
  ws(url: string, opts?: NetworkWebSocketOpts): NetworkWebSocket { ... }

  // NEW v2
  enqueue(req: NetworkRequest, opts?: { priority?: "low" | "normal" | "high" }): QueuedRequestHandle { ... }
}
```

`enqueue` is the underdog. It exists so that:

- **The UI can show a queue.** The live-area slot becomes "3 requests
  pending: Anthropic conversation, GitHub releases probe, Brave search".
- **Plugin floods can self-throttle.** If five `ma-fetch` calls come in
  on the same turn, the queue can serialize them per-origin.
- **Cancel is reified.** The `abort-quit-fsm` already cancels in-flight
  work; `enqueue` gives the same cancel signal to *queued-not-yet-sent*
  work, with no race.

## 6. Plugin DI

One additive change to `TUIContext` and one to `HookCtx`:

```ts
// src/plugins/types.ts
export interface TUIContext {
  // ...existing...
  /** NEW v2 — agent's NetworkClient, narrowed for plugin use. */
  network: PluginNetworkClient
}

// src/plugins/hooks/types.ts
export interface HookCtx {
  // ...existing...
  /** NEW v2 — agent's NetworkClient, narrowed for plugin use. */
  network: PluginNetworkClient
}
```

`PluginNetworkClient` is the narrowed delegate — it exposes
`request`, `stream`, `ws`, `enqueue` but NOT `policy.push()`,
`close()`, or `preconnect()`. Plugins can fire requests but can't
install global middleware. (If a plugin wants its own per-request
middleware: pass it via `req.policyTags` and have the agent's policy
list react.)

```ts
// src/network/plugin-client.ts — new file
export interface PluginNetworkClient {
  request(req: Omit<NetworkRequest, "id" | "transportHint">): Promise<NetworkResponse>
  stream(req: Omit<NetworkRequest, "id" | "transportHint">): Promise<NetworkEventStream>
  ws(url: string, opts?: NetworkWebSocketOpts): NetworkWebSocket
  enqueue(req: Omit<NetworkRequest, "id" | "transportHint">, opts?: { priority?: "low" | "normal" | "high" }): QueuedRequestHandle
}
```

Subprocess plugin handlers are trickier (no shared address space). Two
options, decide later:

- **a)** Generate a one-shot Unix socket per dispatch, send the
  subprocess a `MA_NETWORK_SOCKET=/tmp/...` env, and proxy requests
  over it. Each in-flight request gets a per-id channel. Reuses the
  same `PluginNetworkClient` surface. Heavier wire format.
- **b)** Keep subprocesses on raw `fetch()` for now and only DI the
  module handlers. The Brave provider is a module handler so it gets
  the full surface; ma-fetch's obscura subprocess stays outside the
  layer (it's a separate binary anyway).

I'd land **(b)** first and revisit (a) if a subprocess plugin needs it.

## 7. Concrete diffs (illustrative — not committed)

### 7a. Add `Http3Transport`

```ts
// src/network/http3-transport.ts — new file (~40 LoC)
import { NetworkResponse, type NetworkRequest, type NetworkTransport } from "./types.ts"

/**
 * HTTP/3 transport via Bun's experimental fetch protocol option.
 *
 * Requires Bun ≥ 1.3.14. Falls back to TCP transparently if the origin
 * doesn't speak QUIC and Alt-Svc upgrades are enabled
 * (BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT=1). For explicit
 * protocol: "http3" requests, a non-h3 origin throws HTTP3HandshakeFailed.
 */
export class Http3Transport implements NetworkTransport {
  readonly id = "http3"

  async request(req: NetworkRequest): Promise<NetworkResponse> {
    const init: RequestInit & { protocol?: string } = {
      method: req.method,
      headers: req.headers,
      body: toFetchBody(req.body),
      signal: req.signal,
      protocol: "http3",
    }
    const res = await fetch(req.url, init as RequestInit)
    return new NetworkResponse({
      status: res.status,
      headers: res.headers,
      body: res.body,
      transport: {
        id: this.id,
        protocol: "h3",
        origin: new URL(req.url).origin,
        reused: undefined,
        fallbackUsed: false,
      },
    })
  }
}

function toFetchBody(body: NetworkRequest["body"]): BodyInit | undefined {
  if (body == null || typeof body === "string") return body
  const copy = new ArrayBuffer(body.byteLength)
  new Uint8Array(copy).set(body)
  return copy
}
```

Wire-up:

```ts
// src/network/client.ts
export function createDefaultNetworkClient(): NetworkClient {
  const requested = process.env.MINIMAL_AGENT_TRANSPORT?.trim().toLowerCase()
  if (requested === "test") { /* ...unchanged... */ }

  // NEW v2 — http3 honored when the user asks for it.
  let primary: NetworkTransport
  if (requested === "fetch") primary = new FetchTransport()
  else if (requested === "http3") primary = new Http3Transport()
  else primary = new Http2Transport()

  const fallback = primary.id === "http2" ? new FetchTransport() : undefined
  // ...rest unchanged...
}
```

### 7b. Move `src/auto-formatter.ts` and `web-search/brave.ts` onto the layer

```ts
// src/auto-formatter.ts (excerpt)
- const res = await fetch(RELEASES_API, { headers: { ... } })
+ const res = await networkClient.request({
+   label: "auto-formatter.releases",
+   method: "GET",
+   url: RELEASES_API,
+   headers: { ... },
+   policyTags: ["github", "auto-formatter"],
+ })
```

```ts
// tui-plugins/web-search/providers/brave.ts (excerpt)
- this.fetchImpl = this.cfg.fetch ?? fetch
- resp = await this.fetchImpl(url, { headers, signal })
+ this.network = this.cfg.network ?? ctx.network  // DI from TUIContext
+ const resp = await this.network.request({
+   label: "websearch.brave",
+   method: "GET",
+   url,
+   headers,
+   signal,
+   policyTags: ["plugin:web-search", "external-api"],
+ })
```

### 7c. SSE on the layer — `client.stream()`

```ts
// src/network/client.ts (sketch)
async stream(req: NetworkRequest): Promise<NetworkEventStream> {
  const res = await this.request({
    ...req,
    headers: { accept: "text/event-stream", ...req.headers },
  })
  return wrapSse(res)  // existing parseSSE() lifted from src/client.ts
}
```

`src/client.ts`'s `sendMessage` keeps calling `networkClient.request(...)`
on the messages endpoint (because it wants the raw body to feed its
specialized Anthropic SSE parser that knows about
`signature_delta` / `input_json_delta` etc.). New SSE consumers (e.g.
a hypothetical plugin watching a status feed) use `.stream()`.

### 7d. WebSocket transport

```ts
// src/network/ws-transport.ts — new file (~80 LoC)
import { WebSocket as NodeWebSocket } from "ws"  // or Bun's global WebSocket on Bun

export function createWebSocket(
  url: string,
  opts: NetworkWebSocketOpts,
  policies: NetworkPolicy[],
): NetworkWebSocket { ... }
```

I'd ship this as opt-in (no consumer yet in core), so it can mature
behind the same kind of feature flag as the HTTP/3 client.

### 7e. AuthRefreshPolicy — collapse client.ts's 401 maze

```ts
// src/network/policies/auth-refresh.ts — new file
export function authRefreshPolicy(deps: {
  auth: AuthResult
  readKeychain: () => OauthFile | null
  emitStatus: (msg: string) => void
}): NetworkPolicy {
  return {
    id: "auth-refresh",
    async onResponse(req, res, retry) {
      if (res.status !== 401 || !deps.auth.refresh) return undefined
      // 1. keychain-first (multi-process race mitigation)
      const fresh = deps.readKeychain()?.claudeAiOauth?.accessToken
      if (fresh && fresh !== deps.auth.token) {
        deps.emitStatus("Auth refreshed elsewhere, retrying...")
        deps.auth.token = fresh
        return retry(withAuth(req, fresh))
      }
      // 2. refresh + retry once
      deps.emitStatus("Auth token expired, refreshing...")
      const refreshed = await deps.auth.refresh()
      deps.auth.token = refreshed.token
      const retried = await retry(withAuth(req, refreshed.token))
      if (retried.status === 401) throw new Error(
        "401 after token refresh. The keychain credentials are stale : run `minimal-agent --login`.")
      return retried
    },
  }
}
```

The current 80–120 lines in `client.ts:1098..1230` collapse to "wire
the policy once":

```ts
// src/index.ts or wherever the default client is built
const client = createDefaultNetworkClient({
  policies: [authRefreshPolicy({ auth, readKeychain, emitStatus: setLabel })],
})
```

Bonus: the same policy works for the OAuth refresh endpoint itself
(currently a separate code path in `src/auth.ts:278`) and any future
authenticated plugin (e.g. a hypothetical GitHub-API plugin reusing
the same token).

## 8. Compatibility and rollout

- **Wire-compatible.** Existing `NetworkClient`,
  `NetworkTransport`, `NetworkRequest`, `NetworkResponse`,
  `NetworkObserver` keep their signatures. v2 is additions only on
  these types.
- **Tests.** Existing `src/network/network.test.ts`,
  `src/client.test.ts` (24+ cases on the 401 path) keep passing
  unchanged. New tests land alongside the new files
  (`http3-transport.test.ts`, `auth-refresh-policy.test.ts`, etc.).
- **Feature flags.**
  - `MINIMAL_AGENT_TRANSPORT=http3` — opt in to h3 primary.
  - `MINIMAL_AGENT_NETWORK_QUEUE=1` — enable `enqueue()` path.
    Without it, `enqueue()` immediately delegates to `request()` (no
    queueing). This way the rollout is incremental.
- **Plugin DI is breaking for plugin authors who use `TUIContext` as a
  closed shape.** Since the project owns all in-tree plugins and the
  loader can synthesize a `network` field for older plugins (just
  pass the agent's client; older plugins ignore it), this is
  effectively non-breaking.

## 9. Sequencing (suggested PRs)

1. **(1 PR, ~150 LoC)** Add `Http3Transport`. Tests. Wire the
   `MINIMAL_AGENT_TRANSPORT=http3` arm. Keep H2 default. — *low risk,
   useful for benchmarks even before Anthropic ships h3*.
2. **(1 PR, ~200 LoC)** Add `NetworkPolicy` shape, refactor the 401
   retry in `client.ts` into `AuthRefreshPolicy`. Tests inherited.
   — *unlocks reuse and clears the largest single block of duplicated
   recovery logic*.
3. **(1 PR, ~300 LoC)** Add `client.stream()` (SSE). Move
   `src/auto-formatter.ts` + `tui-plugins/web-search/providers/brave.ts`
   to the layer. Add `TUIContext.network` and `HookCtx.network`.
   — *gets every in-tree call on one layer*.
4. **(1 PR, ~400 LoC)** Add `client.enqueue()` + queue UI hook.
   — *biggest UX win, requires real product thinking about queue
   policy*.
5. **(1 PR, ~300 LoC)** Add `client.ws()` + `WsTransport`.
   — *speculative until a consumer exists; gate behind a config flag*.

Each PR is independently revertible. The audit table at the top doubles
as a checklist: as each site moves on-layer, flip ✗ to ✓.

## 10. What I'm explicitly NOT proposing

- **Building our own HTTP/3 stack.** Use Bun's. Same logic for ws.
- **Replacing `node:http2` with Bun's `fetch({protocol:"h2"})`.** Bun's
  h2 client is also experimental (1.3.14 release notes flag it). Our
  `Http2Transport` is battle-tested over months of agent traffic. Keep it.
- **A full reactive stream library.** `AsyncIterable<SseEvent>` matches
  the project's style (see `parseSSE`, `mdstream` formatter sink, the
  `Hooks.stream` shape). No need for RxJS.
- **A worker-thread net pool.** All the slow bits (the SSE parse, the
  Anthropic API itself) are already async I/O; an extra thread would
  add hops without latency reduction.

## 7f. Opportunistic HTTP/3 (shipped 2026-05-20)

After the initial design + PoC (§4 above), an obvious follow-up
question came up: *can the layer try HTTP/3 first by default and fall
back to HTTP/2 if it fails?* The naive answer ("just try h3 first") is
a trap — the PoC measured **4950ms** for Bun's
`HTTP3HandshakeFailed` to surface on an origin without h3 (vs 435ms
for h2 to succeed). Doing that on every cold request would be UX
poison.

The shipped approach combines the two safe strategies:

  1. **Per-origin negotiation cache** ({@link Http3NegotiationCache})
     keyed on `new URL(origin).origin` with separate positive
     (24h) and negative (1h) TTLs. Positive verdicts come from
     `Alt-Svc: h3=...` response headers (RFC 7838 `ma=` is honored
     up to the configured cap). Negative verdicts come from observed
     handshake failures.
  2. **Opportunistic policy** ({@link http3OpportunisticPolicy})
     consults the cache in `onRequest`, pins `protocol:"h3"` only
     when the verdict is `"supported"`, observes `Alt-Svc` in
     `onResponse`, and on a handshake failure during `wrap` records
     the failure AND retries once with `protocol` cleared (so the
     client routes to the default h2 transport).

Three modes via `MINIMAL_AGENT_HTTP3`:

  - `off` (default) — h3 transport not registered; pure h2 behavior.
  - `opt` — h3 only when origin's `Alt-Svc` says so. **First request
    pays no penalty**; second request to that origin uses h3.
  - `force` — h3 by default for unknown origins; cache learns
    `unsupported` from observed failures. Recommended for
    benchmarking and explicit rollouts.

### Files shipped (PR-1 + PR-1.5)

| Path                                              | Lines |
| ------------------------------------------------- | ----- |
| `src/network/http3-transport.ts`                  |   148 |
| `src/network/http3-transport.test.ts`             |   175 |
| `src/network/http3-cache.ts`                      |   263 |
| `src/network/http3-cache.test.ts`                 |   215 |
| `src/network/policies/h3-opportunistic.ts`        |   140 |
| `src/network/policies/h3-opportunistic.test.ts`   |   460 |
| `src/network/types.ts` (additive)                 |   +95 |
| `src/network/client.ts` (additive)                |   +84 |
| `src/network/index.ts` (additive exports)         |   +13 |
| `tmp/network-h3-bench.ts` (gitignored)            |   260 |

Test count: **71 new tests passing** (30 cache + 15 transport + 26
policy/integration + back-compat regression guards). Existing
`src/network/network.test.ts` + `activity-observer.test.ts`
(23 tests) untouched and still passing.

### Measured numbers (2026-05-20, MacBook Pro M-arm64, Bun 1.3.14)

#### A. Policy-chain overhead

Adding the opportunistic policy to a request that doesn't use h3:

| benchmark                                       |     N |   mean | median |   p95 |
| ----------------------------------------------- | ----- | ------ | ------ | ----- |
| `client.request` — no policies (baseline)       | 10000 | 3.96µs | 2.12µs | 6.96µs |
| `client.request` — with `http3OpportunisticPolicy` | 10000 | 6.63µs | 4.58µs | 9.46µs |

**+2.7µs mean per request.** Lost in the noise of any real network
round-trip (smallest of which is ~100ms).

#### B. Cache lookup hot path

| benchmark                              |      N |   mean |  p95 |
| -------------------------------------- | ------ | ------ | ---- |
| `Http3NegotiationCache.lookup()` — hit | 100000 |  517ns | 541ns |
| `Http3NegotiationCache.lookup()` — miss| 100000 |  460ns | 500ns |
| `Http3NegotiationCache.lookup()` — bad URL (try/catch) | 100000 | 674ns | 1.71µs |

**~500ns per lookup.** Effectively free.

#### C. Alt-Svc parser

| benchmark                                       |      N |   mean |    p95 |
| ----------------------------------------------- | ------ | ------ | ------ |
| `parseAltSvc()` — simple `h3=":443"; ma=86400`  | 100000 |  382ns |  375ns |
| `parseAltSvc()` — complex (4 entries, quoted)   | 100000 | 1.54µs | 2.17µs |

#### D. Live cloudflare.com h3 vs h2 (5 runs each, cold-then-warm)

| benchmark                                         | mean  | median | p95   |
| ------------------------------------------------- | ----- | ------ | ----- |
| `Http3Transport.request` HEAD                     | 480ms | 473ms  | 508ms |
| Bun `fetch()` HEAD (default = h2)                 | 719ms | 706ms  | 826ms |

**h3 wins by ~33% (240ms) to an h3-capable origin.** That's the
upper-bound win when the origin actually serves h3. For our hot
path (api.anthropic.com), h3 is not available today and the cache
correctly negotiates h2 with zero overhead.

### Behavior matrix (verified by integration tests)

| Caller intent          | Cache verdict   | Result                       | Test                                           |
| ---------------------- | --------------- | ---------------------------- | ---------------------------------------------- |
| No `protocol` set      | `"unknown"`     | h2 (primary)                 | "first request goes to primary h2"             |
| No `protocol` set      | `"supported"`   | h3 (via map)                 | "second goes to h3 after alt-svc"              |
| No `protocol` set      | `"unsupported"` | h2 (primary)                 | "pass-through when verdict is 'unknown'"       |
| `protocol: "h2"`       | `"supported"`   | h2 — caller pin respected    | "respects caller-set protocol"                 |
| Policy-pinned h3 fails | n/a             | h2 fallback + cache marked   | "h3 handshake failure downgrades to h2"       |
| Caller-pinned h3 fails | n/a             | error surfaces + cache marked| "caller-pinned h3 is surfaced unchanged"      |
| Force mode, unknown    | `"unknown"`     | h3                           | "force mode pins h3 for 'unknown' origins"     |
| Force mode, unsupported| `"unsupported"` | h2 — proven hostile          | "force mode still backs off"                  |
| Transport map missing  | `"supported"`   | h2 (primary, gracefully)     | "transport map miss gracefully falls back"     |

### Known limitations

- **Bun is the only runtime that gets h3.** `Http3Transport` uses
  `fetch(url, { protocol: "http3" })` which is a Bun ≥ 1.3.14
  extension. Node/Deno builds (if we ever ship them) would need an
  alternative transport.
- **Negotiation cache is process-local.** A restart pays at most
  one extra h2 round-trip per origin to rediscover. On-disk
  persistence was explicitly rejected: cross-session staleness has
  bitten Chromium-class browsers when origins rotate CDNs.
- **No Happy Eyeballs h3.** Strategy C from the ASK-mode answer
  (race h3+h2 cold) is not implemented. Worth revisiting only
  when there's measurable evidence the one-RTT h2 detour before
  h3 kicks in is causing actual UX pain. As of 2026-05-20, the
  agent has zero h3-capable hot-path origins.

## 11. Open questions

- Does subprocess-plugin networking matter enough to design (7) section
  (a) now? My read: defer until a real subprocess plugin needs it.
- Where do the policy lists live for tests? Right now `createDefaultNetworkClient`
  reads env vars. v2 needs a clean way to pass `policies: [...]` from
  `index.ts` (where auth + status bus live) without making the
  `defaultNetworkClient` exported singleton stale. Likely answer:
  keep the singleton for transports + observers; thread policies
  through `Agent({...})` or a new `defaultNetworkClient.install(policy)`
  call at startup.
- Should `PluginNetworkClient` enforce a per-plugin allowlist of
  origins? Today plugins can hit any URL the runtime can reach. A
  manifest field `permissions.network: ["api.search.brave.com"]`
  would let the agent reject off-allowlist hits with a clear error
  instead of silently letting plugins exfiltrate. Tracked separately;
  not v2 scope.
