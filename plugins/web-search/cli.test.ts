/**
 * CLI tests. Pure parser tests + a few end-to-end runs against a stubbed
 * global fetch (the same trick the handler tests use).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { main, parseArgs } from "./cli.ts"

describe("parseArgs", () => {
  test("query as positional", () => {
    const f = parseArgs(["rust", "async", "runtime"])
    expect(f.query).toBe("rust async runtime")
    expect(f.type).toBe("web")
    expect(f.count).toBe(10)
    expect(f.format).toBe("text")
  })

  test("type/limit/offset flags", () => {
    const f = parseArgs(["x", "-t", "news", "-L", "5", "-O", "2"])
    expect(f.type).toBe("news")
    expect(f.count).toBe(5)
    expect(f.offset).toBe(2)
  })

  test("provider override + format", () => {
    const f = parseArgs(["x", "-p", "brave", "-f", "json"])
    expect(f.provider).toBe("brave")
    expect(f.format).toBe("json")
  })

  test("--no-color disables ansi", () => {
    const f = parseArgs(["x", "--no-color"])
    expect(f.color).toBe(false)
  })

  test("--help flag", () => {
    const f = parseArgs(["--help"])
    expect(f.help).toBe(true)
  })

  test("rejects bad type", () => {
    expect(() => parseArgs(["x", "-t", "videos"])).toThrow(/--type must be web\|news/)
  })

  test("rejects out-of-range limit", () => {
    expect(() => parseArgs(["x", "-L", "999"])).toThrow(/--limit must be 1\.\.20/)
  })

  test("rejects unknown flag", () => {
    expect(() => parseArgs(["x", "--bogus"])).toThrow(/unknown flag: --bogus/)
  })

  test("rejects flag without value", () => {
    expect(() => parseArgs(["-L"])).toThrow(/-L requires a value/)
  })
})

describe("main (e2e via stub fetch)", () => {
  let tmpDir: string
  let prevConfigEnv: string | undefined
  let prevApiKey: string | undefined
  let originalFetch: typeof fetch

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ws-cli-"))
    prevConfigEnv = process.env.MINIMAL_AGENT_CONFIG
    prevApiKey = process.env.BRAVE_API_KEY
    originalFetch = globalThis.fetch
    // Point at a config that wires Brave with an inline key.
    const cfgPath = join(tmpDir, "config.jsonc")
    writeFileSync(
      cfgPath,
      JSON.stringify({
        plugins: {
          "web-search": {
            providers: ["brave"],
            brave: { apiKey: "test-key" },
          },
        },
      }),
    )
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
  })

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevConfigEnv
    if (prevApiKey === undefined) delete process.env.BRAVE_API_KEY
    else process.env.BRAVE_API_KEY = prevApiKey
    globalThis.fetch = originalFetch
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function captureIo() {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      io: {
        stdout: {
          write: (chunk: string) => (out.push(chunk), true),
        } as unknown as NodeJS.WriteStream,
        stderr: {
          write: (chunk: string) => (err.push(chunk), true),
        } as unknown as NodeJS.WriteStream,
      },
    }
  }

  test("--help exits 0 and prints usage", async () => {
    const { out, io } = captureIo()
    const code = await main(["--help"], io)
    expect(code).toBe(0)
    expect(out.join("")).toContain("Usage:")
  })

  test("missing query exits 1", async () => {
    const { err, io } = captureIo()
    const code = await main([], io)
    expect(code).toBe(1)
    expect(err.join("")).toContain("missing <query>")
  })

  test("happy path text output", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          query: { original: "rust async" },
          web: {
            results: [
              {
                title: "Tokio",
                url: "https://tokio.rs/",
                description: "Async runtime.",
                age: "3 days ago",
                meta_url: { hostname: "tokio.rs" },
              },
            ],
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const { out, io } = captureIo()
    const code = await main(["rust", "async", "--no-color"], io)
    expect(code).toBe(0)
    const text = out.join("")
    expect(text).toContain("[1] Tokio")
    expect(text).toContain("https://tokio.rs/")
    expect(text).not.toContain("\x1b[")
  })

  test("--format json outputs parseable JSON", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          query: { original: "x" },
          web: { results: [{ title: "T", url: "https://t.io/" }] },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const { out, io } = captureIo()
    const code = await main(["x", "-f", "json"], io)
    expect(code).toBe(0)
    const j = JSON.parse(out.join(""))
    expect(j.hits[0].url).toBe("https://t.io/")
  })

  test("provider failure exits 2 with hint", async () => {
    // No API key in env, no inline apiKey → all-failed.
    const cfgPath = join(tmpDir, "config.jsonc")
    writeFileSync(
      cfgPath,
      JSON.stringify({ plugins: { "web-search": { providers: ["brave"], brave: {} } } }),
    )
    delete process.env.BRAVE_API_KEY
    const { err, io } = captureIo()
    const code = await main(["x", "--no-color"], io)
    expect(code).toBe(2)
    expect(err.join("")).toContain("BRAVE_API_KEY")
  })

  test("--provider override rewrites chain", async () => {
    const { err, io } = captureIo()
    const code = await main(["x", "-p", "nonexistent"], io)
    expect(code).toBe(2)
    expect(err.join("")).toContain("no providers configured")
  })
})
