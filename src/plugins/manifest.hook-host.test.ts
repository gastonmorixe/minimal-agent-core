/**
 * Paste plugin v3, B4: a manifest hook accepts `host: boolean` (the opt-in
 * to `ctx.host`, the same rule as for events).
 */

import { describe, expect, it } from "bun:test"

import { parseManifest } from "./manifest.ts"

const base = {
  id: "hook-host",
  name: "hook-host",
  version: "0.1.0",
  description: "test",
  permissions: ["hooks:message.willSend"],
}
const withHook = (extra: Record<string, unknown>) => ({
  ...base,
  headless: {
    tools: [],
    hooks: [
      {
        id: "send",
        channel: "message.willSend",
        handler: { type: "module", path: "./h.ts" },
        ...extra,
      },
    ],
  },
})

describe("parseManifest / hook host opt-in", () => {
  it("accepts host: true and keeps it", () => {
    expect(parseManifest(withHook({ host: true }), "/x").hooks?.[0]?.host).toBe(true)
  })

  it("accepts host: false", () => {
    expect(parseManifest(withHook({ host: false }), "/x").hooks?.[0]?.host).toBe(false)
  })

  it("leaves host absent when the key is absent", () => {
    const hook: object = parseManifest(withHook({}), "/x").hooks?.[0] ?? {}
    expect("host" in hook).toBe(false)
  })

  it("rejects a non-boolean host", () => {
    expect(() => parseManifest(withHook({ host: "yes" }), "/x")).toThrow(/host must be a boolean/)
  })

  it("still rejects an unknown hook key", () => {
    expect(() => parseManifest(withHook({ hosts: true }), "/x")).toThrow(
      /unknown hook subscription key/,
    )
  })
})
