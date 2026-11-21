/**
 * Render of a core kind (design step 6). Core emitters (`raw-output`,
 * `policy`, `diagnostics`, `wrap-up`, hook context, session context, the
 * turn-stop note) use {@link renderCoreKind}, not `render`.
 *
 * The API rule stays: with a codec, `render` of an unknown kind throws
 * `SidebandKindUnknownError` (a plugin programming error). But a core
 * emitter must not break a turn when the plugin that declares its kind is
 * not loaded (a codec plugin without the owner plugin). Then the helper
 * gives `""` (the same result as no codec) and emits one
 * `sideband.core-kind-missing` warning for each kind and diagnostics sink.
 *
 * Content rule: a core emitter whose message has a body (a plugin note, a
 * plugin prompt section, a host note) uses {@link renderCoreBody}. When the
 * tag cannot be rendered (no codec, or the kind is not declared), it gives
 * the body text with no wrapper, so the plugin content still reaches the
 * model. Only a tag with no body (attrs only) gives `""`.
 *
 * @packageDocumentation
 */

import { type SidebandApiDiagnostics, sidebandDiagnosticsOf } from "./api.ts"
import { SidebandKindUnknownError } from "./errors.ts"
import type { SidebandApi, SidebandMessage } from "./types.ts"

/** Diagnostic source of a core kind that no loaded plugin declares. */
export const SIDEBAND_CORE_KIND_MISSING = "sideband.core-kind-missing"

/** The kinds already reported, for each diagnostics sink. */
const REPORTED = new WeakMap<SidebandApiDiagnostics, Set<string>>()

/**
 * `sb.render(kind, msg)`, or `""` when `sb` has a codec but no declaration
 * of `kind`. Then `diagnostics` gets one `sideband.core-kind-missing`
 * warning (data `{ kind }`) for each kind. Other errors pass. Without
 * `diagnostics`, the target is the one that `sb` was built with
 * (`createSidebandApi` option), so the emitters need no extra argument.
 *
 * @param sb - The sideband API (only `render` is used).
 * @param kind - The core kind.
 * @param msg - The message (attrs, body).
 * @param diagnostics - Target of the warning. Default: the target of `sb`.
 *   With neither, no warning.
 * @returns The rendered text, or `""`.
 */
export function renderCoreKind(
  sb: Pick<SidebandApi, "render">,
  kind: string,
  msg: Omit<SidebandMessage, "kind"> = {},
  diagnostics?: SidebandApiDiagnostics,
): string {
  try {
    return sb.render(kind, msg)
  } catch (e) {
    if (!(e instanceof SidebandKindUnknownError) || e.sidebandKind !== kind) throw e
    const sink = diagnostics ?? sidebandDiagnosticsOf(sb)
    if (sink) {
      let seen = REPORTED.get(sink)
      if (seen === undefined) {
        seen = new Set()
        REPORTED.set(sink, seen)
      }
      if (!seen.has(kind)) {
        seen.add(kind)
        sink.warn(SIDEBAND_CORE_KIND_MISSING, "", { kind })
      }
    }
    return ""
  }
}

/**
 * {@link renderCoreKind} for a message with a body. With a codec and a
 * declared kind: the same bytes. With no codec, or no declaration of
 * `kind`: the body text unchanged, with no wrapper and no other format
 * (the plugin content stays; the warning of {@link renderCoreKind} or of
 * the API is emitted one time for each kind). A body that is absent or
 * `""` gives `""` there.
 *
 * @param sb - The sideband API (only `render` is used).
 * @param kind - The core kind.
 * @param msg - The message (attrs, body).
 * @param diagnostics - Target of the warning. Default: the target of `sb`.
 * @returns The rendered text, the body with no wrapper, or `""`.
 */
export function renderCoreBody(
  sb: Pick<SidebandApi, "render">,
  kind: string,
  msg: Omit<SidebandMessage, "kind"> = {},
  diagnostics?: SidebandApiDiagnostics,
): string {
  const text = renderCoreKind(sb, kind, msg, diagnostics)
  return text !== "" ? text : (msg.body ?? "")
}
