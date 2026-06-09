/**
 * Architecture fitness function: provider-specific code stays OUT of core.
 *
 * THE RULE (Gaston, 2026-06-09): provider-specific logic, files, constants,
 * model ids, and wire details belong in that provider's plugin
 * (`plugins/llm-anthropic/`, `plugins/llm-openai/`, ...), never in `src/`.
 * Core defines neutral seams (model registry, capabilities, canonical
 * request/events, transport selection, `ProviderAdapter` hooks); plugins
 * fill them (DIP). Comments MAY reference providers (pointing at plugins
 * is fine); CODE — identifiers and string literals, where model ids and
 * API hosts live — may not.
 *
 * THE RATCHET: `LEGACY_VIOLATION_BASELINE` is the frozen list of files that
 * already violated the rule when this test landed (dominated by the legacy
 * Anthropic client stack awaiting Wave-4 dissolution — see
 * docs/changes/2026-06-09-fable-5-hardening-and-headers-decoupling.md).
 * The assertion is exact-set equality, so BOTH directions fail fast:
 *
 *   - A file NOT in the baseline gains a provider token → FAIL: move the
 *     code to plugins/<provider>/. New leaks die in one test run, caught
 *     by any agent, with zero archaeology.
 *   - A baseline file gets cleaned → FAIL: delete it from the baseline.
 *     The list only shrinks; cleanups can never silently regress.
 *
 * Scanner internals live in `src/architecture/provider-scan.ts` so tooling
 * can reuse them. To regenerate the violation set after intentional moves:
 *
 *   bun -e 'import("./src/architecture/provider-scan.ts").then(m =>
 *     console.log(JSON.stringify(m.scanProviderTokenViolations("src",
 *       new Set(["architecture.provider-decoupling.test.ts",
 *                "architecture/provider-scan.ts"])), null, 2)))'
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  PROVIDER_NAME_RE,
  scanProviderTokenViolations,
  tsFilesUnder,
} from "./architecture/provider-scan.ts"

const SRC_ROOT = join(import.meta.dirname)
/** This test + the scanner must name the tokens; both are exempt. */
const EXEMPT: ReadonlySet<string> = new Set([
  "architecture.provider-decoupling.test.ts",
  "architecture/provider-scan.ts",
])

/**
 * Frozen legacy violations. Dissolution waves shrink this list to empty;
 * every removal is a reviewed edit here. DO NOT ADD ENTRIES — new provider
 * code goes in the provider's plugin.
 */
const LEGACY_VIOLATION_BASELINE: ReadonlySet<string> = new Set([
  // The legacy Anthropic wire module + its direct tests.
  "headers.ts",
  "headers.test.ts",
  "headers.characterization.test.ts",
  // Legacy Anthropic client stack.
  "client.ts",
  "client.test.ts",
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
  "auth-store.ts",
  "auth-store.test.ts",
  "metadata.ts",
  "metadata.test.ts",
  "oauth-login.ts",
  "oauth-login.test.ts",
  "commands/login.ts",
  // Anthropic rate tables + registry vendor-extension keys pending
  // extraction to the plugin.
  "llm/model-registry.ts",
  "llm/provider.ts",
  // Neutral seams still carrying provider defaults/heuristics in code.
  "llm/adapter-legacy.ts",
  "llm/canonical-request.ts",
  "llm/transport/select-transport.ts",
  "llm/transport/canonical-send.ts",
  "media/ingest.ts", // deprecated buildAnthropicUserContent alias (one release)
  // Agent/UI layers still branching on legacy client specifics.
  "agent.ts",
  "index.ts",
  // Tests of all of the above (fixtures use real model ids/headers).
  "agent.canonical-dispatch.test.ts",
  "agent.max-tokens-budget.test.ts",
  "agent.preflight.test.ts",
  "agent.read-media.test.ts",
  "agent.thinking-display.test.ts",
  "agent.turn-attachments.test.ts",
  "agent/preflight-pipeline.test.ts",
  "cache.test.ts",
  "cli-args.test.ts",
  "commands/sessions.test.ts",
  "config.test.ts",
  "dump-command.e2e.test.ts",
  "e2e-smoke.test.ts",
  "jsonc.test.ts",
  "llm/errors.test.ts",
  "llm/adapter-legacy-media.test.ts",
  "llm/adapter-legacy-salvage.test.ts",
  "llm/adapter-legacy-usage.test.ts",
  "llm/llm.test.ts",
  "llm/model-info.test.ts",
  "llm/model-label.test.ts",
  "llm/provider-discovery.test.ts",
  "llm/provider-session.test.ts",
  "llm/system-prompt.test.ts",
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
  "plugins/loader.test.ts",
  "session-replay.test.ts",
  "session-restore.test.ts",
  "session-store.test.ts",
  "session-usage.test.ts",
  "status.test.ts",
  "usage-stats.test.ts",
  "ui/choice-modal.test.ts",
  "ui/compositor.test.ts",
  "usage-render.test.ts",
])

describe("architecture: provider decoupling", () => {
  it("no provider names in src/ file or directory names", () => {
    const offenders = tsFilesUnder(SRC_ROOT).filter(
      (f) => !EXEMPT.has(f) && PROVIDER_NAME_RE.test(f),
    )
    expect(
      offenders,
      `Provider-named files belong under plugins/<provider>/, never src/: ${offenders.join(", ")}`,
    ).toEqual([])
  })

  it("provider tokens appear in core CODE only inside the frozen legacy baseline (ratchet)", () => {
    const violations = new Set(scanProviderTokenViolations(SRC_ROOT, EXEMPT))

    const newLeaks = [...violations].filter((f) => !LEGACY_VIOLATION_BASELINE.has(f)).sort()
    const cleaned = [...LEGACY_VIOLATION_BASELINE].filter((f) => !violations.has(f)).sort()

    expect(
      newLeaks,
      `NEW provider coupling in core. Provider logic/ids/hosts belong in plugins/<provider>/ ` +
        `(comments may reference providers; code must not). Move the code, do NOT extend the ` +
        `baseline: ${newLeaks.join(", ")}`,
    ).toEqual([])

    expect(
      cleaned,
      `These files no longer contain provider tokens — ratchet down: remove them from ` +
        `LEGACY_VIOLATION_BASELINE so the cleanup can never regress: ${cleaned.join(", ")}`,
    ).toEqual([])
  })
})
