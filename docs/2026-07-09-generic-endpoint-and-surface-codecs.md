# Generic endpoint provider + SurfaceCodec registry

Point minimal-agent at any OpenAI-compatible endpoint (LM Studio, vLLM, a
custom proxy) with CLI flags, no per-provider plugin directory required.

Author: Joyce (with Gaston, relayed via c757cad1). Date: 2026-07-09.

## The problem

Before this change, adding a backend meant a whole provider plugin: `models.ts`,
`capabilities.ts`, `pricing.ts`, `wire-constants.ts`, an adapter, and auth
wiring, just to change a URL. The first-party OpenAI plugin hardcodes
`https://api.openai.com` in `wire-constants.ts` and only ever varies its base
URL for ChatGPT OAuth. There was no path to say "talk OpenAI Chat Completions to
`http://localhost:1234/v1/chat/completions` with this key".

## The shape

Two pieces:

1. A **SurfaceCodec registry**. A codec is the reusable wire logic for one API
   surface (request build + stream translate + validation + defaults),
   independent of any concrete endpoint. Provider plugins opt in by registering
   codecs for surfaces they are willing to expose generically.
2. A **generic-endpoint provider**. One adapter, no built-in wire format. It
   reads the runtime endpoint + surface + auth, looks up the codec by surface
   id, and delegates. Any model id is accepted via `registerAdHocModel`.

Crucially, `--format` accepts any **registered** generic surface, not any
`adapter.surfaces` string. A surface is only generically callable when its
provider registers a codec for it. This keeps the boundary honest: a provider
decides what is safe to expose.

## SurfaceCodec contract

`@minimal-agent/plugin-api/llm/surface-codec`:

```ts
export interface SurfaceCodec {
  readonly surfaceId: string
  readonly displayName: string
  readonly defaultPath: string              // e.g. /v1/chat/completions
  readonly defaultCapabilities: Capabilities
  readonly defaultPricing: ModelRate
  readonly defaultTags?: ReadonlyArray<string>
  readonly estimateTokens?: TokenEstimator
  normalizeEndpoint?(endpoint: string, defaultPath: string): string
  validate(req, model): ProviderValidationResult
  buildRequest(input): NetworkRequestInput   // headers + serialized body + url
  translateStream(input): AsyncIterable<CanonicalEvent>
  classifyError?(status, body): Error & { streamErrorType?: string }
  onResponseHeaders?(headers: Headers): void
}
```

`buildRequest` returns a full `NetworkRequestInput` rather than separate
`buildHeaders` + `buildBody`, so a codec is not locked into "JSON POST + SSE".
The generic adapter owns the `networkClient.request()` call and error handling;
the codec owns the surface-specific shape.

## Registry wiring (core)

- `src/llm/surface-codec-registry.ts`: process-wide `register` / `find` /
  `list` / `clear`. Last registration wins per `surfaceId`.
- `ProviderSetupContext` gains `surfaceCodecs?: SurfaceCodecRegistry`.
  `buildProviderSetupContext()` in `src/llm/provider-discovery.ts` populates it,
  so every activated provider plugin receives it in `register(ctx)`.

## OpenAI codec (first slice)

`ma-llm-openai-plugin/surface-codecs.ts` exports `openAIChatCompletionsCodec`
for `openai-chat-completions`. It reuses the plugin's existing wire helpers
(`buildOpenAIChatBody`, `buildOpenAIHeaders`, `translateOpenAIChatStream`,
`validateOpenAIRequest`) so there is one wire implementation, not two.
`bootstrapOpenAI` registers it via `ctx.surfaceCodecs?.register(...)`.

`openai-responses` and `anthropic-messages` are intentionally deferred until the
chat path is proven. Anthropic in particular has beta flags, preflight, media
limits, and plan/OAuth quirks that are not obviously safe in generic mode.

## Generic endpoint plugin

`ma-llm-generic-endpoint-plugin/` (provider id `generic-endpoint`):

- `adapter.ts`: reads config, finds the codec, calls
  `codec.validate` / `codec.buildRequest` / `codec.translateStream`.
  `registerAdHocModel(modelId)` registers any model with the codec's default
  capabilities + pricing and `vendorIds.firstParty = providerModel ?? modelId`.
- `config.ts`: reads endpoint/format/provider-model from env, and normalizes the
  endpoint (accepts a base URL or a full path; appends `defaultPath` unless the
  URL already ends with it).

## CLI / env / config

New flags (precedence: CLI > env > config):

| Flag | Env | Config | Meaning |
| --- | --- | --- | --- |
| `--endpoint` | `MINIMAL_AGENT_ENDPOINT` | `endpoint` | base URL or full path |
| `--format` / `--surface` | `MINIMAL_AGENT_FORMAT` / `MINIMAL_AGENT_SURFACE` | `format` | registered surface id |
| `--auth-type` | `MINIMAL_AGENT_AUTH_TYPE` | `authType` | `api-key` \| `bearer` \| `none` \| `custom-header` |
| `--api-key` | `MINIMAL_AGENT_API_KEY` | `apiKey` | key/token |
| `--auth-header` | `MINIMAL_AGENT_AUTH_HEADER` | `authHeader` | header name for `custom-header` |
| `--provider-model` | `MINIMAL_AGENT_PROVIDER_MODEL` | `providerModel` | wire model id, separate from local `--model` |
| `--effort-levels` | `MINIMAL_AGENT_EFFORT_LEVELS` | `effortLevels` | comma-separated effort ladder the ad-hoc model advertises |

