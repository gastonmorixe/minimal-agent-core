/**
 * Ollama Cloud model registry entries.
 *
 * Ollama Cloud (ollama.com) serves frontier open-weight models over its native
 * `/api/chat` protocol. The catalog below is a representative snapshot of the
 * cloud library (https://ollama.com/search?c=cloud) with per-model
 * capabilities (thinking, tools, vision, context window) read from each model's
 * library page. The cloud API accepts the BARE model id (`deepseek-v4-flash`,
 * `qwen3.5`, `gpt-oss:120b`); the `:cloud` tag is only needed for the local
 * `ollama run` path, not the direct ollama.com API.
 *
 * Only a representative few are registered here; any other cloud slug still
 * works on the wire (the CLI doesn't gate on the registry) — it just registers
 * lazily via {@link registerOllamaAdHocModel} without a tuned capability table.
 *
 * All models register on the `custom` surface (Ollama's native NDJSON chat
 * protocol is its own wire format, not OpenAI- or Anthropic-shaped).
 *
 * @module llm/providers/ollama/models
 */

import type { Capabilities } from "@minimal-agent/plugin-api/llm/capabilities"
import type {
  ModelRegistrar,
  ProviderModelSpec,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import { makeCharRatioEstimator } from "@minimal-agent/plugin-api/llm/token-estimate"

import { ollamaCaps } from "./capabilities.ts"
import { PRICING_OLLAMA_GENERIC } from "./pricing.ts"

const M = 1_000_000
const K = 1_000

/**
 * Canonical reasoning-effort levels for Ollama "thinking" models. Ollama's
 * `think` field accepts a boolean or a level string; the agent commonly sends
 * `effort:"high"` (and `"max"` at the top tier), so a thinking model must
 * advertise these to pass capability validation. DeepSeek V4 exposes explicit
 * High/Max reasoning modes; the others accept the level strings and stream a
 * reasoning trace regardless of the exact value.
 */
const THINK_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const

/**
 * Token estimator for Ollama Cloud. The catalog spans many tokenizer families
 * (DeepSeek, Qwen, GLM, Llama-derived gpt-oss). ~3.8 chars/token is a
 * defensible cross-family average, matching the gateway-style estimate other
 * multi-vendor providers use.
 */
const estimateOllamaTokens = makeCharRatioEstimator(3.8)

/** One entry in the built-in Ollama Cloud catalog. */
interface OllamaCatalogEntry {
  id: string
  displayName: string
  capabilities: Capabilities
  tags: string[]
}

/**
 * Compact spec for one Ollama Cloud model, mirroring the ground-truth
 * `/api/show` fields (capabilities flags + context_length). `caps` is Ollama's
 * own capability list; {@link buildEntry} derives the canonical capability table
 * and tags from it so the two never drift. `cheap` flags the small/fast tiers
 * for sub-agent scout recommendation.
 */
interface OllamaModelSpec {
  id: string
  name: string
  /** Context window in tokens (from `/api/show` model_info `*.context_length`). */
  ctx: number
  /** Ollama capability flags. `thinking`/`tools`/`vision`/`audio` are honored. */
  caps: ReadonlyArray<"thinking" | "tools" | "vision" | "audio">
  cheap?: boolean
}

/**
 * The built-in Ollama Cloud catalog — a snapshot of the cloud library
 * (https://ollama.com/search?c=cloud) with per-model capabilities and context
 * windows read from each model's `/api/show`. This is the OFFLINE fallback +
 * the source of accurate capability gating; the live `/api/tags` listing
 * (`ProviderPlugin.listLiveModels`) supplements it with whatever the server
 * currently serves. Ids are the bare cloud slugs the API accepts.
 */
const CATALOG_SPECS: OllamaModelSpec[] = [
  // DeepSeek V4 / V3 — MoE reasoning, tools, text. V4 exposes High/Max modes.
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    ctx: 1 * M,
    caps: ["thinking", "tools"],
    cheap: true,
  },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", ctx: 512 * K, caps: ["thinking", "tools"] },
  { id: "deepseek-v3.2", name: "DeepSeek V3.2", ctx: 160 * K, caps: ["thinking", "tools"] },
  {
    id: "deepseek-v3.1:671b",
    name: "DeepSeek V3.1 671B",
    ctx: 160 * K,
    caps: ["thinking", "tools"],
  },
  // GLM (Z.ai) — thinking + tools, text.
  { id: "glm-5.2", name: "GLM-5.2", ctx: 1 * M, caps: ["thinking", "tools"] },
  { id: "glm-5.1", name: "GLM-5.1", ctx: 198 * K, caps: ["thinking", "tools"] },
  { id: "glm-5", name: "GLM-5", ctx: 198 * K, caps: ["thinking", "tools"] },
  { id: "glm-4.7", name: "GLM-4.7", ctx: 198 * K, caps: ["thinking", "tools"] },
  // Qwen — 3.5 is multimodal+thinking; coder variants are tools-only text.
  { id: "qwen3.5", name: "Qwen 3.5", ctx: 256 * K, caps: ["thinking", "tools", "vision"] },
  { id: "qwen3-coder", name: "Qwen3 Coder", ctx: 256 * K, caps: ["tools"] },
  { id: "qwen3-coder-next", name: "Qwen3 Coder Next", ctx: 256 * K, caps: ["tools"] },
  // MiniMax — M3 multimodal; M2.x text reasoning + tools.
  { id: "minimax-m3", name: "MiniMax M3", ctx: 512 * K, caps: ["thinking", "tools", "vision"] },
  { id: "minimax-m2.7", name: "MiniMax M2.7", ctx: 192 * K, caps: ["thinking", "tools"] },
  { id: "minimax-m2.5", name: "MiniMax M2.5", ctx: 192 * K, caps: ["thinking", "tools"] },
  { id: "minimax-m2.1", name: "MiniMax M2.1", ctx: 200 * K, caps: ["thinking", "tools"] },
  // Kimi (Moonshot) — native multimodal agentic: vision + thinking + tools.
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    ctx: 256 * K,
    caps: ["thinking", "tools", "vision"],
  },
  { id: "kimi-k2.6", name: "Kimi K2.6", ctx: 256 * K, caps: ["thinking", "tools", "vision"] },
  { id: "kimi-k2.5", name: "Kimi K2.5", ctx: 256 * K, caps: ["thinking", "tools", "vision"] },
  // gpt-oss (OpenAI open-weight) — discrete reasoning levels + tools.
  { id: "gpt-oss:120b", name: "gpt-oss 120B", ctx: 128 * K, caps: ["thinking", "tools"] },
  {
    id: "gpt-oss:20b",
    name: "gpt-oss 20B",
    ctx: 128 * K,
    caps: ["thinking", "tools"],
    cheap: true,
  },
  // Gemini / Gemma (Google) — multimodal.
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    ctx: 1 * M,
    caps: ["thinking", "tools", "vision"],
  },
  { id: "gemma4", name: "Gemma 4", ctx: 256 * K, caps: ["thinking", "tools", "vision"] },
  { id: "gemma3", name: "Gemma 3", ctx: 128 * K, caps: ["vision"], cheap: true },
  // NVIDIA Nemotron 3 — reasoning + tools, text.
  { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra", ctx: 256 * K, caps: ["thinking", "tools"] },
  { id: "nemotron-3-super", name: "Nemotron 3 Super", ctx: 256 * K, caps: ["thinking", "tools"] },
  {
    id: "nemotron-3-nano:30b",
    name: "Nemotron 3 Nano 30B",
    ctx: 256 * K,
    caps: ["thinking", "tools"],
    cheap: true,
  },
  // Mistral family — text/vision + tools.
  { id: "mistral-large-3", name: "Mistral Large 3", ctx: 256 * K, caps: ["tools", "vision"] },
  {
    id: "ministral-3:14b",
    name: "Ministral 3 14B",
    ctx: 256 * K,
    caps: ["tools", "vision"],
    cheap: true,
  },
  { id: "devstral-2", name: "Devstral 2", ctx: 256 * K, caps: ["tools"] },
  {
    id: "devstral-small-2:24b",
    name: "Devstral Small 2 24B",
    ctx: 256 * K,
    caps: ["tools", "vision"],
    cheap: true,
  },
  // Essential AI — dense code/STEM, tools.
  { id: "rnj-1:8b", name: "Rnj-1 8B", ctx: 32 * K, caps: ["tools"], cheap: true },
]

