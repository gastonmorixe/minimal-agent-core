/**
 * HuggingFace live-catalog tests.
 *
 * Pure/offline: the epoch→ISO conversion, the `/v1/models` body mapper, and the
 * plugin-hook wiring. The network fetch itself (`listHuggingFaceLiveModels`) is
 * exercised against a stubbed global `fetch` so no real request is made.
 *
 * @module llm/providers/huggingface/live-models.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import {
  epochToIsoDate,
  fetchHuggingFaceModelCapabilities,
  listHuggingFaceLiveModels,
  mapHuggingFaceLiveModels,
} from "./live-models.ts"

describe("epochToIsoDate", () => {
  it("converts Unix epoch seconds to YYYY-MM-DD", () => {
    // 1776837885s = 2026-04-22 (from the HF docs sample)
    expect(epochToIsoDate(1776837885)).toBe("2026-04-22")
    expect(epochToIsoDate(0)).toBeUndefined() // <= 0 rejected
  })
  it("returns undefined for garbage / non-finite", () => {
    expect(epochToIsoDate(undefined)).toBeUndefined()
    expect(epochToIsoDate(Number.NaN)).toBeUndefined()
    expect(epochToIsoDate(-5)).toBeUndefined()
  })
})

describe("mapHuggingFaceLiveModels", () => {
  it("maps data[] rows to LiveModelRow (id + createdAt), skipping id-less rows", () => {
    const rows = mapHuggingFaceLiveModels({
      data: [
        { id: "deepseek-ai/DeepSeek-V4-Pro", created: 1776837885, owned_by: "deepseek-ai" },
        { id: "openai/gpt-oss-120b", owned_by: "openai" }, // no created → no createdAt
        { object: "model" }, // no id → skipped
      ],
    })
    expect(rows).toEqual([
      { id: "deepseek-ai/DeepSeek-V4-Pro", createdAt: "2026-04-22" },
      { id: "openai/gpt-oss-120b", createdAt: undefined },
    ])
  })
  it("returns [] for an empty/absent data array", () => {
    expect(mapHuggingFaceLiveModels({})).toEqual([])
    expect(mapHuggingFaceLiveModels({ data: [] })).toEqual([])
  })
})

describe("listHuggingFaceLiveModels (stubbed fetch)", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("returns mapped rows on a 200 and forwards the Bearer token when present", async () => {
    let sawAuth: string | null | undefined
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      sawAuth = h.get("authorization")
      return new Response(
        JSON.stringify({ data: [{ id: "openai/gpt-oss-120b", created: 1776837885 }] }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const rows = await listHuggingFaceLiveModels({ kind: "api-key", key: "hf_tok" })
    expect(rows).toEqual([{ id: "openai/gpt-oss-120b", createdAt: "2026-04-22" }])
    expect(sawAuth).toBe("Bearer hf_tok")
  })

  it("omits the auth header when unauthenticated (public list still works)", async () => {
    let sawAuth: string | null | undefined = "unset"
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      sawAuth = h.get("authorization")
      return new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen3-32B" }] }), { status: 200 })
    }) as unknown as typeof fetch
    const rows = await listHuggingFaceLiveModels({ kind: "custom", headers: {} })
    expect(rows).toEqual([{ id: "Qwen/Qwen3-32B", createdAt: undefined }])
    expect(sawAuth).toBeNull()
  })

  it("resolves [] on a non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch
    expect(await listHuggingFaceLiveModels({ kind: "api-key", key: "x" })).toEqual([])
  })

  it("resolves [] on a network throw", async () => {
    globalThis.fetch = (async () => {
      throw new Error("boom")
    }) as unknown as typeof fetch
    expect(await listHuggingFaceLiveModels({ kind: "api-key", key: "x" })).toEqual([])
  })

  it("resolves [] on a JSON parse failure", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>not json</html>", { status: 200 })) as unknown as typeof fetch
    expect(await listHuggingFaceLiveModels({ kind: "api-key", key: "x" })).toEqual([])
  })
})

describe("fetchHuggingFaceModelCapabilities (stubbed fetch)", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("derives caps for the matched model, stripping a :provider suffix", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "meta-llama/Llama-3.1-8B-Instruct",
              architecture: { input_modalities: ["text"] },
              providers: [
                {
                  provider: "novita",
                  status: "live",
                  context_length: 131072,
                  supports_tools: false,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const caps = await fetchHuggingFaceModelCapabilities(
      { kind: "api-key", key: "x" },
      "meta-llama/Llama-3.1-8B-Instruct:novita",
    )
    expect(caps?.tools.userDefined).toBe(false) // this is the Llama fix
    expect(caps?.contextWindow).toBe(131072)
  })

  it("returns null when the model is absent or the fetch fails", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch
    expect(
      await fetchHuggingFaceModelCapabilities({ kind: "api-key", key: "x" }, "nope/nope"),
    ).toBeNull()
    globalThis.fetch = (async () => new Response("err", { status: 503 })) as unknown as typeof fetch
    expect(
      await fetchHuggingFaceModelCapabilities({ kind: "api-key", key: "x" }, "any/any"),
    ).toBeNull()
  })
})
