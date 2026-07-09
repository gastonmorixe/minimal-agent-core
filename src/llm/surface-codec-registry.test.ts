import { afterEach, describe, expect, it } from "bun:test"

import type { SurfaceCodec } from "@minimal-agent/plugin-api/llm/surface-codec"

import { defaultCapabilities } from "./capabilities.ts"
import {
  clearSurfaceCodecs,
  findSurfaceCodec,
  listSurfaceCodecs,
  registerSurfaceCodec,
} from "./surface-codec-registry.ts"

const RATE = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

function fakeCodec(surfaceId: string, displayName = surfaceId): SurfaceCodec {
  return {
    surfaceId,
    displayName,
    defaultPath: "/v1/chat/completions",
    defaultCapabilities: defaultCapabilities(),
    defaultPricing: RATE,
    validate: () => ({ ok: true, errors: [] }),
    buildRequest: ({ endpoint }) => ({ label: surfaceId, method: "POST", url: endpoint }),
    async *translateStream() {},
  }
}

describe("surface-codec-registry", () => {
  afterEach(() => clearSurfaceCodecs())

  it("registers and finds a codec by surfaceId", () => {
    const codec = fakeCodec("chat-surface")
    registerSurfaceCodec(codec)
    expect(findSurfaceCodec("chat-surface")).toBe(codec)
  })

  it("returns undefined for an unknown surfaceId", () => {
    expect(findSurfaceCodec("nope")).toBeUndefined()
  })

  it("lists codecs in registration order", () => {
    registerSurfaceCodec(fakeCodec("a"))
    registerSurfaceCodec(fakeCodec("b"))
    expect(listSurfaceCodecs().map((c) => c.surfaceId)).toEqual(["a", "b"])
  })

  it("last registration wins for the same surfaceId", () => {
    registerSurfaceCodec(fakeCodec("dup", "first"))
    registerSurfaceCodec(fakeCodec("dup", "second"))
    expect(findSurfaceCodec("dup")?.displayName).toBe("second")
    expect(listSurfaceCodecs()).toHaveLength(1)
  })

  it("clear empties the registry", () => {
    registerSurfaceCodec(fakeCodec("x"))
    clearSurfaceCodecs()
    expect(listSurfaceCodecs()).toEqual([])
  })
})
