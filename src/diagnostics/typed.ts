/**
 * Typed diagnostic emit (S14.2, dual-write). The event carries the OLD message
 * text AND `diagnostic.attrs`. Sinks that read `message` stay unchanged.
 * No `structuredData` is set, so sinks that print it add nothing.
 *
 * @module diagnostics/typed
 */

import { buildDiagnostic, Facility, type Severity } from "../bus/diagnostic-bus.ts"

import type { Diagnostics } from "./hub.ts"

/** Attribute values a typed diagnostic may carry. */
export type TypedAttrs = Readonly<Record<string, string | number | boolean | null>>

/** Emit a diagnostic with its message text and typed attrs. */
export function emitTyped(
  diagnostics: Diagnostics,
  severity: Severity,
  source: string,
  message: string,
  attrs: TypedAttrs,
): void {
  diagnostics.emit({
    ts: Date.now(),
    severity,
    facility: Facility.User,
    source,
    message,
    diagnostic: { ...buildDiagnostic(severity, source), attrs: { ...attrs } },
  })
}
