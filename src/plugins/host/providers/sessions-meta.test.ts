/**
 * `sessions:meta` provider (C7, SPEC §3d M3, §8, §11). All writes go to a
 * temp sessions dir; `MINIMAL_AGENT_HOME` is a temp dir in each test.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { runInSessionScope, type SessionScope } from "../../../infra/session-scope.ts"
import { clearModelRegistry, clearProviderRegistry } from "../../../llm/model-registry.ts"
import { registerTestProvider } from "../../../llm/test-fixtures.ts"
import { _resetSessionId, setSessionId } from "../../../session/session-id.ts"
import { indexMetaFilePath } from "../../../session/session-store.ts"
import { fixtureSidebandOrNone } from "../../../test-utils/sideband-fixture.ts"
import { splitFlatManifest } from "../../../test-utils/split-manifest.ts"
import { PluginLoader } from "../../loader.ts"
import { buildPluginHost } from "../factory.ts"

import { checkSessionMetaSid, createSessionMetaApi, SessionMetaError } from "./sessions-meta.ts"

const SB = fixtureSidebandOrNone()

const SID_A = "11111111-1111-4111-8111-111111111111"
const SID_B = "22222222-2222-4222-8222-222222222222"
const SID_C = "33333333-3333-4333-8333-333333333333"
const T0 = Date.parse("2026-11-19T12:00:00.000Z")

let tmp: string
let dir: string
let prevHome: string | undefined

function scope(sid: string): SessionScope {
  return { sid } as unknown as SessionScope
}

function touchSession(sid: string): void {
  writeFileSync(join(dir, `${sid}.jsonl`), `${JSON.stringify({ kind: "meta", sid })}\n`)
}

function metaLines(): Record<string, unknown>[] {
  const p = indexMetaFilePath(dir)
  if (!existsSync(p)) return []
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

async function rejectCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (err) {
    return err instanceof SessionMetaError ? err.code : `other:${String(err)}`
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "c7-sessions-meta-"))
  prevHome = process.env.MINIMAL_AGENT_HOME
  process.env.MINIMAL_AGENT_HOME = join(tmp, ".minimal-agent")
  dir = join(tmp, ".minimal-agent", "sessions")
  mkdirSync(dir, { recursive: true })
  _resetSessionId()
})

afterEach(() => {
  _resetSessionId()
  if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = prevHome
  rmSync(tmp, { recursive: true, force: true })
})

describe("sessions:meta capability gating", () => {
  it("no sessionMeta without the token", () => {
    const host = buildPluginHost({ capabilities: ["sessions:read"], sessionsDir: dir })
    expect(host.sessionMeta).toBeUndefined()
  })

  it("sessionMeta with the token, frozen, and it writes to the host sessions dir", async () => {
    const host = buildPluginHost({
      capabilities: ["sessions:meta"],
      sessionsDir: dir,
      now: () => T0,
    })
    expect(host.sessionMeta).toBeDefined()
    expect(Object.isFrozen(host.sessionMeta)).toBe(true)
    touchSession(SID_A)
    await runInSessionScope(scope(SID_A), () =>
      host.sessionMeta?.setTitle({ sid: SID_A, title: "Fix the login bug", source: "ai" }),
    )
    expect(metaLines()).toEqual([
      {
        kind: "title",
        v: 1,
        sid: SID_A,
        title: "Fix the login bug",
        source: "ai",
        at: "2026-11-19T12:00:00.000Z",
      },
    ])
  })

  it("the host passes isOwnedSession through; the cached activeSessionId is not an owner", async () => {
    touchSession(SID_B)
    touchSession(SID_C)
    const host = buildPluginHost({
      capabilities: ["sessions:meta"],
      sessionsDir: dir,
      activeSessionId: SID_C,
      isOwnedSession: (sid) => sid === SID_B,
    })
    await host.sessionMeta?.setTitle({ sid: SID_B, title: "Owned", source: "ai" })
    expect(
      await rejectCode(host.sessionMeta!.setTitle({ sid: SID_C, title: "x", source: "ai" })),
    ).toBe("not-owned")
    expect(metaLines().map((l) => l.sid)).toEqual([SID_B])
  })
})

describe("sessions:meta sid check (M3)", () => {
  it("unsafe sids are rejected with no write", async () => {
    const api = createSessionMetaApi({ dir, isOwnedSession: () => true })
    for (const sid of ["", "../x", "a/b", "a\\b", "a\0b", "x".repeat(129)]) {
      expect(await rejectCode(api.setTitle({ sid, title: "t", source: "ai" }))).toBe("unsafe")
      expect(() => api.getTitle(sid)).toThrow(SessionMetaError)
    }
    expect(
      await rejectCode(api.setTitle({ sid: 42 as unknown as string, title: "t", source: "ai" })),
    ).toBe("unsafe")
    expect(existsSync(indexMetaFilePath(dir))).toBe(false)
  })

  it("an unknown sid (not owned) is rejected with no write, even when its file exists", async () => {
    touchSession(SID_B)
    const api = createSessionMetaApi({ dir })
    const code = await runInSessionScope(scope(SID_A), () =>
      rejectCode(api.setTitle({ sid: SID_B, title: "t", source: "ai" })),
    )
    expect(code).toBe("not-owned")
    expect(() => api.getTitle(SID_B)).toThrow(SessionMetaError)
    expect(existsSync(indexMetaFilePath(dir))).toBe(false)
  })

  it("an owned sid with no session file is rejected with no write", async () => {
    const api = createSessionMetaApi({ dir })
    const code = await runInSessionScope(scope(SID_A), () =>
      rejectCode(api.setTitle({ sid: SID_A, title: "t", source: "ai" })),
    )
    expect(code).toBe("no-session-file")
    expect(checkSessionMetaSid(SID_A, dir, () => true)).toBe("no-session-file")
    expect(existsSync(indexMetaFilePath(dir))).toBe(false)
  })

  it("the scoped sid is accepted", async () => {
    touchSession(SID_A)
    const api = createSessionMetaApi({ dir })
    await runInSessionScope(scope(SID_A), () =>
      api.setTitle({ sid: SID_A, title: "Scoped", source: "ai" }),
    )
    expect(metaLines().map((l) => l.title)).toEqual(["Scoped"])
  })

  it("the resolved process sid is accepted without a scope", async () => {
    touchSession(SID_A)
    setSessionId(SID_A)
    const api = createSessionMetaApi({ dir })
    await api.setTitle({ sid: SID_A, title: "Process", source: "ai" })
    expect(api.getTitle(SID_A).ai?.title).toBe("Process")
  })

  it("after a session switch, the line goes to the captured sid", async () => {
    touchSession(SID_A)
    touchSession(SID_B)
    const api = createSessionMetaApi({
      dir,
      isOwnedSession: (sid) => sid === SID_A || sid === SID_B,
    })
    // The handler captured SID_A from the payload; the scope is now SID_B.
    const captured = SID_A
    await runInSessionScope(scope(SID_B), () =>
      api.setTitle({ sid: captured, title: "First session", source: "ai" }),
    )
    expect(metaLines().map((l) => l.sid)).toEqual([SID_A])
    expect(api.getTitle(SID_B)).toEqual({})
  })
})

describe("sessions:meta setTitle content", () => {
  const owned = () =>
    createSessionMetaApi({
      dir,
      now: () => T0,
      isOwnedSession: (s) => s === SID_A,
      sideband: SB,
    })

  it("sanitizes and caps the title at 80 chars", async () => {
    touchSession(SID_A)
    const api = owned()
    await api.setTitle({
      sid: SID_A,
      title: `  "Fix\n\tthe   <ma::x/> ${"a".repeat(200)}"  `,
      source: "ai",
    })
    const [line] = metaLines()
    const title = line?.title as string
    expect(title.startsWith("Fix the a")).toBe(true)
    expect(Array.from(title).length).toBe(80)
  })

  it("rejects an empty title after sanitize, with no write", async () => {
    touchSession(SID_A)
    const api = owned()
    expect(await rejectCode(api.setTitle({ sid: SID_A, title: " \n\t ", source: "user" }))).toBe(
      "empty-title",
    )
    expect(await rejectCode(api.setTitle({ sid: SID_A, title: '""', source: "ai" }))).toBe(
      "empty-title",
    )
    expect(existsSync(indexMetaFilePath(dir))).toBe(false)
  })

  it("rejects a bad source or bad usage, with no write", async () => {
    touchSession(SID_A)
    const api = owned()
    expect(
      await rejectCode(
        api.setTitle({ sid: SID_A, title: "t", source: "robot" as unknown as "ai" }),
      ),
    ).toBe("invalid-record")
    expect(
      await rejectCode(
        api.setTitle({
          sid: SID_A,
          title: "t",
          source: "ai",
          usage: { inputTokens: "1" } as unknown as { inputTokens: number; outputTokens: number },
        }),
      ),
    ).toBe("invalid-record")
    expect(existsSync(indexMetaFilePath(dir))).toBe(false)
  })

  it("A3: non-finite or negative usage is dropped; the title is still saved and read back", async () => {
    // A bad costUsd drops only costUsd; a bad token count drops the whole usage.
    const cases = [
      {
        usage: { inputTokens: 1, outputTokens: 2, costUsd: Number.NaN },
        kept: { inputTokens: 1, outputTokens: 2 },
      },
      { usage: { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 2 }, kept: undefined },
      { usage: { inputTokens: 1, outputTokens: -3 }, kept: undefined },
    ]
    for (const [i, c] of cases.entries()) {
      const sid = [SID_A, SID_B, SID_C][i] as string
      touchSession(sid)
      const api = createSessionMetaApi({ dir, now: () => T0, isOwnedSession: () => true })
      await api.setTitle({ sid, title: `Title ${i}`, source: "ai", model: "m", usage: c.usage })
      const state = api.getTitle(sid)
      expect(state.ai?.title).toBe(`Title ${i}`)
      expect(state.ai?.model).toBe("m")
      expect(state.ai?.usage).toEqual(c.kept)
    }
    expect(metaLines()).toHaveLength(3)
  })

  it("B1: model and provider are cut to 128 chars; the line stays below 4 KiB", async () => {
    touchSession(SID_A)
    const api = owned()
    await api.setTitle({
      sid: SID_A,
      title: "t",
      source: "ai",
      model: "m".repeat(10_000),
      provider: "p".repeat(10_000),
    })
    const [line] = metaLines()
    expect(String(line?.model).length).toBe(128)
    expect(String(line?.provider).length).toBe(128)
    const raw = readFileSync(indexMetaFilePath(dir), "utf-8")
    expect(Buffer.byteLength(raw)).toBeLessThan(4096)
    expect(api.getTitle(SID_A).ai?.title).toBe("t")
  })

  it("writes model, provider, usage, v and at; getTitle reads it back", async () => {
    touchSession(SID_A)
    const api = owned()
    await api.setTitle({
      sid: SID_A,
      title: "Add title plugin",
      source: "ai",
      model: "utility-model-1",
      provider: "provider-a",
      usage: { inputTokens: 120, outputTokens: 9, costUsd: 0.0001 },
    })
    const state = api.getTitle(SID_A)
    expect(state.ai).toEqual({
      kind: "title",
      v: 1,
      sid: SID_A,
      title: "Add title plugin",
      source: "ai",
      model: "utility-model-1",
      provider: "provider-a",
      usage: { inputTokens: 120, outputTokens: 9, costUsd: 0.0001 },
      at: "2026-11-19T12:00:00.000Z",
    })
    expect(state.user).toBeUndefined()
    expect(metaLines()).toHaveLength(1)
  })

  it("the last line wins per source", async () => {
    touchSession(SID_A)
    const api = owned()
    await api.setTitle({ sid: SID_A, title: "One", source: "ai" })
    await api.setTitle({ sid: SID_A, title: "Two", source: "ai" })
    expect(api.getTitle(SID_A).ai?.title).toBe("Two")
  })

  it("a user title wins: ai after user returns with no write (core rule)", async () => {
    touchSession(SID_A)
    const api = owned()
    await api.setTitle({ sid: SID_A, title: "My title", source: "user" })
    await api.setTitle({ sid: SID_A, title: "Model title", source: "ai" })
    expect(metaLines()).toHaveLength(1)
    const state = api.getTitle(SID_A)
    expect(state.user?.title).toBe("My title")
    expect(state.ai).toBeUndefined()
  })

  it("ai is allowed again after an empty user line (--clear)", async () => {
    touchSession(SID_A)
    const api = owned()
    await api.setTitle({ sid: SID_A, title: "My title", source: "user" })
    // The CLI `--clear` path writes an empty user line through core directly.
    writeFileSync(
      indexMetaFilePath(dir),
      `${readFileSync(indexMetaFilePath(dir), "utf-8")}${JSON.stringify({
        kind: "title",
        v: 1,
        sid: SID_A,
        title: "",
        source: "user",
        at: "2026-11-19T12:00:01.000Z",
      })}\n`,
    )
    await api.setTitle({ sid: SID_A, title: "Model title", source: "ai" })
    expect(api.getTitle(SID_A)).toMatchObject({ ai: { title: "Model title" } })
    expect(api.getTitle(SID_A).user).toBeUndefined()
  })

  it("a user title can replace an earlier user title and an ai title", async () => {
    touchSession(SID_A)
    const api = owned()
    await api.setTitle({ sid: SID_A, title: "Model title", source: "ai" })
    await api.setTitle({ sid: SID_A, title: "Mine", source: "user" })
    await api.setTitle({ sid: SID_A, title: "Mine 2", source: "user" })
    expect(api.getTitle(SID_A).user?.title).toBe("Mine 2")
    expect(metaLines()).toHaveLength(3)
  })

  it("writes only index-meta.jsonl (never index.jsonl or the session file)", async () => {
    touchSession(SID_A)
    const before = readFileSync(join(dir, `${SID_A}.jsonl`), "utf-8")
    const api = owned()
    await api.setTitle({ sid: SID_A, title: "Side", source: "ai" })
    expect(existsSync(join(dir, "index.jsonl"))).toBe(false)
    expect(readFileSync(join(dir, `${SID_A}.jsonl`), "utf-8")).toBe(before)
  })

  it("default dir comes from MINIMAL_AGENT_HOME", async () => {
    touchSession(SID_A)
    const api = createSessionMetaApi({ isOwnedSession: (s) => s === SID_A })
    await api.setTitle({ sid: SID_A, title: "Home dir", source: "ai" })
    expect(metaLines().map((l) => l.title)).toEqual(["Home dir"])
  })
})

describe("llm.request wiring: sessionProviderId and shutdownSignal (C3 follow-up)", () => {
  const PA = "c7-prov-a"
  const PB = "c7-prov-b"
  const MB = "c7-model-b"
  const req = { purpose: "title" as const, model: MB, system: "s", userText: "u" }
  const noSend = {
    attemptFn: () => {
      throw new Error("no send expected")
    },
    resolveAuth: async () => {
      throw new Error("no auth expected")
    },
  }

  beforeEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    registerTestProvider({ id: PA, models: [{ id: "c7-model-a", pricing: { inputUSD: 0.1 } }] })
    registerTestProvider({ id: PB, models: [{ id: MB, pricing: { inputUSD: 0.1 } }] })
  })
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  it("the run-mode providerId is the session provider (no scope)", async () => {
    const a = buildPluginHost({
      capabilities: ["llm:complete"],
      runMode: () => ({ mode: "repl", interactive: true, providerId: PA }),
      llmSide: noSend,
    })
    expect((await a.llm?.request?.(req))?.reason).toBe("other-provider")
    const ctrl = new AbortController()
    ctrl.abort()
    const b = buildPluginHost({
      capabilities: ["llm:complete"],
      runMode: () => ({ mode: "repl", interactive: true, providerId: PB }),
      shutdownSignal: ctrl.signal,
      llmSide: noSend,
    })
    // Same provider passes the M6 gate; the aborted shutdown signal stops it before auth.
    expect((await b.llm?.request?.(req))?.reason).toBe("aborted")
  })

  it("the session scope target wins over the run-mode fact", async () => {
    const host = buildPluginHost({
      capabilities: ["llm:complete"],
      runMode: () => ({ mode: "repl", interactive: true, providerId: PB }),
      llmSide: noSend,
    })
    const scoped = {
      sid: SID_A,
      queryTarget: () => ({ providerId: PA }),
    } as unknown as SessionScope
    const r = await runInSessionScope(scoped, () => host.llm?.request?.(req))
    expect(r?.reason).toBe("other-provider")
  })

  it("llmSide deps win over the host options", async () => {
    const host = buildPluginHost({
      capabilities: ["llm:complete"],
      runMode: () => ({ mode: "repl", interactive: true, providerId: PB }),
      llmSide: { ...noSend, sessionProviderId: () => PA },
    })
    expect((await host.llm?.request?.(req))?.reason).toBe("other-provider")
  })

  it("the loader passes runMode and hostOptions.shutdownSignal to the plugin host", async () => {
    const pdir = join(tmp, "plugins", "c7-llm")
    mkdirSync(pdir, { recursive: true })
    const manifest = {
      id: "c7-llm",
      name: "c7-llm",
      version: "0.1.0",
      description: "test",
      capabilities: ["llm:complete"],
    }
    writeFileSync(join(pdir, "manifest.json"), JSON.stringify(splitFlatManifest(manifest)))
    const ctrl = new AbortController()
    let provider: string | undefined = PA
    const loader = await PluginLoader.load({
      userDir: tmp,
      logger: () => {},
      hostOptions: { sessionsDir: dir, shutdownSignal: ctrl.signal },
      runMode: () => ({
        mode: "repl",
        interactive: true,
        ...(provider ? { providerId: provider } : {}),
      }),
    })
    const host = loader.capabilityHostFor("c7-llm")
    expect((await host?.llm?.request?.(req))?.reason).toBe("other-provider")
    provider = PB
    ctrl.abort()
    // Read at each call: the provider is now PB, and the shutdown signal is aborted.
    expect((await host?.llm?.request?.(req))?.reason).toBe("aborted")
  })

  it("B5: the loader passes hostOptions.isOwnedSession to sessions:meta", async () => {
    const pdir = join(tmp, "plugins", "c7-meta")
    mkdirSync(pdir, { recursive: true })
    const manifest = {
      id: "c7-meta",
      name: "c7-meta",
      version: "0.1.0",
      description: "test",
      capabilities: ["sessions:meta"],
    }
    writeFileSync(join(pdir, "manifest.json"), JSON.stringify(splitFlatManifest(manifest)))
    touchSession(SID_B)
    touchSession(SID_C)
    const loader = await PluginLoader.load({
      userDir: tmp,
      logger: () => {},
      hostOptions: { sessionsDir: dir, isOwnedSession: (s) => s === SID_B },
    })
    const meta = loader.capabilityHostFor("c7-meta")?.sessionMeta
    await meta?.setTitle({ sid: SID_B, title: "Owned by the host", source: "ai" })
    expect(meta?.getTitle(SID_B).ai?.title).toBe("Owned by the host")
    expect(
      await rejectCode(
        Promise.resolve().then(() => meta?.setTitle({ sid: SID_C, title: "x", source: "ai" })),
      ),
    ).toBe("not-owned")
  })
})
