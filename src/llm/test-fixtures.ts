/**
 * Synthetic in-test provider fixture (Wave A units A-3/A-5, PLAN.md).
 *
 * Core tests used to bootstrap REAL provider adapters from `plugins/` to get
 * a populated model/provider registry, which made `src/` test files import
 * the plugins tree (invariant I2 violations). This module is the
 * replacement seam: a provider-NEUTRAL fake `ProviderAdapter` +
 * `ProviderPlugin` + model catalog registered straight into the canonical
 * registries, so a core test can exercise the whole canonical transport
 * stack (run → adapter → SSE → bridge → middleware) without naming or
 * importing any real provider.
 *
 * Wire shape: the fake adapter POSTs to a per-provider sentinel URL
 * ({@link testProviderUrl}, under the reserved `.invalid` TLD) through the
 * `RunContext.networkClient` a test injects, and parses the response body as
 * SSE whose `data:` lines are JSON-encoded {@link CanonicalEvent}s. Tests
 * synthesize streams with {@link sseBodyFromEvents} and drive any scenario
 * (truncation, tool use, usage snapshots) in canonical terms.
 *
 * This file is core-internal and MUST stay provider-neutral (no provider
 * fingerprints in code — invariant I1). Tests that need a provider-flavored
 * id (e.g. to hit a legacy credential branch keyed by provider id) pass it
 * in as DATA; the tokens then live in the test file, never here.
 *
 * @module llm/test-fixtures
 */

import type { CanonicalEvent } from "./canonical-events.ts"
import {
  type CachingSupport,
  type Capabilities,
  defaultCapabilities,
  type EffortSupport,
  type ModalitySupport,
  type ThinkingSupport,
  type ToolSupport,
} from "./capabilities.ts"
import { type ModelEntry, registerModel, registerProvider } from "./model-registry.ts"
import type { MTokRate } from "./pricing.ts"
import type { ProviderAdapter, ValidationResult } from "./provider.ts"
import {
  type ApiKeyAuthProvider,
  type ProviderPlugin,
  registerProviderPlugin,
} from "./provider-plugin.ts"
import { parseSse } from "./streaming/sse-parser.ts"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Per-section partial capability overrides. Nested support records merge
 * field-by-field over the neutral defaults so a test can flip exactly one
 * knob (e.g. `caching.minPrefixTokens`) without restating the rest.
 */
export interface TestCapabilityOverrides
  extends Partial<Omit<Capabilities, "thinking" | "effort" | "caching" | "tools" | "modalities">> {
  thinking?: Partial<ThinkingSupport>
  effort?: Partial<EffortSupport>
  caching?: Partial<CachingSupport>
  tools?: Partial<ToolSupport>
  modalities?: Partial<ModalitySupport>
}

/** One synthetic model to register under the test provider. */
export interface TestModelSpec {
  /** Canonical model id (neutral, e.g. `test-model-1`). */
  id: string
  /** Optional aliases resolving to the same entry. */
  aliases?: string[]
  /** Capability overrides merged over the neutral defaults. */
  capabilities?: TestCapabilityOverrides
  /** Pricing overrides merged over a flat neutral rate. */
  pricing?: Partial<MTokRate>
  /** Optional grouping tags. */
  tags?: string[]
}

/** Options for {@link registerTestProvider}. */
export interface TestProviderOptions {
  /**
   * Provider id. Defaults to `test-prov`. A test MAY pass a real provider's
   * id when it pins core behavior keyed by provider id (the token then lives
   * in the test file, which owns its own I1 accounting — never here).
   */
  id?: string
  /** Human-friendly name for diagnostics. Defaults to `Test Provider`. */
  displayName?: string
  /** Compact UI tag (`ProviderPlugin.shortCode`). Defaults to `tp`. */
  shortCode?: string
  /** Models to register. Defaults to one neutral `test-model-1`. */
  models?: TestModelSpec[]
  /**
   * Version-token hook for dense labels. Defaults to parsing a trailing
   * `-<digits>` group (`test-model-1` → `"1"`).
   */
  modelVersionToken?: (modelId: string) => string | undefined
  /** Optional API-key auth strategy exposed through the provider plugin hook. */
  apiKeyAuth?: ApiKeyAuthProvider
}

