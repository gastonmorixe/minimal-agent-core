/**
 * Provider-neutral error hierarchy — `src/` surface.
 *
 * Wave D-2 split: the pure error classes (`ProviderError`,
 * `CapabilityViolation`, the streaming errors, `AuthError`) and the two
 * classifiers (`categorizeError`, `classifyUpstreamError` +
 * `StreamErrorCategory`) MOVED to the leaf contract package
 * `@minimal-agent/plugin-api/llm/errors` (provider-neutral, no host state), so
 * a plugin can depend on the error contract without reaching into `src/`. This
 * module re-exports them so the old `src/llm/errors.ts` import path stays the
 * single surface for core (and any not-yet-swept plugin).
 *
 * `UnsupportedCapabilityError` STAYS here: it carries a
 * `degrade?: CanonicalRequest`, and `canonical-request.ts` has not moved into
 * the package yet (it is a frozen I1 baseline member, relocating in Wave C-3).
 * Moving the class would force the leaf package to depend on
 * `canonical-request`, which it must not. Once C-3 lands, this class can move
 * too and the shim collapses.
 *
 * @module llm/errors
 */

import { type CapabilityViolation, ProviderError } from "@minimal-agent/plugin-api/llm/errors"

import type { CanonicalRequest } from "./canonical-request.ts"

export * from "@minimal-agent/plugin-api/llm/errors"

/**
 * Aggregate raised when `ProviderAdapter.validate` returns a non-empty
 * error list and the caller didn't opt in to a degraded fallback.
 */
export class UnsupportedCapabilityError extends ProviderError {
  constructor(
    public readonly violations: CapabilityViolation[],
    /** Suggested degrade the adapter could send instead, if known. */
    public readonly degrade?: CanonicalRequest,
  ) {
    super(
      `request requires unsupported capabilities: ${violations.map((v) => v.capability).join(", ")}`,
      "_canonical",
      { retryable: false },
    )
    this.name = "UnsupportedCapabilityError"
  }
}