### Effort with a generic model

A generic ad-hoc model inherits the codec's default capabilities (the OpenAI
chat codec's are GPT-4o-shaped, which declares **no** reasoning levels), so
`--effort high` is rejected at startup with "unsupported capabilities: effort".
Declare a ladder with `--effort-levels "low,medium,high"` and the ad-hoc model
advertises it, so `--effort <level>` passes validation and rides onto the wire
as `reasoning_effort`. Effort is pass-through: the client does not police the
values, the server does. Whether the field helps depends on the backend (some
local runtimes ignore or reject `reasoning_effort`).

Launch example:

```
ma --provider generic-endpoint \
   --model local-model \
   --format openai-chat-completions \
   --endpoint http://localhost:1234/v1/chat/completions \
   --auth-type none
```

## Two gotchas found against a live local server (MLX / Qwen)

Debugging a real endpoint (`http://192.168.1.40:8000`, an MLX server) surfaced
two bugs that would hit any local runtime (LM Studio, vLLM, MLX):

1. **Non-standard stream chunks crashed the translator.** The MLX server opens
   the stream with a `keepalive` primer chunk and sends usage chunks that omit
   the `choices` field. `translateOpenAIChatStream` did `chunk.choices.length`
   unconditionally and threw `undefined is not an object`, killing the stream so
   the agent saw no events and tripped the 30s idle watchdog (`stream_idle`).
   Fixed in `plugin-api/src/llm/openai-chat.ts` (and the six vendored
   `lib/openai-chat.ts` copies: openai, opencode, wafer, huggingface, openrouter,
   generic-endpoint): `const choices = chunk.choices ?? []`, and
   `OpenAIChatChunk.choices` is now optional. This hardens every
   OpenAI-compatible gateway, not just generic-endpoint.

2. **HTTP/2 hangs against a plaintext HTTP/1.1 server.** The default transport
   connects with h2c prior-knowledge, which a plain `http://` HTTP/1.1 server
   never answers, so the socket hangs (curl works because it uses HTTP/1.1). The
   network client now **auto-routes cleartext `http://` to an HTTP/1.1 fetch
   transport** (`NetworkClient.plaintextHttpTransport`, wired in
   `createDefaultNetworkClient`). `https://` is untouched, and an explicit
   `req.protocol` pin still wins. Opt out with
   `MINIMAL_AGENT_NO_PLAINTEXT_HTTP1=1` (an h2c-capable local server you want
   over HTTP/2). `MINIMAL_AGENT_TRANSPORT=fetch` also works as a blunt override.

So the launch above now works with the **default transport, no env var**.

## Auth plumbing

`ProviderAuth` already had a `custom` header-bag variant, but the legacy
`AuthResult` could not carry it: `providerAuthToAuthResult` threw on `custom`,
and the legacy bridge only mapped bearer/api-key. Fixed by:

- `AuthResult` is now a union: `TokenAuthResult` (the old shape) plus
  `ProviderNativeAuthResult` (`{ type: "provider", auth: ProviderAuth }`).
- `resolveStartupAuth` short-circuits `generic-endpoint`, building a
  `ProviderAuth` from `--auth-type` (`none` → empty custom headers; `bearer` /
  `api-key` → api-key auth; `custom-header` → a `{ [header]: key }` bag).
- `legacyAuthToProviderAuth` and `canonical-send`'s `resolveProviderAuth` pass a
  `provider`-typed `AuthResult` straight through as its `ProviderAuth`.

Because generic-endpoint auth comes entirely from flags, startup does NOT
require stored credentials for it (unlike first-party providers).

## Model resolution note

`resolveStartupProviderState` now uses `findModelForProvider(base, providerId)`
instead of the global `findModel`, so the ad-hoc registration and the
"unknown model" guard are scoped to the selected provider. Two providers can
register the same bare model id (e.g. `local-model`) without colliding.

## Tests

- `src/llm/surface-codec-registry.test.ts`: register/find/list/clear,
  last-write-wins.
- `src/llm/provider-discovery.test.ts`: activation threads a codec registrar and
  plugins register codecs through it.
- `src/cli/parse-argv.test.ts`: flag/env/config precedence for the new flags.
- `src/host/startup/provider-auth.generic.test.ts`: every auth mode + error case.
- `ma-llm-openai-plugin/surface-codecs.test.ts`: codec body parity with
  `buildOpenAIChatBody`, SSE fixture translation, error classification.
- `ma-llm-generic-endpoint-plugin/generic-endpoint.test.ts`: endpoint
  normalization, config reading, ad-hoc model registration, adapter delegation
  against a mock codec + mock network client, unknown-format error.

## Not done / follow-ups

- Only `openai-chat-completions` is exposed. Add `openai-responses` and
  `anthropic-messages` codecs when needed.
- No live smoke test in CI (would need a running LM Studio / vLLM). The mock
  network-client integration test covers the delegation path offline.
- `provider.json` for the new plugin lives in the sibling
  `minimal-agent-plugins` repo; it is discovered at boot like any other provider.
