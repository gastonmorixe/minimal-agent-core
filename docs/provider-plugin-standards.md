# Provider Plugin Standards

How to write an LLM provider plugin for minimal-agent. One page. Use Wafer as
the exemplar.

## Architecture

A provider plugin adds a model provider (OpenAI, Anthropic, Wafer, OpenRouter,
OpenCode, …) to the agent's list of callable backends. It registers on the
shared model registry and exposes a `ProviderAdapter` that translates a
canonical request into the provider's wire format.

Every provider plugin sits in `plugins/llm-<name>/` and exports a standard
surface: `adapter.ts`, `auth.ts`, `capabilities.ts`, `models.ts`, `pricing.ts`,
`session-info.ts`, `wire-constants.ts`, `index.ts`.

## Generic endpoint (no plugin needed)

To point at an arbitrary OpenAI-compatible endpoint without writing a plugin at
all, use the `generic-endpoint` provider plus a registered surface codec. See
[`2026-07-09-generic-endpoint-and-surface-codecs.md`](2026-07-09-generic-endpoint-and-surface-codecs.md).
A provider plugin exposes a surface generically by registering a `SurfaceCodec`
in `register(ctx)` via `ctx.surfaceCodecs?.register(...)`.

## Two reuse patterns

### Pattern 1: OpenAI-compatible gateway (Wafer, OpenRouter)

Most third-party providers speak OpenAI Chat Completions. You **reuse** the
OpenAI wire layer wholesale instead of reimplementing it.

```
llm-wafer/
├── adapter.ts        // imports buildOpenAIChatBody + translateOpenAIChatStream
├── auth.ts           // Bearer API key
├── capabilities.ts   // static capability snapshots per model
├── models.ts         // registerModel() for each model in the catalog
├── pricing.ts        // per-model input/output token pricing
├── session-info.ts   // /v1/models + token-usage-accumulation hooks
├── wire-constants.ts // base URL, endpoints, user agent
├── index.ts          // re-exports public surface
└── wafer.test.ts     // end-to-end adapter tests
```

Key imports from the shared OpenAI plugin (`../minimal-agent-plugins/ma-llm-openai-plugin/index.ts`):

```typescript
import {
  buildOpenAIChatBody,          // canonical request → wire body
  translateOpenAIChatStream,    // SSE chunks → canonical events
  buildOpenAIHeaders,           // request headers
  validateOpenAIRequest,        // pre-flight validation
} from "../llm-openai/index.ts"
```

The adapter becomes ~50 lines: build body → set endpoint → POST → translate
stream.

### Pattern 2: Custom wire format (Anthropic)

Providers with a non-OpenAI wire format need their own `adapter.ts` wire logic.
Anthropic is the canonical example — it has its own message format, streaming
protocol, and validation.

## Template: starting a new provider

Copy `ma-llm-wafer-plugin/` (in the sibling `../minimal-agent-plugins/` repo) as
a starting point if your provider speaks OpenAI Chat Completions. Copy
`ma-llm-anthropic-plugin/` if it doesn't.

Files you must touch:

| File | What to do |
|---|---|
| `wire-constants.ts` | Set base URL, endpoints, user agent |
| `adapter.ts` | Wire the `ProviderAdapter` struct: `.adapter{run,validate}` |
| `auth.ts` | Implement `ProviderAuthStrategy` (almost always Bearer key) |
| `capabilities.ts` | One `CAPS_<MODEL>` constant per model |
| `models.ts` | `registerModel()` for each model, tagged with surface + capabilities |
| `pricing.ts` | Per-model token pricing (input/output per 1M tokens) |
| `session-info.ts` | `GET /v1/models` → model list; per-call usage accumulation |
| `index.ts` | Re-export the public surface |
| `<name>.test.ts` | E2E adapter test (canonical request → wire → canonical events) |

## Error tagging

Every adapter must tag upstream errors with the provider name so diagnostics
clearly identify the failing backend.

```typescript
// adapter.ts, inside validate/run
import { classifyUpstreamError } from "@minimal-agent/plugin-api/llm/errors"

// Wrap upstream HTTP errors
throw classifyUpstreamError("wafer", response.status, body)
```

The error tag appears in the TUI as `[wafer]` and in log lines.

## Stream usage

All adapters use the shared SSE parser:

```typescript
import { parseSse } from "@minimal-agent/plugin-api/utils/sse-parser"

async function* run(ctx: RunContext, req: CanonicalRequest): AsyncGenerator<CanonicalEvent> {
  const response = await ctx.network.post(CHAT_COMPLETIONS_URL, {
    headers: buildOpenAIHeaders(ctx),
    body: buildOpenAIChatBody(req),
    stream: true,
  })
  for await (const event of parseSse(response.body)) {
    yield* translateOpenAIChatStream(event)
  }
}
```

`parseSse` handles `data:` lines, multi-line payloads, and `[DONE]` sentinels.
Your translator function converts provider-specific chunks to canonical events
(`content_block_delta`, `usage`, `stop`, etc.).

## SDK seam usage

The plugin imports from two packages:

1. **`@minimal-agent/plugin-api`** — stable, public types. Always import from
   here for `ProviderPlugin`, `CanonicalEvent`, `ProviderAuth`, `RunContext`,
   `isEvent`, `NetworkClient`, SSE utilities.

2. **`../../src/llm/*`** — internal core types. Only import `ProviderAdapter`,
   `SurfaceId`, `ModelEntry`, `registerProvider`, `registerModel`,
   `ModelRegistry` from here. These are the stable-to-import core types; verify
   against the current architecture baseline (`scripts/check-architecture.ts`)
   before importing anything else from `src/`.

**Known gap (src/ import):** Provider plugins currently import from
`../../src/llm/model-registry.ts` and `../../src/llm/provider.ts` to register
models and type the adapter struct. These are not yet in `@minimal-agent/plugin-api`.
When they move into the API package, provider plugins will drop all `src/`
imports. Tracked at `docs/2026-06-19T230000Z-skill-declared-tools.md`
("Deferred" limitations table).

## Boot sequence

Provider plugins register during the `setup()` phase of `PluginLoader.load()`.
They do NOT use skill-declared tools, `PromptFragmentContext`, or
`registerDynamicTools`. The `getPromptBlockAsync()` → `getExtraTools()` boot
race fix documented in the skill-declared-tools spec does not affect provider
registration order or timing. Provider plugins can safely ignore it.

## Tests

Every provider must have:

- **E2E adapter test** (`<name>.test.ts`): canonical request → adapter → canonical
  events. Uses a mock network client so no real API calls.
- **Auth test** (`auth.test.ts`): key resolution, credential building.
- **Model registration test**: `registerModel()` produces the expected surface +
  capabilities.
- **Pricing test**: token cost calculation for known input/output pairs.

Run: `bun test plugins/llm-<name>/<name>.test.ts`.
