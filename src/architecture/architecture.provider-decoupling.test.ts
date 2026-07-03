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
 * THE RATCHET: `LEGACY_PROVIDER_TOKEN_BASELINE` is the frozen list of files
 * that already violated the rule when this test landed (dominated by the
 * legacy Anthropic client stack awaiting Wave-4 dissolution — see
 * docs/changes/2026-06-09-fable-5-hardening-and-headers-decoupling.md).
 * The assertion is exact-set equality, so BOTH directions fail fast:
 *
 *   - A file NOT in the baseline gains a provider token → FAIL: move the
 *     code to plugins/<provider>/. New leaks die in one test run, caught
 *     by any agent, with zero archaeology.
 *   - A baseline file gets cleaned → FAIL: delete it from the baseline.
 *     The list only shrinks; cleanups can never silently regress.
 *
 * Fast check:
 *
 *   bun test src/architecture.provider-decoupling.test.ts
 *
 * Scanner internals live in `src/architecture/provider-scan.ts` so tooling
 * can reuse them. To regenerate the violation set after intentional moves:
 *
 *   bun -e 'import("./src/architecture/provider-scan.ts").then(m =\>
 *     console.log(JSON.stringify(m.scanProviderTokenViolations("src",
 *       new Set(["architecture.provider-decoupling.test.ts",
 *                "architecture/provider-scan.ts"])), null, 2)))'
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { LEGACY_PROVIDER_TOKEN_BASELINE, PROVIDER_SCAN_EXEMPT } from "./provider-baseline.ts"
import { PROVIDER_NAME_RE, scanProviderTokenViolations, tsFilesUnder } from "./provider-scan.ts"

const SRC_ROOT = join(import.meta.dirname, "..")

function providerTokenViolations(): string[] {
  return scanProviderTokenViolations(SRC_ROOT, PROVIDER_SCAN_EXEMPT)
}

describe("architecture: provider decoupling", () => {
  it("no provider names in src/ file or directory names", () => {
    const offenders = tsFilesUnder(SRC_ROOT).filter(
      (f) => !PROVIDER_SCAN_EXEMPT.has(f) && PROVIDER_NAME_RE.test(f),
    )
    expect(
      offenders,
      `Provider-named files belong under plugins/<provider>/, never src/: ${offenders.join(", ")}`,
    ).toEqual([])
  })

  it("provider tokens appear in core CODE only inside the frozen legacy baseline (ratchet)", () => {
    const violations = new Set(providerTokenViolations())

    const newLeaks = [...violations].filter((f) => !LEGACY_PROVIDER_TOKEN_BASELINE.has(f)).sort()
    const cleaned = [...LEGACY_PROVIDER_TOKEN_BASELINE].filter((f) => !violations.has(f)).sort()

    expect(
      newLeaks,
      `NEW provider coupling in core. Provider logic/ids/hosts belong in plugins/<provider>/ ` +
        `(comments may reference providers; code must not). Move the code, do NOT extend the ` +
        `baseline: ${newLeaks.join(", ")}`,
    ).toEqual([])

    expect(
      cleaned,
      `These files no longer contain provider tokens — ratchet down: remove them from ` +
        `LEGACY_PROVIDER_TOKEN_BASELINE so the cleanup can never regress: ${cleaned.join(", ")}`,
    ).toEqual([])
  })
})
