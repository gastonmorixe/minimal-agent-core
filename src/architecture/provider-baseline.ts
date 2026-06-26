/**
 * Provider-token scanner exemptions and frozen legacy baseline.
 *
 * This file is the one allowed place in `src/architecture/` where the scanner
 * names provider-specific tokens as data. The architecture test imports this
 * module so the ratchet baseline is centralized and reviewed.
 *
 * @module architecture/provider-baseline
 */

/**
 * Files allowed to name provider tokens because they implement or test the
 * scanner itself.
 */
export const PROVIDER_SCAN_EXEMPT: ReadonlySet<string> = new Set([
  "architecture.provider-decoupling.test.ts",
  "architecture/provider-baseline.ts",
  "architecture/provider-scan.ts",
  "architecture.plugin-decoupling.test.ts",
  // Import-scan tests use plugin paths (`plugins/llm-anthropic/...`) as
  // fixture specifiers — same category, same exemption.
  "architecture/core-plugin-import-scan.test.ts",
  // The provider-scan unit test feeds synthetic token-bearing sources
  // through the regex — it must name the tokens.
  "architecture/provider-scan.test.ts",
])

/**
 * Frozen legacy violations. Dissolution waves shrink this list to empty;
 * every removal is a reviewed edit here. DO NOT ADD ENTRIES — new provider
 * code goes in the provider's plugin.
 */
export const LEGACY_PROVIDER_TOKEN_BASELINE: ReadonlySet<string> = new Set([
  // The legacy Anthropic wire module + its direct tests.
  "headers.ts",
  "headers.test.ts",
  "headers.characterization.test.ts",
  // Legacy Anthropic client stack.
  "client.ts",
  "client.test.ts",
  // Fragments of client.test.ts produced by the max-lines<=800 split
  // (2026-06-10). NOT new coupling: renamed pieces of the frozen entry
  // above; they dissolve with the same Wave-4 stack.
  "client.errors.test.ts",
  "client.quota.test.ts",
  "client.streaming.test.ts",
  "client.max-tokens-salvage.test.ts",
  "client.stream-watchdog.test.ts",
  "client.text-stop.test.ts",
  "client.transport-contract.test.ts",
  "client/debug.ts",
  "client/list-models.ts",
  "client/quota.ts",
  // OAuth/identity for claude.ai plan auth (dissolves with the stack).
  "auth.ts",
  "auth.test.ts",
  // B-3 (login cluster): auth-store.ts, auth-store.test.ts, oauth-login.test.ts,
  // and commands/login.ts were ratcheted OUT. They are the provider-NEUTRAL
  // credential vault, PKCE engine tests, and CLI login plumbing (the Anthropic
  // login specifics already live in plugins/llm-anthropic/oauth-login.ts). Their
  // only coupling was incidental provider-token STRINGS (example slugs/names, a
  // callback-URL test fixture, a CLI banner), now neutralized to generic
  // placeholders. auth.ts itself STAYS pending B-6.
  // Anthropic rate tables + registry vendor-extension keys pending
  // extraction to the plugin.
  "llm/model-registry.ts",
  "llm/provider.ts",
  // Neutral seams still carrying provider defaults/heuristics in code.
  // (llm/transport/select-transport.ts ratcheted OUT at the B-0 flip: the
  // canonical-default routing needs no provider comparison in code.)
  "llm/adapter-legacy.ts",
  // (llm/canonical-request.ts ratcheted OUT when the type surface MOVED to
  // `@minimal-agent/plugin-api/llm/canonical-request` (Wave C-3): the src/ file
  // is now a one-line re-export shim with zero provider tokens in code. The
  // example slugs in the original doc comments rode along to the leaf package,
  // which the provider-scan does not cover.)
  "llm/transport/canonical-send.ts",
  // (agent.ts + index.ts ratcheted OUT in Wave C C-1/C-2: agent.ts's default
  // model now comes from the registry default (`getDefaultModelId`), and
  // index.ts's startup-banner decisions (sign-in label, reasoning rows, quota
  // gate) read provider-supplied data + capability flags via
  // src/startup/provider-presentation.ts — no provider literal in code.)
  // Tests of all of the above (fixtures use real model ids/headers).
  // A-4 (Wave A) cleaned agent.preflight, agent.turn-attachments, and
  // agent/preflight-pipeline tests to neutral fakes (removed below).
  // agent.canonical-dispatch stays: it still names "openai"/"anthropic" as
  // DATA (resolveProviderAuth keys credentials by provider id until C-5; the
  // legacy-fallback assertion targets api.anthropic.com until the legacy
  // stack leaves core in B-5).
  "agent.canonical-dispatch.test.ts",
  "agent.max-tokens-budget.test.ts",
  "agent.read-media.test.ts",
  "agent.thinking-display.test.ts",
  "cache.test.ts",
  "cli-args.test.ts",
  "commands/sessions.test.ts",
  "config.test.ts",
  "dump-command.e2e.test.ts",
  "e2e-smoke.test.ts",
  "jsonc.test.ts",
  "llm/adapter-legacy-media.test.ts",
  "llm/adapter-legacy-salvage.test.ts",
  "llm/adapter-legacy-usage.test.ts",
  "llm/model-info.test.ts",
  "llm/model-label.test.ts",
  "llm/provider-discovery.test.ts",
  "llm/transport/auth-refresh.test.ts",
  "llm/transport/canonical-send.test.ts",
  "llm/transport/retry.test.ts",
  "llm/transport/select-transport.test.ts",
  "llm/transport/watchdog.test.ts",
  "net-dbg.test.ts",
  "network/network.test.ts",
  "network/activity-observer.test.ts",
  "network/http3-transport.test.ts",
  "network/transient-error.test.ts",
  "non-interactive-defaults.test.ts",
  "plugins/agent-context.test.ts",
  "session-replay.test.ts",
  "session-restore.test.ts",
  "session-store.test.ts",
  "session-usage.test.ts",
  "ui/choice-modal.test.ts",
  "ui/compositor.test.ts",
])
