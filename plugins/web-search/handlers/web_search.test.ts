/**
 * End-to-end tests for the WebSearch tool handler.
 *
 * Strategy: write a tiny `~/.minimal-agent/config.jsonc` to a tmp dir,
 * point `MINIMAL_AGENT_CONFIG` at it, inject a stub `fetch` for Brave via
 * the config block (the registry passes the block straight to the
 * factory). The handler then exercises the full pipeline: validate,
 * load config, build chain, run, format, then return TUIResult.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"

import handler from "./web_search.ts"

let tmpDir: string
let prevConfigEnv: string | undefined
let prevApiKey: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ws-handler-"))
  prevConfigEnv = process.env.MINIMAL_AGENT_CONFIG
  prevApiKey = process.env.BRAVE_API_KEY
})

afterEach(() => {
  if (prevConfigEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
  else process.env.MINIMAL_AGENT_CONFIG = prevConfigEnv
  if (prevApiKey === undefined) delete process.env.BRAVE_API_KEY
  else process.env.BRAVE_API_KEY = prevApiKey
  rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Write a minimal config that wires Brave with an inline fetch shim. Inline
 * because the test fetch can't survive a JSON round-trip — we set the key
 * via env and the fetch via a runtime monkey-patch on the registry.
 *
 * Simplest approach: stub global fetch.
 */
function writeConfig(extra: Record<string, unknown> = {}) {
  const cfgPath = join(tmpDir, "config.jsonc")
  writeFileSync(
    cfgPath,
    JSON.stringify({
      plugins: {
        "web-search": {
          providers: ["brave"],
          brave: { apiKey: "test-key", ...extra },
        },
      },
    }),
  )
  process.env.MINIMAL_AGENT_CONFIG = cfgPath
}

function makeCtx(input: Record<string, unknown>): TUIContext {
  const noop = (_chunk: unknown) => true
  const fakeStream = { write: noop } as unknown as NodeJS.WriteStream
  const noopLog = () => {}
  return {
    trigger: { type: "tool", name: "WebSearch", input, tool_use_id: "toolu_test" },
    packageDir: join(import.meta.dirname ?? __dirname, ".."),
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    abort: new AbortController().signal,
    stdout: fakeStream,
    stdin: process.stdin,
    stderr: fakeStream,
    log: {
      emergency: noopLog,
      alert: noopLog,
      critical: noopLog,
      error: noopLog,
      warn: noopLog,
      notice: noopLog,
      info: noopLog,
      debug: noopLog,
    },
  }
}

function patchFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    return Promise.resolve(impl(String(url), init ?? {}))
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const fakeBraveResp = {
  query: { original: "rust async runtime", altered: "rust async runtime" },
  web: {
    results: [
      {
        title: "Tokio",
        url: "https://tokio.rs/",
        description: "Async runtime for Rust.",
        age: "3 days ago",
        meta_url: { hostname: "tokio.rs" },
      },
    ],
  },
}

describe("WebSearch handler — input validation", () => {
  test("rejects missing query", async () => {
    writeConfig()
    const r = await handler(makeCtx({}))
    expect(r.kind).toBe("tool_result")
    expect((r as Extract<TUIResult, { kind: "tool_result" }>).is_error).toBe(true)
    expect((r as Extract<TUIResult, { kind: "tool_result" }>).content).toMatch(/query.*required/)
  })

  test("rejects unknown type", async () => {
    writeConfig()
    const r = await handler(makeCtx({ query: "x", type: "videos" }))
    expect((r as Extract<TUIResult, { kind: "tool_result" }>).is_error).toBe(true)
    expect((r as Extract<TUIResult, { kind: "tool_result" }>).content).toMatch(/type.*web, news/)
  })

  test("rejects out-of-range count", async () => {
    writeConfig()
    const r = await handler(makeCtx({ query: "x", count: 999 }))
    expect((r as Extract<TUIResult, { kind: "tool_result" }>).is_error).toBe(true)
    expect((r as Extract<TUIResult, { kind: "tool_result" }>).content).toMatch(/count.*1.*20/)
  })

  test("rejects unknown format", async () => {
    writeConfig()
    const r = await handler(makeCtx({ query: "x", format: "yaml" }))
    expect((r as Extract<TUIResult, { kind: "tool_result" }>).is_error).toBe(true)
  })
})

