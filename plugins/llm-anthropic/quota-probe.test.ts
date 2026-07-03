/**
 * Parity pins for the canonical quota probe (vs the legacy checkQuota
 * contract it replaces): minimal quota-shaped request, rate-limit
 * broadcast on 200, soft-fail on errors, single 401 recovery retry.
 */

import { beforeAll, describe, expect, it } from "bun:test"

import type {
  NetworkClient,
  NetworkRequest,
  NetworkResponse,
} from "@minimal-agent/plugin-api/net/types"

import type { AuthResult } from "../../src/auth/auth.ts"
import { getLastRateLimits } from "../../src/quota/quota-cache.ts"

import { registerAnthropicModels } from "./models.ts"
import { probeQuota } from "./quota-probe.ts"

beforeAll(() => {
  registerAnthropicModels()
})

const oauth: AuthResult = { type: "oauth", token: "tok-1" }

function fakeClient(respond: (req: NetworkRequest, calls: number) => Partial<NetworkResponse>): {
  client: NetworkClient
  requests: NetworkRequest[]
} {
  const requests: NetworkRequest[] = []
  const client = {
    request: async (req: NetworkRequest): Promise<NetworkResponse> => {
      requests.push(req)
      const partial = respond(req, requests.length)
      return {
        ok: (partial.status ?? 200) < 400,
        status: partial.status ?? 200,
        headers: partial.headers ?? new Headers(),
        text: async () => "",
        json: async <T>() => ({}) as T,
        ...partial,
      } as NetworkResponse
    },
  } as NetworkClient
  return { client, requests }
}

describe("probeQuota", () => {
  it("sends the minimal quota shape and broadcasts rate-limit headers on 200", async () => {
    const { client, requests } = fakeClient(() => ({
      status: 200,
      headers: new Headers({ "acme-ratelimit-unified-5h-utilization": "0.31" }),
    }))
    const result = await probeQuota(oauth, client)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rateLimits.get("acme-ratelimit-unified-5h-utilization")).toBe("0.31")
    }
    // Broadcast side effect reached the cache.
    expect(getLastRateLimits()?.rateLimits.get("acme-ratelimit-unified-5h-utilization")).toBe(
      "0.31",
    )

    // Wire shape: 1 token, cheap tier, quota beta set (no claude-code flag).
    expect(requests).toHaveLength(1)
    const body = JSON.parse(String(requests[0].body))
    expect(body.max_tokens).toBe(1)
    expect(body.model).toContain("haiku")
    const beta = requests[0].headers?.["anthropic-beta"] ?? ""
    expect(beta).not.toContain("claude-code-20250219")
  })

  it("soft-fails ({ok:false}) on a non-401 error without retrying", async () => {
    const { client, requests } = fakeClient(() => ({ status: 529 }))
    const result = await probeQuota({ ...oauth }, client)
    expect(result.ok).toBe(false)
    expect(requests).toHaveLength(1)
  })

  it("recovers once from a 401 via auth.refresh and succeeds", async () => {
    let refreshed = false
    const auth: AuthResult = {
      type: "oauth",
      token: "stale",
      refresh: async () => {
        refreshed = true
        return { type: "oauth", token: "fresh" } as AuthResult
      },
    }
    const { client, requests } = fakeClient((req, n) =>
      n === 1 ? { status: 401 } : { status: 200, headers: new Headers() },
    )
    // Empty store via the injected reader: forces the NETWORK refresh
    // leg (on a dev machine the real store would satisfy peer adoption
    // first and the test would never exercise refresh()).
    const result = await probeQuota(auth, client, undefined, { readCreds: () => null })
    expect(refreshed).toBe(true)
    expect(result.ok).toBe(true)
    expect(requests.length).toBeGreaterThanOrEqual(2)
    const lastAuth = requests[requests.length - 1].headers?.authorization ?? ""
    expect(lastAuth).toContain("fresh")
  })

  it("never throws: network-level rejection becomes {ok:false}", async () => {
    const client = {
      request: async () => {
        throw new Error("ECONNRESET")
      },
    } as unknown as NetworkClient
    const result = await probeQuota(oauth, client)
    expect(result.ok).toBe(false)
  })
})
