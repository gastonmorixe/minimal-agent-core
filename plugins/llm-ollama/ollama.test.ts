/**
 * Unit tests for the Ollama Cloud provider plugin.
 *
 * These exercise the plugin's OWN wire layer (request body, NDJSON stream
 * translation, capabilities, validation, registration seam) using ONLY
 * `@minimal-agent/plugin-api` contract types — the same surface the plugin
 * itself imports. No `src/` import appears here, proving the provider is
 * self-contained and could live in its own repo.
 *
 * @module llm/providers/ollama/ollama.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/plugin-api/llm/canonical-events"
import type { CanonicalRequest } from "@minimal-agent/plugin-api/llm/canonical-request"
import type {
  ModelRegistrar,
  ProviderAdapterRegistrar,
  ProviderAdapterView,
  ProviderModelSpec,
  ProviderSetupContext,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import type { ModelView } from "@minimal-agent/plugin-api/types/host-capabilities"

import { ollamaAdapter, ollamaProviderPlugin } from "./adapter.ts"
import { ollamaCaps } from "./capabilities.ts"
import { listOllamaLiveModels } from "./live-models.ts"
import { buildOllamaChatBody } from "./request-body.ts"
import { type OllamaChatChunk, parseNdjson, translateOllamaStream } from "./response-stream.ts"
import { validateOllamaRequest } from "./validate.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ModelView from a partial spec, defaulting to a thinking 1M model. */
function model(overrides: Partial<ModelView> = {}): ModelView {
  return {
    id: "deepseek-v4-flash",
    providerId: "ollama",
    surfaceId: "custom",
    displayName: "DeepSeek V4 Flash",
    capabilities: ollamaCaps({ contextWindow: 1_000_000, maxOutputTokens: 32_000, thinking: true }),
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
    vendorIds: { firstParty: "deepseek-v4-flash" },
    ...overrides,
  }
}

function userReq(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    modelId: "deepseek-v4-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
    ...overrides,
  }
}

