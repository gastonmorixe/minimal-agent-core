import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../../../terminal/term-width.ts"

import { formatRelative, renderAuthStatusRows } from "./auth-status.ts"

describe("auth-status chrome", () => {
  it("renders not-logged-in rows", () => {
    const text = renderAuthStatusRows({ providers: [], now: 1 }).map(stripAnsi).join("\n")
    expect(text).toContain("not logged in")
    expect(text).toContain("Run `minimal-agent provider <id> login`")
  })

  it("ignores expiry timestamps outside the Date range", () => {
    const rows = renderAuthStatusRows({
      providers: [
        {
          providerId: "test",
          displayName: "Test",
          authKind: "oauth",
          source: "store",
          credentialInfo: { usable: true, expiresAt: 1e100 },
          auth: { kind: "oauth", token: "secret" },
        },
      ],
      now: 1,
    })
    expect(rows.map(stripAnsi).join("\n")).not.toContain("expires:")
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

  it("renders provider-owned detail rows verbatim", () => {
    const text = renderAuthStatusRows({
      providers: [
        {
          providerId: "cursor",
          displayName: "Cursor",
          authKind: "oauth",
          source: "store",
          auth: { kind: "oauth", token: "AT" },
          credentialInfo: {
            usable: true,
            accountId: "51930405",
            details: [
              { key: "userId", label: "user id", value: "51930405" },
              { key: "email", label: "email", value: "gaston@gastonmorixe.com" },
              { key: "plan", label: "plan", value: "$20.00 plan, $20.00 used" },
              { key: "on-demand", label: "on-demand", value: "$1.58 / $1.00" },
              { key: "usage-note", label: "note", value: "You've hit your usage limit" },
            ],
          },
        },
      ],
      now: 1,
    })
      .map(stripAnsi)
      .join("\n")

    expect(text).toContain("user id: 51930405")
    expect(text).toContain("email: gaston@gastonmorixe.com")
    expect(text).toContain("plan: $20.00 plan, $20.00 used")
    expect(text).toContain("on-demand: $1.58 / $1.00")
    expect(text).toContain("note: You've hit your usage limit")
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
    expect(text).toContain("account: acct-1")
    expect(text).toContain("org: org-1")
    expect(text).toContain("scopes: scope:a scope:b")
    expect(text).toContain("refresh: present")
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

  it("keeps named credential boundaries, sanitizes metadata and shows expiry", () => {
    const now = 1_700_000_000_000
    const rows = renderAuthStatusRows({
      providers: [
        {
          providerId: "example\r",
          displayName: "Example\nProvider",
          authKind: "oauth",
          source: "store",
          credentialName: "Work\tname",
          credentialLabel: "Ignored label",
          auth: { kind: "oauth", token: "secret-token" },
          credentialInfo: {
            usable: true,
            expiresAt: now + 60_000,
            hasRefreshToken: true,
            accountId: "acct\nnext",
            organizationId: "org\rnext",
            scopes: ["read\x07", "write\u009b"],
            details: [
              { key: "usage", label: "usage\tlabel", value: `${"x".repeat(2000)}\x1b[2J\nnext` },
            ],
          },
        },
        {
          providerId: "example\r",
          displayName: "Example",
          authKind: "api-key",
          source: "store",
          credentialName: "Broken",
          auth: null,
          credentialInfo: { usable: false, expiresAt: now - 60_000, hasRefreshToken: false },
        },
        {
          providerId: "example\r",
          displayName: "Example",
          authKind: "api-key",
          source: "store",
          credentialLabel: "Label fallback",
          auth: { kind: "api-key", key: "secret-key" },
        },
        {
          providerId: "example\r",
          displayName: "Example",
          authKind: "api-key",
          source: "store",
          auth: { kind: "api-key", key: "secret-default" },
        },
      ],
      now,
    })
    const plain = rows.map(stripAnsi)
    expect(plain[1]).toBe("  Example Provider (example)")
    expect(plain[2]).toBe("    Work name ✔ oauth")
    expect(rows[2]).toContain("\x1b[1mWork name")
    expect(plain).toContain("      account: acct next")
    expect(plain).toContain("      org: org next")
    expect(plain).toContain("      scopes: read  write")
    expect(plain).toContain(`      usage label: ${"x".repeat(2000)} [2J next`)
    const broken = plain.indexOf("    Broken ✗ api-key credential unreadable")
    expect(broken).toBeGreaterThan(2)
    expect(plain[broken - 1]).toBe("")
    expect(plain).toContain("    Label fallback ✔ api-key")
    expect(plain).toContain("    Credential 4 ✔ api-key")
    const text = plain.join("\n")
    expect(text).toContain("expires: 2023-11-14 22:14:20 UTC (in 1m)")
    expect(text).toContain("expires: expired 1m ago")
    expect(text).toContain("refresh: present")
    expect(text).toContain("refresh: missing")
    expect(text).not.toContain("secret-")
    expect(text).not.toContain("Ignored label")
    expect(plain.join("")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
  })

  it("formats relative durations compactly", () => {
    expect(formatRelative(59_000)).toBe("59s")
    expect(formatRelative(5 * 60_000 + 20_000)).toBe("5m 20s")
    expect(formatRelative(3 * 3600_000 + 12 * 60_000)).toBe("3h 12m")
    expect(formatRelative(4 * 24 * 3600_000 + 6 * 3600_000)).toBe("4d 6h")
  })
})