/** What {@link registerTestProvider} hands back for direct assertions. */
export interface TestProviderHandle {
  adapter: ProviderAdapter
  plugin: ProviderPlugin
  models: ModelEntry[]
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

/**
 * The sentinel endpoint the fake adapter POSTs to. Uses the reserved
 * `.invalid` TLD so an escaped request can never reach a real host.
 */
export function testProviderUrl(providerId = "test-prov"): string {
  return `https://test-provider.invalid/${providerId}/v1/stream`
}

/**
 * Build an SSE `ReadableStream` whose `data:` lines are the given canonical
 * events, one per line — the body shape the fixture adapter parses.
 */
export function sseBodyFromEvents(events: readonly CanonicalEvent[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ev of events) c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n`))
      c.close()
    },
  })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of the network client the adapter drives. Kept
 * local (not imported from `src/network/`) so both a real `NetworkClient`
 * and a bare `{ request }` fake satisfy it.
 */
interface TestNetworkResponseLike {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
}

interface TestNetworkClientLike {
  request(input: {
    label: string
    method: "POST"
    url: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }): Promise<TestNetworkResponseLike>
}

function mergeCapabilities(over?: TestCapabilityOverrides): Capabilities {
  const base = defaultCapabilities()
  // Roomier neutral defaults than the lowest-common-denominator blank:
  // most transport/render tests assume a modern large-context model.
  base.contextWindow = 200_000
  base.maxOutputTokens = 8_192
  if (!over) return base
  const { thinking, effort, caching, tools, modalities, ...flat } = over
  const merged: Capabilities = { ...base, ...flat }
  if (thinking) merged.thinking = { ...base.thinking, ...thinking }
  if (effort) merged.effort = { ...base.effort, ...effort }
  if (caching) merged.caching = { ...base.caching, ...caching }
  if (tools) merged.tools = { ...base.tools, ...tools }
  if (modalities) merged.modalities = { ...base.modalities, ...modalities }
  return merged
}

const NEUTRAL_PRICING: MTokRate = {
  inputUSD: 1,
  outputUSD: 1,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

function defaultVersionToken(modelId: string): string | undefined {
  return /-(\d+)$/.exec(modelId)?.[1]
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * Register a synthetic provider (adapter + plugin + models) into the
 * canonical registries and return the pieces for direct assertions.
 *
 * The adapter resolves its credential from `RunContext.auth`
 * (`oauth.token` / `api-key.key` → `authorization: Bearer …`; `custom`
 * headers pass through), POSTs to {@link testProviderUrl}, and yields the
 * canonical events parsed from the SSE response. It REQUIRES an injected
 * `networkClient` — there is deliberately no real-network fallback.
 *
 * Registration is idempotent (`plugin.register()` can be re-invoked), and
 * tests that clear the registries between cases can call this again.
 */
export function registerTestProvider(opts: TestProviderOptions = {}): TestProviderHandle {
  const id = opts.id ?? "test-prov"
  const displayName = opts.displayName ?? "Test Provider"
  const specs: TestModelSpec[] = opts.models ?? [{ id: "test-model-1" }]

  const models: ModelEntry[] = specs.map((spec) => {
    const entry: ModelEntry = {
      id: spec.id,
      providerId: id,
      surfaceId: "custom",
      displayName: spec.id,
      capabilities: mergeCapabilities(spec.capabilities),
      pricing: { ...NEUTRAL_PRICING, ...spec.pricing },
    }
    if (spec.aliases) entry.aliases = spec.aliases
    if (spec.tags) entry.tags = spec.tags
    return entry
  })

  const adapter: ProviderAdapter = {
    id,
    displayName,
    surfaces: ["custom"],

    validate(): ValidationResult {
      return { ok: true, errors: [] }
    },

    async *run(req, _model, ctx) {
      const client = ctx.networkClient as TestNetworkClientLike | undefined
      if (!client) {
        throw new Error(
          `test provider "${id}": no networkClient injected — pass a fake client via RunContext/SendOptions`,
        )
      }
      const headers: Record<string, string> = { "content-type": "application/json" }
      const auth = ctx.auth
      if (auth.kind === "oauth") headers.authorization = `Bearer ${auth.token}`
      else if (auth.kind === "api-key") headers.authorization = `Bearer ${auth.key}`
      else Object.assign(headers, auth.headers)

      const response = await client.request({
        label: "test-provider.stream",
        method: "POST",
        url: testProviderUrl(id),
        headers,
        body: JSON.stringify({ model: req.modelId, stream: req.stream ?? true }),
        ...(req.signal ? { signal: req.signal } : {}),
      })
      if (!response.ok) {
        throw new Error(`test provider "${id}": HTTP ${response.status}: ${await response.text()}`)
      }
      if (!response.body) {
        throw new Error(`test provider "${id}": empty response body for stream`)
      }
      yield* parseSse<CanonicalEvent>(response.body)
    },
  }

  const register = (): void => {
    for (const entry of models) registerModel(entry)
    registerProvider(adapter)
  }

  const plugin: ProviderPlugin = {
    id,
    displayName,
    shortCode: opts.shortCode ?? "tp",
    register,
    modelVersionToken: opts.modelVersionToken ?? defaultVersionToken,
    ...(opts.apiKeyAuth ? { apiKeyAuth: opts.apiKeyAuth } : {}),
  }

  register()
  registerProviderPlugin(plugin)

  return { adapter, plugin, models }
}
