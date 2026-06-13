# Quota footer freezes forever after macOS sleep / wake

**Date:** 2026-05-10
**Type:** bugfix
**Status:** landed
**Author:** Claude Code (Opus 4.7)

## Problem

User report:

> I have a session open from a few days ago that shows this (outdated) quota:
>
> ```
> quota  5h 93% ↻ 36m · 7d 59% ↻ 1d18h · overage off
> ```
>
> and this new session:
>
> ```
> quota  5h 3% ↻ 3h42m · 7d 62% ↻ 17h2m · overage off
> ```
>
> the quota should been updated even if the mac closed etc, in fact the
> old session is still running now and it weird that two systems failed:
> the interval that every some time checks for updated quota to haiku
> I think and the new request from just now that should bring back
> updated quota us well in the headers, none updated the quota ui.

The user has two `minimal-agent` sessions on the same Mac. The newer
session (started post-wake) shows fresh quota. The older session, which
was running during a Mac sleep/wake cycle and has since handled new API
turns, still displays the stale numbers it captured before the lid was
closed — even though:

1. The 5-minute heartbeat in `LiveAreaScheduler.scheduleNext` should
   have re-probed via `checkQuota`.
2. Every successful chat completion broadcasts `quota.headersReceived`
   on the plugin event bus, which the slot subscribes to via
   `refreshOn` and should re-fire off-cycle.

Neither path updated the UI. The same process kept pretending the
quota was where it had been days earlier.

## Root cause

`LiveAreaScheduler.fire()` (`src/ui/status/live-area-scheduler.ts`) gates
re-entry on a per-slot `inFlight` flag and arms an `AbortController`
with `timeoutMs` (8 s for quota) so a slow producer can't pile up:

```ts
if (s.inFlight) {
  this.scheduleNext(s)   // re-arm, but skip this tick
  return
}
s.inFlight = true
const ac = new AbortController()
this.setT(() => ac.abort(), timeoutMs)
Promise.resolve()
  .then(() => s.slot.invoke(ctx))
  .then(handle, errHandle)   // sets s.inFlight = false
```

The flag is meant to be released either via the natural `.then`
resolution OR via the timeout's `ac.abort()` propagating into the
handler. **But `checkQuota` never accepted an `AbortSignal`** and
therefore never plumbed it to `networkClient.request`:

```ts
// src/client.ts (before)
export async function checkQuota(
  auth: AuthResult,
  networkClient: NetworkClient = defaultNetworkClient,
): Promise<QuotaResult> {
  ...
  return networkClient.request({
    label: "quota.check",
    method: "POST",
    url: API_URL,
    headers: h,
    body: serializedBody,
    // ← no `signal` field
  })
}
```

…even though the transport layer (`src/network/fetch-transport.ts:12`,
`http2-transport.ts:194-208`) fully supports it and the main
`sendMessage()` path already passes it through (`src/client.ts:1073`).

So when the user's Mac slept with a probe in flight (or when a probe
was issued post-wake against the dead TCP connection), the request
sat there forever waiting on a peer that would never reply. The
scheduler's `ac.abort()` fired at 8 s and the abort event was
dispatched to whatever listened, but the network call wasn't
listening, so the original `.then` chain never resolved or rejected.

`s.inFlight` stayed `true` forever. Every subsequent heartbeat AND
every subsequent `quota.headersReceived` bus emit hit the
`if (s.inFlight) return` guard at the top of `fire()` and silently
re-armed without doing any work. The footer was frozen at whatever
the cache last contained.

## Why both refresh systems failed together

This was the most surprising part of the bug report. The two paths
look independent:

* **Heartbeat:** `scheduleNext()` → `setTimeout(refreshMs)` → `fire()`
* **Event:** `bus.on("quota.headersReceived", () => fire(s))` (wired
  in `LiveAreaScheduler.subscribeRefreshOn()` at `src/ui/status/live-area-scheduler.ts:147-159`)

But both funnel through the same `fire(s)` function, which checks the
same `s.inFlight` flag at the top. The single stuck probe deadlocked
both refresh paths simultaneously.

`broadcastResponseRateLimits` in `src/quota-broadcast.ts:57-74` did
correctly cache the fresh data on every API response, but the bus
listener that would have re-painted the UI from that cache was being
dropped by the `inFlight` gate.

## Fix

Three small, layered edits:

### 1. `src/client.ts` — make `checkQuota` accept and forward a signal