describe("WebSearch handler — happy path", () => {
  test("text format (default) — content is plain, display has ANSI", async () => {
    writeConfig()
    const restore = patchFetch(
      () =>
        new Response(JSON.stringify(fakeBraveResp), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    try {
      const r = (await handler(makeCtx({ query: "rust async runtime" }))) as Extract<
        TUIResult,
        { kind: "tool_result" }
      >
      expect(r.is_error).toBeUndefined()
      expect(r.content).toContain("[1] Tokio")
      expect(r.content).toContain("https://tokio.rs/")
      expect(r.content).not.toContain("\x1b[")
      expect(r.display).toBeDefined()
      expect(r.display).toContain("\x1b[")
      expect(r.display).toContain("Tokio")
    } finally {
      restore()
    }
  })

  test("json format — content is parseable JSON, display still ANSI", async () => {
    writeConfig()
    const restore = patchFetch(
      () =>
        new Response(JSON.stringify(fakeBraveResp), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    try {
      const r = (await handler(
        makeCtx({ query: "rust async runtime", format: "json" }),
      )) as Extract<TUIResult, { kind: "tool_result" }>
      expect(r.is_error).toBeUndefined()
      const j = JSON.parse(r.content)
      expect(j.provider).toBe("brave")
      expect(j.hits[0].title).toBe("Tokio")
      // Display surface is still text+ANSI
      expect(r.display).toContain("Tokio")
      expect(r.display).toContain("\x1b[")
    } finally {
      restore()
    }
  })

  test("uses news endpoint when type=news", async () => {
    writeConfig()
    let observedUrl = ""
    const restore = patchFetch((url) => {
      observedUrl = url
      return new Response(JSON.stringify({ results: [], query: { original: "x" } }), {
        status: 200,
      })
    })
    try {
      const r = (await handler(makeCtx({ query: "x", type: "news" }))) as Extract<
        TUIResult,
        { kind: "tool_result" }
      >
      expect(r.is_error).toBeUndefined()
      expect(observedUrl).toContain("/news/search?")
      expect(r.content).toContain("(no results)")
    } finally {
      restore()
    }
  })
})

describe("WebSearch handler — error path", () => {
  test("missing API key → all-failed with hint", async () => {
    // Config without inline apiKey, env without BRAVE_API_KEY.
    const cfgPath = join(tmpDir, "config.jsonc")
    writeFileSync(
      cfgPath,
      JSON.stringify({ plugins: { "web-search": { providers: ["brave"], brave: {} } } }),
    )
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
    delete process.env.BRAVE_API_KEY

    const r = (await handler(makeCtx({ query: "x" }))) as Extract<
      TUIResult,
      { kind: "tool_result" }
    >
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("brave: not configured")
    expect(r.content).toContain("BRAVE_API_KEY")
  })

  test("HTTP 500 from provider → all-failed", async () => {
    writeConfig()
    const restore = patchFetch(
      () => new Response("boom", { status: 500, statusText: "Server Error" }),
    )
    try {
      const r = (await handler(makeCtx({ query: "x" }))) as Extract<
        TUIResult,
        { kind: "tool_result" }
      >
      expect(r.is_error).toBe(true)
      expect(r.content).toMatch(/HTTP 500/)
    } finally {
      restore()
    }
  })

  test("unknown provider in config → all-failed with no-providers reason", async () => {
    const cfgPath = join(tmpDir, "config.jsonc")
    writeFileSync(
      cfgPath,
      JSON.stringify({ plugins: { "web-search": { providers: ["nonexistent"] } } }),
    )
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
    const r = (await handler(makeCtx({ query: "x" }))) as Extract<
      TUIResult,
      { kind: "tool_result" }
    >
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("no providers configured")
  })
})
