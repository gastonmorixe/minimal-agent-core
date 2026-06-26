/**
 * Tests for the provider-neutral 401 auth-refresh middleware.
 *
 * Mirrors the legacy `client.test.ts` "401 retry — keychain-first
 * multi-process race mitigation" coverage at the canonical layer:
 * keychain-first peer adoption, network refresh fallback, give-up after
 * both, non-401 / api-key pass-through.
 *
 * @module llm/transport/auth-refresh.test
 */

import { describe, expect, it } from "bun:test"

import type { ProviderAuth } from "../provider.ts"

import { type AuthRefreshState, is401, withAuthRefresh } from "./auth-refresh.ts"
import type { StreamedResponse } from "./types.ts"

function resp(text: string): StreamedResponse {
  return { blocks: [{ type: "text", text }], text, stopReason: "end_turn" }
}

function err401(): Error {
  return new Error("Anthropic API 401: authentication_error")
}

async function drain(
  gen: AsyncGenerator<string, StreamedResponse, undefined>,
): Promise<{ yields: string[]; result: StreamedResponse }> {
  const yields: string[] = []
  let r: IteratorResult<string, StreamedResponse>
  // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
  while (!(r = await gen.next()).done) yields.push(r.value)
  return { yields, result: r.value }
}

/** An attempt that 401s while `state.auth.token` is in `stale`, else streams. */
function attemptUntilToken(state: AuthRefreshState, stale: Set<string>, text: string) {
  return () =>
    (async function* () {
      const tok = state.auth.kind === "oauth" ? state.auth.token : ""
      if (stale.has(tok)) throw err401()
      yield text
      return resp(text)
    })()
}

describe("is401", () => {
  it("detects 401 via message, status, opts.status, and AuthError name", () => {
    expect(is401(new Error("API 401: nope"))).toBe(true)
    expect(is401(Object.assign(new Error("x"), { status: 401 }))).toBe(true)
    expect(is401(Object.assign(new Error("x"), { opts: { status: 401 } }))).toBe(true)
    expect(is401(Object.assign(new Error("x"), { name: "AuthError" }))).toBe(true)
    expect(is401(new Error("500 server error"))).toBe(false)
    expect(is401(null)).toBe(false)
  })
})

describe("withAuthRefresh", () => {
  it("network-refreshes on 401 and retries with the fresh token", async () => {
    let refreshCalls = 0
    const state: AuthRefreshState = {
      auth: {
        kind: "oauth",
        token: "stale",
        refresh: async () => {
          refreshCalls++
          return { token: "fresh" }
        },
      },
    }
    const { yields, result } = await drain(
      withAuthRefresh(attemptUntilToken(state, new Set(["stale"]), "ok"), state),
    )
    expect(yields).toEqual(["ok"])
    expect(result.text).toBe("ok")
    expect(refreshCalls).toBe(1)
    expect((state.auth as { token: string }).token).toBe("fresh")
  })

  it("keychain-first: adopts a peer-rotated token WITHOUT a network refresh", async () => {
    let refreshCalls = 0
    const state: AuthRefreshState = {
      auth: {
        kind: "oauth",
        token: "stale",
        refresh: async () => {
          refreshCalls++
          return { token: "network-fresh" }
        },
      },
    }
    const { result } = await drain(
      withAuthRefresh(attemptUntilToken(state, new Set(["stale"]), "ok"), state, {
        peerToken: () => "peer-fresh",
      }),
    )
    expect(result.text).toBe("ok")
    expect(refreshCalls).toBe(0) // peer rotation pre-empted the network refresh
    expect((state.auth as { token: string }).token).toBe("peer-fresh")
  })

  it("falls through to network refresh when peerToken has nothing fresher", async () => {
    let refreshCalls = 0
    const state: AuthRefreshState = {
      auth: {
        kind: "oauth",
        token: "stale",
        refresh: async () => {
          refreshCalls++
          return { token: "fresh" }
        },
      },
    }
    await drain(
      withAuthRefresh(attemptUntilToken(state, new Set(["stale"]), "ok"), state, {
        peerToken: () => undefined,
      }),
    )
    expect(refreshCalls).toBe(1)
    expect((state.auth as { token: string }).token).toBe("fresh")
  })

  it("rethrows when 401 persists after peer + refresh (no infinite loop)", async () => {
    let refreshCalls = 0
    let attempts = 0
    const state: AuthRefreshState = {
      auth: {
        kind: "oauth",
        token: "stale",
        refresh: async () => {
          refreshCalls++
          return { token: "also-stale" }
        },
      },
    }
    let caught = ""
    try {
      await drain(
        withAuthRefresh(
          () =>
            (async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
              attempts++
              throw err401() // always 401, even after refresh
            })(),
          state,
          { peerToken: () => "peer-but-still-stale" },
        ),
      )
    } catch (e) {
      caught = (e as Error).message
    }
    expect(caught).toContain("401")
    // attempt 1 (orig) → peer retry → refresh retry → give up = 3 attempts.
    expect(attempts).toBe(3)
    expect(refreshCalls).toBe(1)
  })

  it("propagates a non-401 error without refreshing", async () => {
    let refreshCalls = 0
    const state: AuthRefreshState = {
      auth: { kind: "oauth", token: "t", refresh: async () => (refreshCalls++, { token: "x" }) },
    }
    let caught = ""
    try {
      await drain(
        withAuthRefresh(
          () =>
            (async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
              throw new Error("500 overloaded")
            })(),
          state,
        ),
      )
    } catch (e) {
      caught = (e as Error).message
    }
    expect(caught).toContain("500")
    expect(refreshCalls).toBe(0)
  })

  it("api-key auth: a 401 propagates (no refresh path)", async () => {
    const state: AuthRefreshState = { auth: { kind: "api-key", key: "sk" } as ProviderAuth }
    let caught = ""
    try {
      await drain(
        withAuthRefresh(
          () =>
            (async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
              throw err401()
            })(),
          state,
        ),
      )
    } catch (e) {
      caught = (e as Error).message
    }
    expect(caught).toContain("401")
  })
})