```ts
export async function checkQuota(
  auth: AuthResult,
  networkClient: NetworkClient = defaultNetworkClient,
  signal?: AbortSignal,                       // ← new
): Promise<QuotaResult> {
  ...
  return networkClient.request({
    ...,
    signal,                                    // ← forwarded
  })
}
```

Backwards-compatible: existing callers (`src/index.ts:673` startup
probe) don't pass a signal and continue to work unchanged.

### 2. `tui-plugins/quota-status/handler.ts` — pass `ctx.abort`

```ts
export default async function handle(ctx: LiveAreaHandlerContext): Promise<string | null> {
  ...
  const result = await checkQuota(auth, undefined, ctx.abort)
  ...
}
```

The slot handler now actually consumes the abort signal the scheduler
already gives it. Until this turn it was named `_ctx` (TypeScript
"unused" prefix) — it had been ignored.

### 3. `src/ui/status/live-area-scheduler.ts` — defensive belt: force-release `inFlight`

Even with (1) and (2) in place, a future slot handler could forget the
`ctx.abort` plumbing and recreate the same class of bug. To make that
harmless, the scheduler now self-rescues:

```ts
let settled = false
const handle = (next): void => {
  if (settled) return            // single-fire latch
  settled = true
  ...
}

const timeoutHandle = this.setT(() => {
  ac.abort()
  // Defer 2 microtask hops so a well-behaved invoke gets to win the
  // latch first. If we still haven't settled, conclude invoke is hung
  // and free the gate ourselves.
  void Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      if (settled) return
      this.logger("slot ... timed out ... releasing inFlight gate")
      handle(null)
    })
}, timeoutMs)
```

**Why two microtask hops, not one:** when `invoke()` returns a
thenable (the common case — `async` handler), the `.then` chain
schedules an extra "adopt" microtask to propagate fulfillment from
the inner promise to the chained one. A single-hop checker fires
**between** the adoption and the actual `handle(out)` call, would
see `settled === false`, and would clobber the well-behaved value
with `null`. Two hops gives the well-behaved chain enough time to
win. The `well-behaved handler still wins the latch` test pins this
contract. The `force-releases inFlight when timeoutMs fires AND
invoke ignores ctx.abort` test pins the recovery.

## Tests

### Unit (in this commit)

* `src/ui/status/live-area-scheduler.test.ts`:
  * `force-releases inFlight when timeoutMs fires AND invoke ignores ctx.abort (heartbeat + refreshOn both recover)`
    — drives a slot whose `invoke` returns a never-settling promise,
    advances past `timeoutMs`, asserts the diagnostic log appears, then
    advances by `refreshMs` AND emits a `quota.headersReceived` event,
    asserting `invokeCount` reaches 3 (start fire + heartbeat recovery +
    bus-event recovery). This is the headline regression test.
  * `a well-behaved handler still wins the latch (force-release does NOT clobber on-time results)`
    — the inverse contract: when `invoke` honors `ctx.abort` and resolves
    with a real value, the force-release microtask must NOT pre-empt
    that value with `null`.

* `src/client.test.ts`:
  * `forwards the caller's AbortSignal to networkClient.request` — the
    captured `NetworkRequest.signal` must be the same instance the
    caller passed in.
  * `returns {ok: false} (not a hang) when the signal is already aborted` —
    a fake transport that throws `AbortError` on aborted signals must
    propagate to a clean `{ok: false}` rather than hanging forever.
  * `works without a signal (back-compat: existing callers don't break)` —
    the optional third argument is truly optional.

### Existing tests that pin the contract

* `src/ui/status/live-area-scheduler.test.ts`: `aborts a slow invocation when timeoutMs elapses (next tick still scheduled)` — the original abort/recover happy-path test continues to pass with the latch refactor.

### Manual verification

Reproducible only in the wild (sleep/wake mid-probe). The unit test
synthesizes the exact deadlock signature with a never-settling
`invoke`.

## Files changed

* `src/client.ts` — `checkQuota` signature + signal plumbing
* `src/client.test.ts` — 3 new regression tests
* `src/ui/status/live-area-scheduler.ts` — single-fire latch + 2-hop force-release
* `src/ui/status/live-area-scheduler.test.ts` — 2 new regression tests
* `tui-plugins/quota-status/handler.ts` — pass `ctx.abort` to `checkQuota`

No public API churn beyond the optional third arg to `checkQuota`.
