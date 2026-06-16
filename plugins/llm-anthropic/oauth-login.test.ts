import { describe, expect, it } from "bun:test"

import type {
  NetworkClient,
  NetworkRequestInput,
  NetworkResponse,
} from "@minimal-agent/plugin-api/net/types"

import { inspectAnthropicOAuthCredential, refreshAnthropicOAuthCredential } from "./oauth-login.ts"

function jsonNetworkResponse(body: Record<string, unknown>, status = 200): NetworkResponse {
  return {
    status,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    }),
    transport: { id: "test" },
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async <T = unknown>() => body as T,
  }
}

function recordingJsonClient(body: Record<string, unknown>): {
  client: NetworkClient
  calls: NetworkRequestInput[]
} {
  const calls: NetworkRequestInput[] = []
  return {
    calls,
    client: {
      async request(input) {
        calls.push(input)
        return jsonNetworkResponse(body)
      },
    },
  }
}

describe("refreshAnthropicOAuthCredential", () => {
  it("inspects stored metadata without exposing tokens", () => {
    const info = inspectAnthropicOAuthCredential({
      tokenType: "oauth",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: 1_700_000_000_000,
      scopes: ["user:profile", "user:inference"],
      accountUuid: "acc-existing",
      organizationUuid: "org-existing",
    })

    expect(info).toEqual({
      usable: true,
      expiresAt: 1_700_000_000_000,
      hasRefreshToken: true,
      accountId: "acc-existing",
      organizationId: "org-existing",
      scopes: ["user:profile", "user:inference"],
    })
    expect(JSON.stringify(info)).not.toContain("AT")
    expect(JSON.stringify(info)).not.toContain("RT")
  })

  it("refreshes with a rotated refresh token and preserves existing real metadata", async () => {
    const { client, calls } = recordingJsonClient({
      access_token: "AT-new",
      refresh_token: "RT-new",
      expires_in: 3600,
      scope: "user:profile user:inference",
    })

    const refreshed = await refreshAnthropicOAuthCredential(
      {
        tokenType: "oauth",
        accessToken: "AT-old",
        refreshToken: "RT-old",
        accountUuid: "acc-existing",
        emailAddress: "u@example.com",
        organizationUuid: "org-existing",
      },
      { networkClient: client },
    )

    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]?.body as string)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "RT-old",
    })
    expect(refreshed.credential.secrets).toMatchObject({
      tokenType: "oauth",
      accessToken: "AT-new",
      refreshToken: "RT-new",
      accountUuid: "acc-existing",
      emailAddress: "u@example.com",
      organizationUuid: "org-existing",
    })
    expect(refreshed.result.refreshToken).toBe("RT-new")
    expect(refreshed.result.account).toEqual({
      uuid: "acc-existing",
      emailAddress: "u@example.com",
    })
    expect(refreshed.result.organization).toEqual({ uuid: "org-existing" })
  })

  it("refreshes without persisting fake account metadata when none exists", async () => {
    const { client } = recordingJsonClient({
      access_token: "AT-new",
      expires_in: 3600,
      scope: "user:profile",
    })

    const refreshed = await refreshAnthropicOAuthCredential(
      {
        tokenType: "oauth",
        accessToken: "AT-old",
        refreshToken: "RT-old",
      },
      { networkClient: client },
    )

    expect(refreshed.credential.secrets).toMatchObject({
      tokenType: "oauth",
      accessToken: "AT-new",
      refreshToken: "RT-old",
    })
    expect(refreshed.credential.secrets.accountUuid).toBeUndefined()
    expect(refreshed.credential.secrets.emailAddress).toBeUndefined()
    expect(refreshed.credential.secrets.organizationUuid).toBeUndefined()
    expect(Object.values(refreshed.credential.secrets)).not.toContain("unknown")
    expect(refreshed.result.account).toBeUndefined()
    expect(refreshed.result.organization).toBeUndefined()
  })
})
