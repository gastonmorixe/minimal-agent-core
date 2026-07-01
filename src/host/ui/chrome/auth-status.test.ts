import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../../../term-width.ts"

import { formatRelative, renderAuthStatusRows } from "./auth-status.ts"

describe("auth-status chrome", () => {
  it("renders not-logged-in rows", () => {
    const text = renderAuthStatusRows({ providers: [], now: 1 }).map(stripAnsi).join("\n")
    expect(text).toContain("not logged in")
    expect(text).toContain("run `minimal-agent provider <id> login`")
  })

  it("renders api-key auth", () => {
    const text = renderAuthStatusRows({
      providers: [
        {
          providerId: "provider-a",
          displayName: "Provider A",
          authKind: "api-key",
          source: "store",
          auth: { kind: "api-key", key: "sk-ant-..." },
        },
      ],
      now: 1,
    })
      .map(stripAnsi)
      .join("\n")
    expect(text).toContain("provider-a")
    expect(text).toContain("api-key")
    expect(text).toContain("✔")
  })

  it("renders OAuth status", () => {
    const text = renderAuthStatusRows({
      providers: [
        {
          providerId: "provider-a",
          displayName: "Provider A",
          authKind: "oauth",
          source: "store",
          auth: {
            kind: "oauth",
            token: "AT",
          },
        },
      ],
      now: 1,
    })
      .map(stripAnsi)
      .join("\n")

    expect(text).toContain("provider-a")
    expect(text).toContain("oauth")
    expect(text).toContain("✔")
  })

  it("renders safe credential metadata and unreadable credentials", () => {
    const text = renderAuthStatusRows({
      providers: [
        {
          providerId: "provider-a",
          displayName: "Provider A",
          authKind: "oauth",
          source: "store",
          credentialInfo: {
            usable: true,
            expiresAt: 1_700_000_060_000,
            hasRefreshToken: true,
            accountId: "acct-1",
            organizationId: "org-1",
            scopes: ["scope:a", "scope:b"],
          },
          auth: {
            kind: "oauth",
            token: "AT",
          },
        },
        {
          providerId: "provider-b",
          displayName: "Broken Provider",
          authKind: "api-key",
          source: "store",
          credentialInfo: { usable: false },
          auth: null,
        },
      ],
      now: 1_700_000_000_000,
    })
      .map(stripAnsi)
      .join("\n")

    expect(text).toContain("provider-a")
    expect(text).toContain("account acct-1")
    expect(text).toContain("org org-1")
    expect(text).toContain("scopes scope:a scope:b")
    expect(text).toContain("refresh present")
    expect(text).toContain("provider-b")
    expect(text).toContain("credential unreadable")
    expect(text).not.toContain("AT")
  })

  it("renders multiple credentials per provider", () => {
    const text = renderAuthStatusRows({
      providers: [
        {
          providerId: "provider-c",
          displayName: "Provider C",
          authKind: "oauth",
          source: "store",
          credentialName: "Work",
          credentialInfo: { usable: true },
          auth: { kind: "oauth", token: "AT1" },
        },
        {
          providerId: "provider-c",
          displayName: "Provider C",
          authKind: "oauth",
          source: "store",
          credentialName: "Personal",
          credentialInfo: { usable: true },
          auth: { kind: "oauth", token: "AT2" },
        },
      ],
      now: 1,
    })
      .map(stripAnsi)
      .join("\n")

    expect(text).toContain("provider-c")
    expect(text).toContain("Work")
    expect(text).toContain("Personal")
  })

  it("formats relative durations compactly", () => {
    expect(formatRelative(59_000)).toBe("59s")
    expect(formatRelative(5 * 60_000 + 20_000)).toBe("5m 20s")
    expect(formatRelative(3 * 3600_000 + 12 * 60_000)).toBe("3h 12m")
    expect(formatRelative(4 * 24 * 3600_000 + 6 * 3600_000)).toBe("4d 6h")
  })
})
