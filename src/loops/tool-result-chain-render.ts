/**
 * Text codec step of owner rule 5 (SPEC D4, erratum E8). Core computes the
 * `text` of a plugin annotation of a registered kind. This leaf module holds
 * the codec types and the call. It is split from `tool-result-chain.ts` to
 * keep that file under the line limit.
 *
 * @module loops/tool-result-chain-render
 */

import { SidebandCodecMissingError, SidebandKindUnknownError } from "../sideband/errors.ts"
import type { SidebandCodec, SidebandKind } from "../sideband/types.ts"

/** Why core could not render the text of an annotation (a fixed set). */
export type RenderCause = "throw" | "non-string" | "no-codec"

/** The message that core gives to {@link TextRenderer.render}. It has no `kind` key. */
export interface RenderMessage {
  /** Attribute values. */
  readonly attrs?: Readonly<Record<string, string | number | boolean>>
  /** Body text. */
  readonly body?: string
}

/**
 * The text codec that owner rule 5 uses. {@link createTextRenderer} builds it
 * from the sideband registry codec. Both methods must be pure and must not mutate
 * their input. `neutralize` must be idempotent.
 */
export interface TextRenderer {
  /**
   * Render one message. `kind` is the first argument. `msg` has only the
   * keys `attrs` and `body`, both frozen copies. Must return a string.
   */
  render(kind: string, msg: RenderMessage): string
  /** Defang each harness sigil in untrusted text. Idempotent. */
  neutralize(text: string): string
}

/**
 * Compute the rendered text of one new plugin annotation. Never throws.
 * `body` goes through `neutralize`, then `render` gets `(kind, {attrs, body})`
 * with frozen copies and no `kind` key. The result must be a string. A
 * thenable result gets a no-op rejection handler, so an async codec that
 * rejects gives no unhandled rejection.
 *
 * @param codec - The codec, or undefined when core has none.
 * @param kind - The registered kind.
 * @param attrs - The annotation attrs (flat), if any.
 * @param body - The annotation body, if any.
 * @returns The text, or the fixed cause of the failure.
 */
export function renderText(
  codec: TextRenderer | undefined,
  kind: string,
  attrs: Readonly<Record<string, string | number | boolean>> | undefined,
  body: string | undefined,
): { text: string } | { cause: RenderCause } {
  try {
    if (codec === undefined) throw new SidebandCodecMissingError()
    const msg: RenderMessage = Object.freeze({
      ...(attrs && { attrs: Object.freeze({ ...attrs }) }),
      ...(body !== undefined && { body: codec.neutralize(body) }),
    })
    const text: unknown = codec.render(kind, msg)
    if (typeof text === "string") return { text }
    // The resolve step reads `then` inside the promise, so it cannot throw here.
    void Promise.resolve(text).then(undefined, () => {})
    return { cause: "non-string" }
  } catch (e) {
    return { cause: e instanceof SidebandCodecMissingError ? "no-codec" : "throw" }
  }
}

/** The part of a sideband registry that {@link createTextRenderer} reads. */
export interface TextCodecRegistry {
  /** Find a kind by name. */
  kind(name: string): SidebandKind | undefined
  /** The lazy codec getter. Absent on a stub. The real one throws when no plugin gives a codec. */
  codec?: () => SidebandCodec
}

/**
 * Build the text codec of owner rule 5 from a sideband registry. The registry
 * must have a `codec` function, as the real registry has. A registry that has
 * only `kind` (a test stub, or a `Pick` of the read-only view) gives
 * `undefined`: there is no renderer, and core drops each annotation of a
 * registered kind. The codec is not read here. It is read at each call, because
 * the real `codec()` is lazy and throws {@link SidebandCodecMissingError} when
 * no plugin gives a codec. {@link renderText} maps that error to the cause
 * `no-codec`, and each other throw to `throw`.
 *
 * `render(kind, msg)` gets the kind object from the registry, and gives the
 * codec `(decl, { ...msg, kind })`. It throws {@link SidebandKindUnknownError}
 * for an unknown kind. `neutralize(text)` calls the neutralize of the codec.
 *
 * @param registry - The registry, or a stub with `kind` and maybe `codec`.
 * @returns The renderer, or undefined when the registry has no `codec` function.
 */
export function createTextRenderer(registry: TextCodecRegistry): TextRenderer | undefined {
  if (typeof registry.codec !== "function") return undefined
  return {
    render(kind, msg) {
      const decl = registry.kind(kind)
      if (!decl) throw new SidebandKindUnknownError(kind)
      return (registry.codec as () => SidebandCodec)().render(decl, { ...msg, kind })
    },
    neutralize(text) {
      return (registry.codec as () => SidebandCodec)().neutralize(text)
    },
  }
}