/** Derive a full catalog entry (canonical capabilities + tags) from a spec. */
function buildEntry(spec: OllamaModelSpec): OllamaCatalogEntry {
  const has = (c: string) => spec.caps.includes(c as never)
  const thinking = has("thinking")
  const capabilities = ollamaCaps({
    contextWindow: spec.ctx,
    maxOutputTokens: 32 * K,
    // Thinking models accept Ollama's `think` level strings; advertise the
    // canonical effort scale so a common `effort:"high"` request validates.
    ...(thinking ? { effortLevels: THINK_EFFORT } : {}),
    vision: has("vision"),
    audio: has("audio"),
  })
  const tags = ["ollama", "cloud"]
  if (thinking) tags.push("thinking")
  if (has("tools")) tags.push("tools")
  if (has("vision")) tags.push("vision")
  if (has("audio")) tags.push("audio")
  if (spec.cheap) tags.push("cheap")
  return {
    id: spec.id,
    displayName: `${spec.name} (Ollama Cloud)`,
    capabilities,
    tags,
  }
}

const CATALOG: OllamaCatalogEntry[] = CATALOG_SPECS.map(buildEntry)

/** Register a single Ollama Cloud model spec into the host registry via ctx. */
export function registerOllamaModelInto(models: ModelRegistrar, entry: OllamaCatalogEntry): string {
  const spec: ProviderModelSpec = {
    id: entry.id,
    providerId: "ollama",
    surfaceId: "custom",
    displayName: entry.displayName,
    tags: entry.tags,
    capabilities: entry.capabilities,
    pricing: PRICING_OLLAMA_GENERIC,
    estimateTokens: estimateOllamaTokens,
    vendorIds: { firstParty: entry.id },
  }
  models.register(spec)
  return entry.id
}

/**
 * Populate the host registry with the representative Ollama Cloud catalog
 * through the setup-context registrar (the `models:register` capability). The
 * first entry is declared the default model a no-model Ollama session boots
 * with. Returns the registered ids.
 */
export function registerOllamaModels(models: ModelRegistrar): string[] {
  const ids = CATALOG.map((entry) => registerOllamaModelInto(models, entry))
  if (ids[0]) models.setDefault(ids[0])
  return ids
}

/**
 * Register a one-off Ollama Cloud slug not in the built-in catalog with a
 * conservative default capability table (256K context, thinking + tools off).
 * Used by the host's ad-hoc model hook so an arbitrary cloud model still works.
 */
export function registerOllamaAdHocModelInto(models: ModelRegistrar, modelId: string): string {
  return registerOllamaModelInto(models, {
    id: modelId,
    displayName: `${modelId} (Ollama Cloud)`,
    capabilities: ollamaCaps({ contextWindow: 256 * K }),
    tags: ["ollama", "cloud"],
  })
}
