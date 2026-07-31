/**
 * Integration-ish unit tests for runCompact (local path + remote auth pin).
 *
 * Regression: remote compact must use the same credentialName as live turns.
 * Without it, multi-account OAuth sessions hit the default account
 * on /compact (401 token_expired) while the turn path uses --credential-name.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { defaultAuthStore, resetDefaultAuthStoreForTests } from "../auth/auth-store.ts"
import type { Message } from "../llm/messages.ts"
import { clearModelRegistry, clearProviderRegistry } from "../llm/model-registry.ts"
import type { ProviderAuth } from "../llm/provider.ts"
import { clearProviderPlugins } from "../llm/provider-plugin.ts"
import { registerTestProvider } from "../llm/test-fixtures.ts"

import { agentCompact, type CompactableAgent } from "./agent-compact-methods.ts"
import { COMPACTION_USER_MARKER } from "./context-compact.ts"
import { runCompact } from "./run-compact.ts"

describe("runCompact local path", () => {
  it("rewrites history in place with a local checkpoint when remote is forced off", async () => {
    const messages: Message[] = []
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `u${i}` })
      messages.push({ role: "assistant", content: `a${i}` })
    }
    const before = messages.length
    const notes: string[] = []
    const stats = await runCompact({
      messages,
      model: "does-not-matter",
      auth: { type: "api-key", token: "x" },
      reason: "manual",
      preferRemote: false,
      appendNote: (t) => notes.push(t),
    })
    expect(stats.kind).toBe("local")
    expect(stats.messagesBefore).toBe(before)
    expect(stats.messagesAfter).toBeLessThan(before)
    expect(messages.length).toBe(stats.messagesAfter)
    const firstText =
      typeof messages[0].content === "string"
        ? messages[0].content
        : messages[0].content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(firstText).toContain(COMPACTION_USER_MARKER)
    expect(notes.some((n) => n.includes("compact: local"))).toBe(true)
  })

  it("is a no-op stats-wise on empty history", async () => {
    const messages: Message[] = []
    const stats = await runCompact({
      messages,
      model: "x",
      auth: { type: "api-key", token: "x" },
      reason: "auto",
      preferRemote: false,
    })
    expect(stats.messagesBefore).toBe(0)
    expect(stats.messagesAfter).toBe(0)
  })
})

describe("runCompact remote credentialName pin", () => {
  let dir: string
  const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
  let seenAuth: ProviderAuth | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-run-compact-cred-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    seenAuth = undefined

    const handle = registerTestProvider({
      id: "compact-cred-prov",
      displayName: "Compact Cred Prov",
      shortCode: "ccp",
      models: [{ id: "compact-cred-model" }],
      apiKeyAuth: {
        serviceId: "compact-cred-api",
        displayName: "Compact Cred Default",
        buildCredential: (apiKey: string) => ({
          serviceId: "compact-cred-api",
          displayName: "Compact Cred Default",
          secrets: { tokenType: "api-key", apiKey },
        }),
        readApiKey: (secrets: Record<string, unknown>) =>
          typeof secrets.apiKey === "string" ? secrets.apiKey : null,
      },
    })

    handle.adapter.compact = async (_input, _model, ctx) => {
      seenAuth = ctx.auth
      return {
        kind: "remote",
        replacementMessages: [
          { role: "user", content: "compacted" },
          { role: "assistant", content: "ok" },
        ],
      }
    }

    defaultAuthStore().set("compact-cred-api", "Compact Cred Default", {
      tokenType: "api-key",
      apiKey: "sk-default-account",
    })
    defaultAuthStore().set("compact-cred-api", "pinned-cred-3", {
      tokenType: "api-key",
      apiKey: "sk-pinned-account",
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
  })

  it("uses the default stored credential when credentialName is omitted (legacy)", async () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]
    const stats = await runCompact({
      messages,
      model: "compact-cred-model",
      providerId: "compact-cred-prov",
      auth: { type: "api-key", token: "sk-session" },
      reason: "manual",
      preferRemote: true,
    })
    expect(stats.kind).toBe("remote")
    expect(seenAuth).toEqual({ kind: "api-key", key: "sk-default-account" })
  })

  it("REGRESSION: remote compact uses credentialName, not the provider default", async () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]
    const stats = await runCompact({
      messages,
      model: "compact-cred-model",
      providerId: "compact-cred-prov",
      auth: { type: "api-key", token: "sk-session" },
      credentialName: "pinned-cred-3",
      reason: "manual",
      preferRemote: true,
    })
    expect(stats.kind).toBe("remote")
    expect(seenAuth).toEqual({ kind: "api-key", key: "sk-pinned-account" })
  })

  it("REGRESSION: agentCompact forwards agent.credentialName into remote compact", async () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]
    const agent: CompactableAgent = {
      messages,
      model: "compact-cred-model",
      providerId: "compact-cred-prov",
      auth: { type: "api-key", token: "sk-session" },
      credentialName: "pinned-cred-3",
      appendNote() {},
      store: null,
    }
    const stats = await agentCompact(agent, { reason: "manual", preferRemote: true })
    expect(stats.kind).toBe("remote")
    expect(seenAuth).toEqual({ kind: "api-key", key: "sk-pinned-account" })
  })
})