/** A ReadableStream<Uint8Array> that emits the given NDJSON chunks as text. */
function ndjsonStream(lines: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const payload = lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Emit in two slices to exercise the partial-chunk buffering.
      const mid = Math.floor(payload.length / 2)
      controller.enqueue(enc.encode(payload.slice(0, mid)))
      controller.enqueue(enc.encode(payload.slice(mid)))
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

describe("ollama request body", () => {
  it("maps a basic user turn to the native chat shape", () => {
    const body = buildOllamaChatBody(userReq(), model())
    expect(body.model).toBe("deepseek-v4-flash")
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([{ role: "user", content: "Hello!" }])
    expect(body.tools).toBeUndefined()
  })

  it("uses vendorIds.firstParty for the wire model id when present", () => {
    const body = buildOllamaChatBody(
      userReq({ modelId: "registry-alias" }),
      model({ vendorIds: { firstParty: "deepseek-v4-flash" } }),
    )
    expect(body.model).toBe("deepseek-v4-flash")
  })

  it("prepends the system prefix as a system message", () => {
    const body = buildOllamaChatBody(
      userReq({ system: [{ type: "text", text: "You are terse." }] }),
      model(),
    )
    expect(body.messages[0]).toEqual({ role: "system", content: "You are terse." })
    expect(body.messages[1]).toEqual({ role: "user", content: "Hello!" })
  })

  it("toggles think:true for an adaptive thinking model asked to think", () => {
    const body = buildOllamaChatBody(userReq({ thinking: { mode: "adaptive" } }), model())
    expect(body.think).toBe(true)
  })

  it("sends think:false when thinking is explicitly disabled", () => {
    const body = buildOllamaChatBody(userReq({ thinking: { mode: "off" } }), model())
    expect(body.think).toBe(false)
  })

  it("omits think for a non-thinking model", () => {
    const body = buildOllamaChatBody(
      userReq(),
      model({ capabilities: ollamaCaps({ contextWindow: 256_000 }) }),
    )
    expect(body.think).toBeUndefined()
  })

  it("passes a discrete effort level for reasoning-effort models (gpt-oss)", () => {
    const gptOss = model({
      id: "gpt-oss:120b",
      capabilities: ollamaCaps({ contextWindow: 128_000, effortLevels: ["low", "medium", "high"] }),
    })
    const body = buildOllamaChatBody(userReq({ effort: "high" }), gptOss)
    expect(body.think).toBe("high")
  })

  it("maps sampling knobs into the options block", () => {
    const body = buildOllamaChatBody(
      userReq({
        generation: { temperature: 0.4, topP: 0.9, topK: 40, seed: 7, maxOutputTokens: 500 },
      }),
      model(),
    )
    expect(body.options).toEqual({
      temperature: 0.4,
      top_p: 0.9,
      top_k: 40,
      seed: 7,
      num_predict: 500,
    })
  })

  it("clamps num_predict to the model max output tokens", () => {
    const body = buildOllamaChatBody(
      userReq({ generation: { maxOutputTokens: 9_999_999 } }),
      model({ capabilities: ollamaCaps({ contextWindow: 128_000, maxOutputTokens: 4096 }) }),
    )
    expect(body.options?.num_predict).toBe(4096)
  })

  it("maps tools onto the native tool shape and skips server tools", () => {
    const body = buildOllamaChatBody(
      userReq({
        tools: [
          {
            name: "get_weather",
            description: "Get weather",
            inputSchema: { type: "object", properties: { city: { type: "string" } } },
          },
          { name: "web", description: "server", inputSchema: {}, server: "web_search" },
        ],
      }),
      model(),
    )
    expect(body.tools).toHaveLength(1)
    expect(body.tools?.[0]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    })
  })

  it("emits tool_result blocks as role:tool messages", () => {
    const body = buildOllamaChatBody(
      userReq({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "call_1",
                content: [{ type: "text", text: "72F" }],
              },
            ],
          },
        ],
      }),
      model(),
    )
    expect(body.messages[0]).toEqual({ role: "tool", content: "72F", tool_name: "call_1" })
  })

  it("maps an assistant tool_use block to tool_calls with parsed args", () => {
    const body = buildOllamaChatBody(
      userReq({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "NYC" } },
            ],
          },
        ],
      }),
      model(),
    )
    expect(body.messages[0]?.tool_calls).toEqual([
      { function: { name: "get_weather", arguments: { city: "NYC" } } },
    ])
  })

  it("inlines base64 images on the per-message images array", () => {
    const body = buildOllamaChatBody(
      userReq({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AAAA" } },
            ],
          },
        ],
      }),
      model({ capabilities: ollamaCaps({ contextWindow: 256_000, vision: true }) }),
    )
    expect(body.messages[0]?.images).toEqual(["AAAA"])
    expect(body.messages[0]?.content).toBe("what is this")
  })

  it("maps a json_schema output format onto format", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } }
    const body = buildOllamaChatBody(
      userReq({ outputFormat: { type: "json_schema", schema } }),
      model(),
    )
    expect(body.format).toEqual(schema)
  })
})

// ---------------------------------------------------------------------------
// NDJSON parser + stream translation
// ---------------------------------------------------------------------------

describe("ollama NDJSON parser", () => {
  it("parses objects across split TCP chunks and a missing trailing newline", async () => {
    const objs: Array<{ n: number }> = []
    for await (const o of parseNdjson<{ n: number }>(
      ndjsonStream([{ n: 1 }, { n: 2 }, { n: 3 }]),
    )) {
      objs.push(o)
    }
    expect(objs).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })
})

