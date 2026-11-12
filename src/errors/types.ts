/**
 * Shared types of the core errors module. Types only, no runtime value.
 *
 * @module errors/types
 */

import type { CoreError } from "./core-error.ts"

/** A value that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue }

/** The `cause` of a foreign (non-`CoreError`) throw. Carries no message. */
export interface ForeignErrorJson {
  kind: "ForeignError"
  code?: string
  errno?: number
}

/** JSON form of a `CoreError`. This is what crosses every process boundary. */
export interface CoreErrorJson {
  kind: string
  fields: Readonly<Record<string, JsonValue>>
  cause?: CoreErrorJson | ForeignErrorJson
}

/** Renders `CoreErrorJson` to text for the kinds it covers. Hosts and plugins own the text. */
export interface ErrorRenderer {
  /** Kinds this renderer covers, or `"*"` for every kind. */
  kinds: readonly string[] | "*"
  /** Return the text, or `undefined` to decline. */
  render(err: CoreErrorJson, locale?: string): string | undefined
}

/** Holds renderers. Holds no text itself. */
export interface ErrorRendererRegistry {
  /** Add a renderer. `ownerId` `"host"` marks the host. Any other id is a plugin. */
  register(r: ErrorRenderer, ownerId: string): void
  /** Render a live error or its JSON. Return `undefined` when no renderer covers the kind. */
  render(err: CoreError | CoreErrorJson, locale?: string): string | undefined
}
