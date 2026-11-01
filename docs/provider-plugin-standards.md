# Provider Plugin Standards

How to write an LLM provider plugin for minimal-agent. One page. Use Wafer as
the exemplar.

## Architecture

A provider plugin adds a model provider (OpenAI, Anthropic, Wafer, OpenRouter,
OpenCode, …) to the agent's list of callable backends. It registers its models
on the shared model registry and exposes a `ProviderAdapter` that translates a
canonical request into the provider's wire format.

Provider plugins live in the sibling
[`minimal-agent-plugins`](https://github.com/gastonmorixe/minimal-agent-plugins)
repo, one folder per provider: `ma-llm-<name>-plugin/`. Core ships no provider.
At startup, `src/llm/provider-discovery.ts` scans each plugin root for a
`provider.json` descriptor (`id`, `entry`, `export`), imports the exported
`ProviderPlugin`, and calls its `register(ctx)`.

A provider plugin has a standard surface: `provider.json`, `adapter.ts`,
`auth.ts`, `capabilities.ts`, `models.ts`, `pricing.ts`, `session-info.ts`,
`wire-constants.ts`, `index.ts`.

## Generic endpoint (no plugin needed)

To point at an arbitrary OpenAI-compatible endpoint without writing a plugin at
all, use the `generic-endpoint` provider plus a registered surface codec. See
[`2026-07-09-generic-endpoint-and-surface-codecs.md`](2026-07-09-generic-endpoint-and-surface-codecs.md).
A provider plugin exposes a surface generically by registering a `SurfaceCodec`
in `register(ctx)` via `ctx.surfaceCodecs?.register(...)`.

## Two reuse patterns

### Pattern 1: OpenAI-compatible gateway (Wafer, OpenRouter)

Most third-party providers speak OpenAI Chat Completions. You **reuse** the
shared OpenAI Chat wire layer instead of reimplementing it.

```
ma-llm-wafer-plugin/
├── provider.json     // { id, entry, export } for provider discovery
├── adapter.ts        // uses buildOpenAIChatBody + translateOpenAIChatStream
├── auth.ts           // Bearer API key
├── capabilities.ts   // static capability snapshots per model
├── models.ts         // registers each model in the catalog
├── pricing.ts        // per-model input/output token pricing
├── session-info.ts   // /v1/models + token-usage accumulation hooks
├── wire-constants.ts // base URL, endpoints, user agent
├── index.ts          // re-exports the public surface
├── lib/              // contract files the plugin consumes (see below)
└── wafer.test.ts     // end-to-end adapter tests
```

The shared wire layer is part of the plugin contract,
`@minimal-agent/core/plugin-api/llm/openai-chat`. No plugin imports another
plugin. Today each plugin carries a copy of the contract files it uses in its
`lib/` folder (marked `// source: plugin-api/src/...`), so it imports them
locally:

```typescript
import {
  buildOpenAIChatBody,          // canonical request → wire body
  translateOpenAIChatStream,    // SSE chunks → canonical events
  buildOpenAIHeaders,           // request headers
  validateOpenAIRequest,        // pre-flight validation
} from "./lib/openai-chat.ts"
```

When the plugins depend on core directly, these copies are replaced by
imports from `@minimal-agent/core/plugin-api/*`.

The adapter is small: build the body, POST to the endpoint, translate the
stream.

### Pattern 2: Custom wire format (Anthropic)

Providers with a non-OpenAI wire format need their own wire logic in the
plugin. Anthropic is the canonical example. It has its own message format,
streaming protocol, and validation.

## Template: starting a new provider

Copy `ma-llm-wafer-plugin/` (in the sibling `../minimal-agent-plugins/` repo) as
a starting point if your provider speaks OpenAI Chat Completions. Copy
`ma-llm-anthropic-plugin/` if it doesn't.

Files you must touch:

| File | What to do |
|---|---|
| `provider.json` | Set `id`, `entry` (`./index.ts`), and `export` (the `ProviderPlugin` name) |
| `wire-constants.ts` | Set base URL, endpoints, user agent |
| `adapter.ts` | Implement the `ProviderAdapter` (`id`, `surfaces`, `validate`, `run`) and the `ProviderPlugin` |
| `auth.ts` | Implement the API-key auth strategy (almost always a Bearer key) |
| `capabilities.ts` | One `CAPS_<MODEL>` constant per model |
| `models.ts` | Register each model, tagged with surface + capabilities |
| `pricing.ts` | Per-model token pricing (input/output per 1M tokens) |
| `session-info.ts` | `GET /v1/models` → model list; per-call usage accumulation |
| `index.ts` | Re-export the public surface |
| `<name>.test.ts` | E2E adapter test (canonical request → wire → canonical events) |

## Registration

`register(ctx)` receives a `ProviderSetupContext`:

- `ctx.models`: registers the plugin's model catalog.
- `ctx.providers`: registers the adapter.
- `ctx.surfaceCodecs` (optional): registers a generic wire-surface codec.

A plugin reads no core registry directly. It writes through `ctx` and keeps
its own catalog data in `models.ts`.

## Error classification

An adapter turns a non-2xx response into an error that names the provider and
carries a class that core can act on. Use `classifyUpstreamError` from the
contract (`@minimal-agent/core/plugin-api/llm/errors`):

```typescript
const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })
const err = new Error(`Wafer API ${status}: ${body}`)
if (streamErrorType) err.streamErrorType = streamErrorType
throw err
```

Core decides whether to retry, recover, or stop from that class. The provider
name in the message shows in diagnostics and log lines.

## Stream usage

All adapters use the shared SSE parser (`parseSse`, from
`@minimal-agent/core/plugin-api/utils/sse-parser`) and the `NetworkClient`
that core passes on `RunContext`:

```typescript
async *run(req, model, ctx) {
  const response = await ctx.networkClient.request({
    method: "POST",
    url: CHAT_COMPLETIONS_URL,
    headers: buildOpenAIHeaders({ auth: ctx.auth }),
    body: JSON.stringify(buildOpenAIChatBody(req, model)),
    signal: req.signal,
  })
  yield* translateOpenAIChatStream(parseSse(response.body))
}
```

`parseSse` handles `data:` lines, multi-line payloads, and `[DONE]` sentinels.
Your translator converts provider-specific chunks to canonical events
(`text_delta`, `tool_use_*`, `message_delta`, `stream_error`, ...).

### Usage counters

`message_delta.usage` is a `CanonicalUsage`. Its three input counters are
disjoint:

- `inputTokens`: uncached input tokens only.
- `cacheReadTokens`: input tokens read from the prompt cache.
- `cacheCreationTokens`: input tokens written to the prompt cache.

All input of the request is `inputTokens + cacheReadTokens +
cacheCreationTokens`. The host uses this sum as the context-window `used`.
The cost calculator prices each counter at its own rate.

Map the provider counters as follows:

| Provider wire | `inputTokens` | `cacheReadTokens` |
|---|---|---|
| Anthropic `input_tokens` | `input_tokens` (it already excludes cache) | `cache_read_input_tokens` |
| OpenAI Chat `prompt_tokens` | `prompt_tokens - prompt_tokens_details.cached_tokens` | `cached_tokens` |
| OpenAI Responses `input_tokens` | `input_tokens - input_tokens_details.cached_tokens` | `cached_tokens` |

Do not copy an OpenAI-style total into `inputTokens`. If you do, the host
counts the cached tokens twice in `used` and charges them at the input rate.

## The contract boundary

A provider plugin imports only:

1. **The plugin contract**, `@minimal-agent/core/plugin-api/*`: `ProviderPlugin`,
   `ProviderSetupContext`, `CanonicalEvent`, `CanonicalRequest`, `RunContext`,
   `NetworkClient`, the error classes, the SSE parser, and the shared wire
   layers. Today these come from the plugin's `lib/` copies.
2. **Local structural types** for the few host types the contract does not
   carry yet (`ProviderAdapter`, `ModelEntry`, `SurfaceId`). Wafer keeps them
   in `lib/host-types.ts`.

A plugin never imports core `src/`. The I3 ratchet
(`src/architecture/architecture.plugin-decoupling.test.ts`) scans the sibling
plugins repo and fails on any `src/` import. Its baseline is empty.

## Tests

Every provider must have:

- **E2E adapter test** (`<name>.test.ts`): canonical request → adapter → canonical
  events. Uses a mock network client so no real API calls.
- **Auth test** (`auth.test.ts`): key resolution, credential building.
- **Model registration test**: registering the catalog produces the expected
  surface + capabilities.
- **Pricing test**: token cost calculation for known input/output pairs.

Run, from the plugins repo: `bun test ma-llm-<name>-plugin/`.