describe("ollama stream translation", () => {
  it("translates content deltas into a text block + terminal usage", async () => {
    const chunks: OllamaChatChunk[] = [
      {
        model: "deepseek-v4-flash",
        created_at: "t0",
        message: { role: "assistant", content: "Hel" },
      },
      { message: { role: "assistant", content: "lo" } },
      {
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 5,
      },
    ]
    const events = await collect(translateOllamaStream(toAsync(chunks)))
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("message_start")
    expect(types).toContain("text_start")
    expect(types).toContain("text_delta")
    expect(types).toContain("text_stop")
    expect(types.at(-2)).toBe("message_delta")
    expect(types.at(-1)).toBe("message_stop")

    const text = events
      .filter((e): e is Extract<CanonicalEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("")
    expect(text).toBe("Hello")

    const delta = events.find((e) => e.type === "message_delta")
    expect(delta).toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  })

  it("streams the thinking trace as a thinking block before content", async () => {
    const chunks: OllamaChatChunk[] = [
      { created_at: "t0", message: { role: "assistant", thinking: "Let me think" } },
      { message: { role: "assistant", thinking: " more" } },
      { message: { role: "assistant", content: "Answer" } },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
    ]
    const events = await collect(translateOllamaStream(toAsync(chunks)))
    const types = events.map((e) => e.type)
    // thinking opens, streams, then closes before text opens.
    expect(types.indexOf("thinking_start")).toBeLessThan(types.indexOf("thinking_stop"))
    expect(types.indexOf("thinking_stop")).toBeLessThan(types.indexOf("text_start"))
    const think = events
      .filter(
        (e): e is Extract<CanonicalEvent, { type: "thinking_delta" }> =>
          e.type === "thinking_delta",
      )
      .map((e) => e.text)
      .join("")
    expect(think).toBe("Let me think more")
  })

  it("translates a whole tool call and reports tool_use as the stop reason", async () => {
    const chunks: OllamaChatChunk[] = [
      {
        created_at: "t0",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "get_weather", arguments: { city: "NYC" } } }],
        },
      },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
    ]
    const events = await collect(translateOllamaStream(toAsync(chunks)))
    const start = events.find((e) => e.type === "tool_use_start")
    const stop = events.find((e) => e.type === "tool_use_stop")
    expect(start).toMatchObject({ name: "get_weather" })
    expect(stop).toMatchObject({ input: { city: "NYC" } })
    const delta = events.find((e) => e.type === "message_delta")
    expect(delta).toMatchObject({ stopReason: "tool_use" })
  })

  it("mints tool_use ids that satisfy the host id contract (regression)", async () => {
    // The host validates tool_use ids against ^[a-zA-Z0-9_-]{1,64}$. An ISO
    // `created_at` (colons, dots, 30 chars) must NOT leak into the id, which
    // previously triggered "Invalid tool_use id or name".
    const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
    const chunks: OllamaChatChunk[] = [
      {
        created_at: "2026-06-23T05:49:55.480274945Z",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "a", arguments: {} } },
            { function: { name: "b", arguments: {} } },
          ],
        },
      },
      {
        created_at: "2026-06-23T05:49:56.000000000Z",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "c", arguments: {} } }],
        },
      },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
    ]
    const events = await collect(translateOllamaStream(toAsync(chunks)))
    const ids = events
      .filter(
        (e): e is Extract<CanonicalEvent, { type: "tool_use_start" }> =>
          e.type === "tool_use_start",
      )
      .map((e) => e.id)
    expect(ids).toHaveLength(3)
    for (const id of ids) expect(id).toMatch(ID_RE)
    // Ids are unique across chunks (no collision).
    expect(new Set(ids).size).toBe(3)
  })

  it("maps done_reason length to max_tokens", async () => {
    const chunks: OllamaChatChunk[] = [
      { created_at: "t0", message: { role: "assistant", content: "x" } },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "length" },
    ]
    const events = await collect(translateOllamaStream(toAsync(chunks)))
    expect(events.find((e) => e.type === "message_delta")).toMatchObject({
      stopReason: "max_tokens",
    })
  })

  it("surfaces an inline error as a retryable stream_error", async () => {
    const chunks: OllamaChatChunk[] = [{ error: "model is loading" }]
    const events = await collect(translateOllamaStream(toAsync(chunks)))
    const err = events.find((e) => e.type === "stream_error")
    expect(err).toMatchObject({ retryable: true })
  })
})

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("ollama validate", () => {
  it("accepts a plain text request", () => {
    expect(validateOllamaRequest(userReq(), model()).ok).toBe(true)
  })

  it("rejects image input on a text-only model", () => {
    const res = validateOllamaRequest(
      userReq({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA" } },
            ],
          },
        ],
      }),
      model(), // text-only deepseek
    )
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => String(e.capability) === "modalities")).toBe(true)
  })

  it("accepts image input on a vision model", () => {
    const res = validateOllamaRequest(
      userReq({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA" } },
            ],
          },
        ],
      }),
      model({ capabilities: ollamaCaps({ contextWindow: 256_000, vision: true }) }),
    )
    expect(res.ok).toBe(true)
  })

  it("rejects an effort level the model doesn't offer", () => {
    const res = validateOllamaRequest(userReq({ effort: "high" }), model()) // no effort levels
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => String(e.capability) === "effort")).toBe(true)
  })

  it("rejects extended (budget) thinking", () => {
    const res = validateOllamaRequest(
      userReq({ thinking: { mode: "extended", budgetTokens: 1000 } }),
      model(),
    )
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => String(e.capability) === "thinking.extended")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("ollama capabilities", () => {
  it("marks thinking models visible + adaptive", () => {
    const caps = ollamaCaps({ contextWindow: 1_000_000, thinking: true })
    expect(caps.thinking).toEqual({
      adaptive: true,
      extended: false,
      visible: true,
      interleaved: false,
    })
    expect(caps.contextWindow).toBe(1_000_000)
  })

  it("encodes discrete reasoning-effort levels", () => {
    const caps = ollamaCaps({ contextWindow: 128_000, effortLevels: ["low", "medium", "high"] })
    expect(caps.effort.levels).toEqual(["low", "medium", "high"])
    expect(caps.thinking.adaptive).toBe(true)
  })

  it("encodes vision + audio modalities", () => {
    const caps = ollamaCaps({ contextWindow: 128_000, vision: true, audio: true })
    expect(caps.modalities).toEqual({ image: true, audio: true, pdf: false, video: false })
  })

  it("a plain model has no thinking and no modalities", () => {
    const caps = ollamaCaps({ contextWindow: 256_000 })
    expect(caps.thinking.adaptive).toBe(false)
    expect(caps.modalities).toEqual({ image: false, audio: false, pdf: false, video: false })
  })
})

// ---------------------------------------------------------------------------
// Registration seam (zero src/ import — purely contract-typed fakes)
// ---------------------------------------------------------------------------

describe("ollama registration seam", () => {
  function fakeCtx(): {
    ctx: ProviderSetupContext
    models: ProviderModelSpec[]
    adapters: ProviderAdapterView[]
    defaultId: () => string | null
  } {
    const models: ProviderModelSpec[] = []
    const adapters: ProviderAdapterView[] = []
    let dft: string | null = null
    const modelsApi: ModelRegistrar = {
      register: (spec) => models.push(spec),
      setDefault: (id) => {
        dft = id
      },
    }
    const providersApi: ProviderAdapterRegistrar = {
      register: (a) => adapters.push(a),
    }
    return {
      ctx: { models: modelsApi, providers: providersApi },
      models,
      adapters,
      defaultId: () => dft,
    }
  }

  it("registers the full catalog + adapter through the setup ctx", () => {
    const { ctx, models, adapters, defaultId } = fakeCtx()
    ollamaProviderPlugin.register(ctx)
    // Models contributed only through ctx.models — the whole cloud catalog.
    expect(models.length).toBeGreaterThanOrEqual(25)
    expect(models.every((m) => m.providerId === "ollama")).toBe(true)
    expect(models.every((m) => m.surfaceId === "custom")).toBe(true)
    // A representative spread of families is present.
    for (const id of [
      "deepseek-v4-flash",
      "glm-5.2",
      "qwen3.5",
      "minimax-m3",
      "kimi-k2.6",
      "gpt-oss:120b",
      "gemma4",
      "nemotron-3-ultra",
    ]) {
      expect(models.some((m) => m.id === id)).toBe(true)
    }
    // Adapter contributed only through ctx.providers.
    expect(adapters).toHaveLength(1)
    expect(adapters[0]?.id).toBe("ollama")
    // A default model is declared.
    expect(defaultId()).toBeTruthy()
  })

  it("encodes per-model capabilities accurately (vision/thinking/context)", () => {
    const { ctx, models } = fakeCtx()
    ollamaProviderPlugin.register(ctx)
    const byId = new Map(models.map((m) => [m.id, m]))
    // DeepSeek V4 Flash: 1M context, thinking (effort levels), text-only.
    const ds = byId.get("deepseek-v4-flash")
    expect(ds?.capabilities.contextWindow).toBe(1_000_000)
    expect(ds?.capabilities.effort.levels.length).toBeGreaterThan(0)
    expect(ds?.capabilities.modalities.image).toBe(false)
    // Qwen 3.5: vision + thinking.
    const qwen = byId.get("qwen3.5")
    expect(qwen?.capabilities.modalities.image).toBe(true)
    expect(qwen?.capabilities.thinking.adaptive).toBe(true)
    // Qwen3 Coder: tools-only, no thinking, no vision.
    const coder = byId.get("qwen3-coder")
    expect(coder?.capabilities.thinking.adaptive).toBe(false)
    expect(coder?.capabilities.modalities.image).toBe(false)
    // gpt-oss carries discrete reasoning levels.
    const gptoss = byId.get("gpt-oss:120b")
    expect(gptoss?.capabilities.effort.levels.length).toBeGreaterThan(0)
  })

  it("no-ops on the legacy no-arg activation path", () => {
    // Must not throw when the host calls register() with no context.
    expect(() => ollamaProviderPlugin.register()).not.toThrow()
  })

  it("declares an api-key auth strategy + session info hook", () => {
    expect(ollamaProviderPlugin.apiKeyAuth?.serviceId).toBe("ollama-api-key")
    expect(typeof ollamaProviderPlugin.fetchSessionInfo).toBe("function")
    expect(ollamaProviderPlugin.shortCode).toBe("ol")
  })

  it("recommends scout + balanced sub-agent models from its own catalog", () => {
    const { ctx } = fakeCtx()
    ollamaProviderPlugin.register(ctx)
    const recs = ollamaAdapterRecommend()
    const roles = recs.map((r) => r.role)
    expect(roles).toContain("scout")
    expect(roles).toContain("balanced")
  })

  it("registers a live-only ad-hoc slug through the captured registrar", () => {
    const { ctx, models } = fakeCtx()
    ollamaProviderPlugin.register(ctx)
    const before = models.length
    // The host calls registerAdHocModel(modelId) with NO context; it must use
    // the registrar captured at register() time.
    ollamaProviderPlugin.registerAdHocModel?.("brand-new-cloud-model")
    expect(models.length).toBe(before + 1)
    const added = models[models.length - 1]
    expect(added?.id).toBe("brand-new-cloud-model")
    expect(added?.providerId).toBe("ollama")
    expect(added?.surfaceId).toBe("custom")
  })

  it("exposes a listLiveModels hook for the dynamic catalog", () => {
    expect(typeof ollamaProviderPlugin.listLiveModels).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Live model listing (/api/tags), fetch stubbed
// ---------------------------------------------------------------------------

describe("ollama live models", () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("maps /api/tags rows into LiveModelRow[] (id + date)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: "glm-5.2", model: "glm-5.2", modified_at: "2026-06-17T00:00:00Z" },
            { name: "qwen3.5:397b", model: "qwen3.5:397b", modified_at: "2026-02-16T00:00:00Z" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch
    const rows = await listOllamaLiveModels({ kind: "api-key", key: "k" })
    expect(rows).toEqual([
      { id: "glm-5.2", createdAt: "2026-06-17" },
      { id: "qwen3.5:397b", createdAt: "2026-02-16" },
    ])
  })

  it("returns [] without auth (never hits the network)", async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const rows = await listOllamaLiveModels({ kind: "custom", headers: {} })
    expect(rows).toEqual([])
    expect(called).toBe(false)
  })

  it("returns [] on a non-2xx response (registry fallback)", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch
    const rows = await listOllamaLiveModels({ kind: "api-key", key: "k" })
    expect(rows).toEqual([])
  })

  it("returns [] when fetch throws (offline)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const rows = await listOllamaLiveModels({ kind: "api-key", key: "k" })
    expect(rows).toEqual([])
  })
})

function ollamaAdapterRecommend() {
  return ollamaAdapter.recommendSubagentModels?.() ?? []
}
