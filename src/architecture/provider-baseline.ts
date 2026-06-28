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
  // (The legacy Anthropic wire module headers.ts + its direct tests were
  // DELETED in W3: the wire constants/billing/identity moved into
  // plugins/llm-anthropic, the neutral RequestType/SystemBlock types into
  // src/llm/transport/types.ts, and --list-flags now reads each provider's
  // listBetaFlags() hook.)
  // (The legacy Anthropic client stack — client.ts, client/{debug,list-models,
  // quota,auth-401}.ts + the client.*.test.ts files — was DELETED in the
  // provider-decoupling final wave. The default transport is now always the
  // canonical run()-backed path; conversation/transport types live in the
  // neutral src/llm/messages.ts + src/llm/transport/types.ts; the Anthropic
  // model-list GET moved into plugins/llm-anthropic/list-models.ts.)
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
  // (llm/model-registry.ts ratcheted OUT in W6d: provider-specific route
  // labels are plugin-owned `vendorIds` keys; core now stores them as opaque
  // strings and has no closed vendor-route vocabulary.)
  // (llm/adapter-legacy.ts ratcheted OUT in the provider-decoupling final wave:
  // the default-model literal now comes from getDefaultModelId(), the dead
  // canonical→legacy bridge that carried a vendor.anthropic accessor was
  // deleted, and the contextManagement-packing line was removed. The codec is
  // provider-neutral in code.)
  // (llm/canonical-request.ts ratcheted OUT when the type surface MOVED to
  // `@minimal-agent/plugin-api/llm/canonical-request` (Wave C-3): the src/ file
  // is now a one-line re-export shim with zero provider tokens in code. The
  // example slugs in the original doc comments rode along to the leaf package,
  // which the provider-scan does not cover.)
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
  "llm/transport/canonical-send.test.ts",
])
