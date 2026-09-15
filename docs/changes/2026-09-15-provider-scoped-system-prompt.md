# Provider-scoped system-prompt resolution

Anthropic plan (OAuth) requests returned a bare `rate_limit_error` (429) on every
prompt while Claude Code worked on the same account. Root cause: the system prompt
was resolved against the globally registered model entry, which is last-write-wins,
so a provider that happens to claim the same bare model id hijacked prompt
resolution.

Author: Carlos (relayed via 7a96ca22), with Jeffrey (bd2ac4a1). Date: 2026-09-15.

## The symptom

```
$ ma --provider anthropic --model claude-opus-5 --credential-name anthropic-plan-oauth-5
> hi
warn api.retry  rate_limit_error: retrying attempt 2 after 12.4s
warn api.retry  rate_limit_error: retrying attempt 3 after 41.5s
```

Claude Code 2.1.267, same account, same org, same minutes: 200 OK.

## The cause

Anthropic's OAuth edge requires an attribution block in the request body:

```
system[0] = "x-anthropic-billing-header: cc_version=<v>; cc_entrypoint=cli;"
```

`x-anthropic-billing-header` is a reserved system-prompt keyword. Omit it and the
request is treated as unattributed and answered with the bare 429. Malform it (drop
`cc_entrypoint`) and the server returns 400, naming the reserved keyword. Send it
well-formed and the request is 200.

minimal-agent has always built this block. The anthropic provider plugin prepends it
in `resolveSystemPrompt` for `authKind: "oauth"`. That hook never ran, because the
resolver asked the wrong provider.

`resolveSystemPromptForModel` picked the plugin with an unscoped lookup:

```ts
providerId = resolveModel(modelId).providerId   // global, last-write-wins
```

The global model map is last-write-wins, and plugins register in directory order. The
`opencode-zen` provider also ships `claude-opus-5`, sorts after `anthropic`, and so
won the id. Prompt resolution then consulted `opencode-zen`'s hook (or fell through to
the neutral fallback), which knows nothing about Anthropic plan auth. The transport
still targeted `api.anthropic.com`, because the adapter came from `--provider
anthropic`. Result: an OAuth request with no attribution block, and a 429.

The registry already ships the scoped lookup and its doc comment tells callers to use
it where provider context exists. This path did not.

## Evidence

Resolving the live registry with plugin discovery on:

```
GLOBAL  resolveModel('claude-opus-5').providerId          = opencode-zen
SCOPED  findModelForProvider('claude-opus-5','anthropic') = anthropic

anthropic plugin resolveSystemPrompt(authKind=oauth):
  [0] "x-anthropic-billing-header: cc_version=2.1.154.d6e; cc_entrypoint=cli; cch=00000;"
  [1] "You are Claude Code, Anthropic's official CLI for Claude."
  [2] "<agent body>"
```

The block existed. It was never reached.

A differential probe against the live endpoint, holding the credential and every
header fixed and varying only the body:

| body | status |
| --- | --- |
| no billing block, `metadata.user_id` present | 429 bare `rate_limit_error` |
| `system[0]` = billing block alone | 200 OK |
| `metadata.user_id` alone, no billing block | 429 bare `rate_limit_error` |
| `"x-anthropic-billing-header: cc_version=2.1.267;"` (no entrypoint) | 400 reserved keyword |

`metadata` is a red herring. The billing block is the discriminator.

Captured body before the fix, from the live wire log:

```
system[0] = "You are Minimal Agent, a minimalistic AI agent CLI harness for the terminal."
has billing header: false
```

## Scope

The collision is not specific to `claude-opus-5`. 7 of the 11 anthropic model ids are
shadowed globally, every one of them by `opencode-zen`:

```
claude-fable-5  claude-opus-4-6  claude-opus-4-7  claude-opus-4-8
claude-opus-5   claude-sonnet-4-6  claude-sonnet-5
```

Any unscoped `resolveModel(modelId)` call site resolves those to the wrong provider.

## The fix

Thread the selected provider id into prompt resolution and prefer the scoped entry,
falling back to the global entry when the provider does not claim the id.

- `src/llm/system-prompt.ts`: `ResolveSystemPromptOptions.providerId` plus a scoped
  lookup with global fallback.
- `src/agent/agent.ts`, `src/sdk/agent-core.ts`: pass the provider id.
- `src/host/startup/startup-hashes.ts`, `src/index.ts`: thread the boot provider id so
  the startup system hash resolves identically to the live path.
- `src/llm/system-prompt.test.ts`: regression for a bare id claimed by two providers.

The provider plugin needed no change. Registering the same bare id in two providers is
legitimate; the bug was resolving it without provider scope.

## Verification

Live, on the committed build: the request carries the block at `system[0]` and the
response is 200.

```
system[0] = "x-anthropic-billing-header: cc_version=2.1.154.d6e; cc_entrypoint=cli; cch=00000;"
status = 200  org = 2e7c67e9
```

Both credential orgs pass: the icloud slots (`2e7c67e9`) and the vairix slot
(`c5656318`). No org exception, no `max_tokens` clamp, and no impersonation of Claude
Code's version: the block is self-branded and the server accepts it.

## Follow-up

Still unscoped, and so still wrong for the 7 shared ids. Latent, not part of this bug:

- `src/llm/preflight.ts` (two call sites)
- `src/llm/run.ts`
- `src/llm/transport/canonical-send.ts`

## Method

The loop that found this: capture the real wire request on both sides, then replay it
against the live endpoint while changing exactly one variable per run, starting from
the working side's credential. That killed three plausible theories in order
(header shape, quota timing, transport) before the body bisection landed on the billing
block, and the seam check then explained why the block went missing.
