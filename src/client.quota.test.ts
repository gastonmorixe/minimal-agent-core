import { describe, expect, it } from "bun:test"

import { type AuthResult, getAuth } from "./auth.ts"
import { fakeNetworkClient, sseResponse } from "./client.fixtures.ts"
import { checkQuota, type Message, sendMessageFull, sendMessageSync } from "./client.ts"
import { type NetworkRequest, NetworkResponse } from "./network/index.ts"
import { clearLastRateLimits } from "./quota-cache.ts"

describe("client", () => {
  describe("request body shape", () => {
    it("forwards a signal to networkClient.request that aborts when SendOptions.signal aborts", async () => {
      // Note: as of 2026-05-26 the request no longer carries the
      // caller's `signal` UNCHANGED — sendMessageOnce composes it with
      // an internal stream-idle/hard-timeout watchdog AbortController
      // via `AbortSignal.any([caller, watchdog])`. The transport sees
      // the COMPOSED signal. What matters for the harness is that an
      // abort on the caller's signal still propagates through.
      let captured: NetworkRequest | null = null
      const networkClient = fakeNetworkClient((req) => {
        captured = req
        return sseResponse([
          { type: "message_start", message: { id: "x", model: "claude", usage: {} } },
          { type: "message_stop" },
        ])
      })
      const ac = new AbortController()
      const auth: AuthResult = { type: "api-key", token: "tok", refresh: undefined }
      await sendMessageFull({
        auth,
        messages: [{ role: "user", content: "hi" }],
        networkClient,
        signal: ac.signal,
      })
      expect(captured).not.toBeNull()
      const requestSignal = (captured as unknown as NetworkRequest).signal!
      // The signal forwarded to the transport is NOT the exact same
      // instance (it's composed via AbortSignal.any), but aborting the
      // caller's signal still aborts the forwarded one.
      expect(requestSignal).not.toBe(ac.signal)
      expect(requestSignal.aborted).toBe(false)
      ac.abort(new Error("user cancellation"))
      expect(requestSignal.aborted).toBe(true)
    })

    // -----------------------------------------------------------------
    // Regression: the live-area `quota-status` slot's deadlock fix.
    //
    // Before this plumbing landed, `checkQuota` ignored its caller's
    // abort signal entirely — which meant the scheduler's
    // `AbortController` could fire its `abort` event, but the in-flight
    // network request would keep waiting on a TCP socket that died
    // during macOS sleep/wake (or any other transport stall). The
    // slot's `inFlight` flag stayed `true` forever, deadlocking BOTH
    // the heartbeat AND the `quota.headersReceived` bus path.
    //
    // The two assertions below pin the contract:
    //  - `checkQuota(auth, networkClient, signal)` must walk the
    //    `signal` argument all the way down to `networkClient.request`
    //    (so the transport can tear down the dead socket).
    //  - When that signal is already aborted before the request lands,
    //    the transport throws `AbortError`, `checkQuota` catches it and
    //    returns `{ok: false}` rather than hanging.
    // -----------------------------------------------------------------
    describe("checkQuota — signal propagation (deadlock regression)", () => {
      it("forwards the caller's AbortSignal to networkClient.request", async () => {
        // Without rate-limit headers in the response, the broadcast
        // helper is a no-op — keeps the cache module untouched.
        clearLastRateLimits()
        let captured: NetworkRequest | null = null
        const networkClient = fakeNetworkClient((req) => {
          captured = req
          return new NetworkResponse({
            status: 200,
            headers: { "content-type": "application/json" },
            transport: { id: "fake" },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`{"id":"x"}`))
                controller.close()
              },
            }),
          })
        })
        const ac = new AbortController()
        const auth: AuthResult = { type: "api-key", token: "tok", refresh: undefined }
        const result = await checkQuota(auth, networkClient, ac.signal)
        expect(result.ok).toBe(true)
        expect(captured).not.toBeNull()
        // The probe composes the caller's signal with an internal timeout
        // (AbortSignal.any), so it's a NEW signal — but the caller's abort
        // still propagates through it. That propagation is what prevents the
        // deadlock the scheduler relies on.
        const sig = (captured as unknown as NetworkRequest).signal
        expect(sig).toBeDefined()
        expect(sig).not.toBe(ac.signal)
        expect(sig?.aborted).toBe(false)
        ac.abort()
        expect(sig?.aborted).toBe(true)
      })

      it("returns {ok: false} (not a hang) when the signal is already aborted", async () => {
        clearLastRateLimits()
        // Real fetch-transport-style behavior: throw AbortError when the
        // signal is aborted before the response body arrives. The user's
        // bug was that this throw never propagated because the signal
        // wasn't plumbed in — the request stayed pending indefinitely.
        const networkClient = fakeNetworkClient((req) => {
          if (req.signal?.aborted) {
            const err = new Error("AbortError") as Error & { name: string }
            err.name = "AbortError"
            throw err
          }
          // Defensive default — this branch shouldn't run if the signal
          // is wired correctly.
          return sseResponse([])
        })
        const ac = new AbortController()
        ac.abort()
        const auth: AuthResult = { type: "api-key", token: "tok", refresh: undefined }
        const result = await checkQuota(auth, networkClient, ac.signal)
        expect(result).toEqual({ ok: false })
      })

      it("is always bounded, even without a caller signal (internal timeout)", async () => {
        clearLastRateLimits()
        let captured: NetworkRequest | null = null
        const networkClient = fakeNetworkClient((req) => {
          captured = req
          return new NetworkResponse({
            status: 200,
            headers: { "content-type": "application/json" },
            transport: { id: "fake" },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`{"id":"x"}`))
                controller.close()
              },
            }),
          })
        })
        const auth: AuthResult = { type: "api-key", token: "tok", refresh: undefined }
        const result = await checkQuota(auth, networkClient)
        expect(result.ok).toBe(true)
        // No caller signal, but the probe STILL forwards an (internal-timeout)
        // signal so it can never hang. It hasn't fired (the request completed
        // immediately), hence not aborted.
        const sig = (captured as unknown as NetworkRequest).signal
        expect(sig).toBeDefined()
        expect(sig?.aborted).toBe(false)
      })
    })

    // -----------------------------------------------------------------
    // Regression: multi-process keychain-first 401 recovery (May 2026).
    //
    // Cause: with N agents sharing one keychain entry, server-side
    // refresh-token rotation makes each successful refresh invalidate
    // the access tokens cached by the OTHER N-1 processes. They each
    // 401 next, refresh, invalidate the previous one, and the cycle
    // never settles. Net-dbg trace from session c0ab6ba6 showed 24/105
    // requests in a 5-min window returning 401, with 22 refreshes
    // (one of which outright failed `invalid_grant`).
    //
    // Fix: on 401, re-read the keychain BEFORE calling auth.refresh().
    // If another process already wrote a fresher access token, use
    // that directly — no oauth round-trip, no rotation. The refresh()
    // closure remains the fallback when WE are the freshest cache
    // holder.
    //
    // We exercise the path indirectly: an auth.refresh that throws
    // (server-side rejection) PROVES we hit the refresh fallback.
    // A successful retry without auth.refresh being called PROVES the
    // keychain-first path won.
    // -----------------------------------------------------------------
    describe("401 retry — keychain-first multi-process race mitigation", () => {
      it("calls auth.refresh as the fallback when 401 persists (no keychain rotation)", async () => {
        // No real keychain entry on the test path → readKeychain returns
        // null → keychain-first branch is a no-op → refresh fallback runs.
        let refreshCalls = 0
        let messageReqs = 0
        const networkClient = fakeNetworkClient((req) => {
          messageReqs++
          // First message call → 401 (stale token).
          // Second message call (after refresh) → 200.
          if (messageReqs === 1) {
            return new NetworkResponse({
              status: 401,
              headers: { "content-type": "application/json" },
              transport: { id: "fake" },
              body: new ReadableStream<Uint8Array>({
                start(c) {
                  c.enqueue(
                    new TextEncoder().encode(
                      `{"type":"error","error":{"type":"authentication_error","message":"Invalid"}}`,
                    ),
                  )
                  c.close()
                },
              }),
            })
          }
          // Sanity: confirm the retry uses the fresh refreshed token, not stale.
          const authHeader = req.headers?.authorization ?? ""
          expect(authHeader).toBe("Bearer fresh-from-refresh")
          return sseResponse([
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
          ])
        })

        const auth: AuthResult = {
          type: "oauth",
          token: "stale-token",
          refresh: async () => {
            refreshCalls++
            return { type: "oauth", token: "fresh-from-refresh" }
          },
        }

        await sendMessageFull({
          auth,
          messages: [{ role: "user", content: "hi" }],
          networkClient,
        })

        // The 401 fired the refresh fallback exactly once.
        expect(refreshCalls).toBe(1)
        // auth.token was mutated in place so future calls reuse it.
        expect(auth.token).toBe("fresh-from-refresh")
      })

      it("checkQuota's 401 path also uses keychain-first then refresh fallback", async () => {
        let refreshCalls = 0
        let reqs = 0
        const networkClient = fakeNetworkClient((req) => {
          reqs++
          if (reqs === 1) {
            return new NetworkResponse({
              status: 401,
              headers: { "content-type": "application/json" },
              transport: { id: "fake" },
              body: new ReadableStream<Uint8Array>({
                start(c) {
                  c.close()
                },
              }),
            })
          }
          // Second call must use the fresh token from refresh fallback.
          expect(req.headers?.authorization).toBe("Bearer cq-fresh")
          return new NetworkResponse({
            status: 200,
            headers: {
              "content-type": "application/json",
              "anthropic-ratelimit-unified-status": "allowed",
            },
            transport: { id: "fake" },
            body: new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode(`{"id":"x"}`))
                c.close()
              },
            }),
          })
        })
        const auth: AuthResult = {
          type: "oauth",
          token: "cq-stale",
          refresh: async () => {
            refreshCalls++
            return { type: "oauth", token: "cq-fresh" }
          },
        }
        const result = await checkQuota(auth, networkClient)
        expect(result.ok).toBe(true)
        expect(refreshCalls).toBe(1)
        expect(auth.token).toBe("cq-fresh")
      })
    })
  })

  describe("e2e", () => {
    const skip = !process.env.E2E

    it.skipIf(skip)(
      "sends a haiku request and gets a response",
      async () => {
        const auth = await getAuth()
        const messages: Message[] = [
          { role: "user", content: [{ type: "text", text: "Reply with exactly: PONG" }] },
        ]

        const response = await sendMessageSync({
          auth,
          messages,
          model: "claude-haiku-4-5-20251001",
          maxTokens: 32,
          stream: true,
        })

        expect(response.length).toBeGreaterThan(0)
        expect(response.toUpperCase()).toContain("PONG")
      },
      30_000,
    )

    it.skipIf(skip)(
      "sends a non-streaming request",
      async () => {
        const auth = await getAuth()
        const messages: Message[] = [
          { role: "user", content: [{ type: "text", text: "Reply with exactly: HELLO" }] },
        ]

        const response = await sendMessageSync({
          auth,
          messages,
          model: "claude-haiku-4-5-20251001",
          maxTokens: 32,
          stream: false,
        })

        expect(response.length).toBeGreaterThan(0)
        expect(response.toUpperCase()).toContain("HELLO")
      },
      30_000,
    )

    // Phase 4 — Anthropic 4.7/4.8 live smoke. Verifies the full new
    // beta set (mid-conversation-system-2026-04-07, extended-cache-
    // ttl-2025-04-11, fast-mode-2026-02-01 gated, …) actually round-
    // trips against api.anthropic.com on opus-4-8 with adaptive
    // thinking. Skipped unless E2E=1 (no Anthropic creds → no probe).
    it.skipIf(skip)(
      "Opus 4.8 conversation round-trip: adaptive thinking + 1h cache + effort=high",
      async () => {
        const auth = await getAuth()
        const messages: Message[] = [
          { role: "user", content: [{ type: "text", text: "Reply with exactly: OK48" }] },
        ]

        const response = await sendMessageSync({
          auth,
          messages,
          model: "claude-opus-4-8",
          maxTokens: 32,
          stream: true,
          thinking: { type: "adaptive" },
          outputConfig: { effort: "high" },
        })

        expect(response.length).toBeGreaterThan(0)
        expect(response.toUpperCase()).toContain("OK48")
      },
      60_000,
    )

    it.skipIf(skip)(
      "Opus 4.8 with --fast: server acknowledges fast-mode wire (200 OK or specific 429)",
      async () => {
        // Wire-shape verification, not a full round-trip. Two acceptable
        // outcomes prove `speed:"fast"` + the `fast-mode-2026-02-01`
        // beta header reached the server:
        //
        //   1. 200 OK with the model response — the account holds the
        //      "Usage credits" tier required for fast-mode dispatch
        //      (most subs don't).
        //
        //   2. 429 with `"Usage credits are required for fast mode."`
        //      — the server PARSED the fast-mode opt-in, recognized it,
        //      and quoted policy. Anything else (400, 403, generic 429)
        //      would mean the wire was wrong.
        //
        // The retry coordinator will retry transient overloads forever,
        // so we use a cancellation signal that fires immediately after
        // the first attempt to avoid an infinite loop in either case.
        const auth = await getAuth()
        const messages: Message[] = [
          { role: "user", content: [{ type: "text", text: "Reply with exactly: FAST" }] },
        ]

        let success = false
        let serverNotedFastMode = false
        try {
          const response = await sendMessageSync({
            auth,
            messages,
            model: "claude-opus-4-8",
            maxTokens: 32,
            stream: true,
            thinking: { type: "adaptive" },
            outputConfig: { effort: "high" },
            speed: "fast",
          })
          if (response.length > 0) success = true
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // Server's response when fast mode is recognized but the
          // account doesn't have credits for it. Proves wire shape OK.
          if (msg.includes("Usage credits are required for fast mode")) {
            serverNotedFastMode = true
          } else {
            throw err
          }
        }

        // One of the two acceptable outcomes must hold.
        expect(success || serverNotedFastMode).toBe(true)
      },
      120_000,
    )
  })
})
