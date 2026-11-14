/**
 * A warning sink over a diagnostics handle (S11.1c dual-write).
 *
 * @module plugins/loader/warn-sink
 */

import { Severity } from "../../bus/diagnostic-bus.ts"
import type { Diagnostics } from "../../diagnostics/hub.ts"
import { emitTyped, type TypedAttrs } from "../../diagnostics/typed.ts"

/**
 * A warning sink over `diagnostics`. With attrs it dual-writes (message plus
 * typed attrs, same severity). Without attrs it is a plain warning.
 */
export function warnSink(
  diagnostics: Diagnostics,
  source: string,
): (msg: string, attrs?: TypedAttrs) => void {
  return (msg, attrs) =>
    attrs
      ? emitTyped(diagnostics, Severity.Warning, source, msg, attrs)
      : diagnostics.warn(source, msg)
}
