/**
 * `PluginStream` engine choice: the codec scanner of the load with the core
 * grammar options, or the core `TagScanner` when the load has no codec.
 *
 * @module plugins/stream.test
 */

import { describe, expect, it } from "bun:test"

import { NO_SIDEBAND } from "../sideband/api.ts"
import type {
  SidebandApi,
  SidebandNode,
  StreamScanner,
  StreamScanOptions,
} from "../sideband/types.ts"

import type { PluginLoader } from "./loader.ts"
import { PluginStream } from "./stream.ts"

interface Dispatched {
  name: string
  attrs: Record<string, string>
  body: string
  self_closing: boolean
}

function fakeLoader(sideband: SidebandApi, calls: Dispatched[]): PluginLoader {
  return {
    sideband: () => sideband,
    hasInlineTag: (name: string) => name === "x",
    dispatch: async (t: Dispatched & { type: string }) => {
      calls.push({ name: t.name, attrs: t.attrs, body: t.body, self_closing: t.self_closing })
      return { kind: "rendered", ansi: `(${t.name}|${t.body})` }
    },
  } as unknown as PluginLoader
}

/** The v1 emit tag parts, built so the source has no tag literal. */
const LT = "<"
const NS = "ma::emit::"
const open = (name: string, attrs = ""): string => `${LT}${NS}${name}${attrs}>`
const close = (name: string): string => `${LT}/${NS}${name}>`
const empty = (name: string): string => `${LT}${NS}${name} />`

async function run(stream: PluginStream, chunks: string[]): Promise<void> {
  for (const c of chunks) {
    const p = stream.feed(c)
    if (p) await p
  }
  await stream.end()
}

describe("PluginStream engine", () => {
  it("no codec: the core TagScanner still parses inline emit tags", async () => {
    const calls: Dispatched[] = []
    let out = ""
    const s = new PluginStream((c) => (out += c), fakeLoader(NO_SIDEBAND, calls), "/")
    await run(s, [`a ${open("x", " k='v'")}b`, `ody${close("x")} ${empty("y")} c`])
    expect(calls).toEqual([{ name: "x", attrs: { k: "v" }, body: "body", self_closing: false }])
    expect(out).toBe(`a (x|body) ${empty("y")} c`)
  })

  it("codec: the stream asks the codec scanner for the core grammar and maps each node", async () => {
    const seen: (StreamScanOptions | undefined)[] = []
    const node: SidebandNode = {
      kind: "x",
      attrs: { k: "v" },
      body: "B",
      selfClosing: false,
      form: "v1",
      span: { start: 0, end: 0 },
    }
    const scanner = (opts?: StreamScanOptions): StreamScanner => {
      seen.push(opts)
      let text: (t: string) => void = () => {}
      let hit: (n: SidebandNode, raw: string) => void = () => {}
      return {
        write: (c) => (c === "TAG" ? hit(node, "RAW") : text(c)),
        end: () => {},
        onText: (cb) => (text = cb),
        onNode: (cb) => (hit = cb),
      }
    }
    const api = { ...NO_SIDEBAND, ready: true, scanner } as unknown as SidebandApi
    const calls: Dispatched[] = []
    let out = ""
    const s = new PluginStream((c) => (out += c), fakeLoader(api, calls), "/")
    await run(s, ["a ", "TAG", " b"])
    expect(seen).toEqual([{ codeAware: true, strictV1: true }])
    expect(calls).toEqual([{ name: "x", attrs: { k: "v" }, body: "B", self_closing: false }])
    expect(out).toBe("a (x|B) b")
  })
})
